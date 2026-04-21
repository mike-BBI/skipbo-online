// PeerJS networking layer. Host-authoritative star topology.
// Host holds truth for lobby + game state, broadcasts to all clients.

import { Peer } from 'peerjs';

const ROOM_PREFIX = 'skipbo-room-v1-';
export const hostPeerId = (room) => ROOM_PREFIX + room.toUpperCase() + '-host';

// How long a proposed undo stays open before auto-finalizing. Unvoted
// players count as YES on timeout.
export const UNDO_VOTE_MS = 15_000;

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ICE servers — STUN for basic NAT, plus TURN relays (Metered) so players
// on symmetric NATs (corporate / carrier-grade / mobile) can still
// connect. Without TURN, WebRTC fails for ~10–15% of network configs.
const METERED_USERNAME = '81bdfc009715a994afe717e4';
const METERED_CREDENTIAL = '+gVPSgVQkroQULoV';
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turn:global.relay.metered.ca:80',
        username: METERED_USERNAME,
        credential: METERED_CREDENTIAL,
      },
      {
        urls: 'turn:global.relay.metered.ca:80?transport=tcp',
        username: METERED_USERNAME,
        credential: METERED_CREDENTIAL,
      },
      {
        urls: 'turn:global.relay.metered.ca:443',
        username: METERED_USERNAME,
        credential: METERED_CREDENTIAL,
      },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: METERED_USERNAME,
        credential: METERED_CREDENTIAL,
      },
    ],
  },
};

// Retry budget for reclaiming a peer ID that's still held by the PeerJS
// broker after a host's previous tab went away. Broker TTL is ~60s, so
// we poll for up to that long with short gaps. Only `unavailable-id`
// errors trigger retries — hard errors (browser-incompatible, network)
// bubble up immediately.
const RECLAIM_RETRIES = 12;
const RECLAIM_DELAY_MS = 5000;

function openPeer(id, { onRetry } = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      const peer = id ? new Peer(id, PEER_CONFIG) : new Peer(PEER_CONFIG);
      const onOpen = (pid) => {
        cleanup();
        // If the peer disconnects from the signaling server later, try
        // to reconnect so new joiners can still find the host.
        peer.on('disconnected', () => {
          try { peer.reconnect(); } catch {}
        });
        resolve({ peer, id: pid });
      };
      const onError = (err) => {
        cleanup();
        const type = err?.type || '';
        if (type === 'unavailable-id' && attempts < RECLAIM_RETRIES) {
          try { peer.destroy(); } catch {}
          onRetry?.({ attempts, maxAttempts: RECLAIM_RETRIES });
          setTimeout(attempt, RECLAIM_DELAY_MS);
          return;
        }
        try { peer.destroy(); } catch {}
        reject(err);
      };
      const cleanup = () => { peer.off('open', onOpen); peer.off('error', onError); };
      peer.on('open', onOpen);
      peer.on('error', onError);
    };
    attempt();
  });
}

// ───────────────────────────── HOST ─────────────────────────────
// `gameSpec` is a game-descriptor from src/games/<id>/index.js — it
// supplies createGame, applyAction, cpuPlan, rules, and CPU pacing.
// (Named gameSpec to avoid colliding with the `game` variable below
// which holds the live engine state.)
export async function createHost({ game: gameSpec, roomCode, hostName, hostProfileId, onLobby, onState, onChat, onError, onStatus }) {
  if (!gameSpec) throw new Error('createHost requires a game descriptor');
  const { createGame, applyAction, cpuPlan, minPlayers, maxPlayers, defaultRules, botActionDelay, botBetweenTurns } = gameSpec;
  onStatus?.({ kind: 'connecting' });
  const { peer } = await openPeer(hostPeerId(roomCode), {
    onRetry: ({ attempts, maxAttempts }) => {
      onStatus?.({ kind: 'reclaiming', attempts, maxAttempts });
    },
  });
  onStatus?.({ kind: 'open', peerId: peer.id });
  peer.on('disconnected', () => onStatus?.({ kind: 'disconnected' }));
  peer.on('close', () => onStatus?.({ kind: 'closed' }));
  peer.on('error', (err) => onStatus?.({ kind: 'error', type: err.type, message: err.message || String(err) }));

  // iOS Safari suspends WebRTC when the tab is backgrounded. The
  // signaling connection often drops silently — PeerJS emits
  // `disconnected` but peer.reconnect() from openPeer only fires on
  // that explicit event, which may not trigger reliably on resume.
  // Force a health check when the tab comes back to foreground so a
  // host who just switched apps (e.g. to paste an invite link) is
  // reachable to joiners again without having to leave + recreate.
  const onHostVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (peer.destroyed) return;
    if (peer.disconnected) {
      try { peer.reconnect(); } catch {}
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onHostVisible);
  }

  const HOST_ID = 'p_host';
  const conns = new Map(); // playerId -> DataConnection
  const lobby = {
    roomCode,
    hostId: HOST_ID,
    players: [{ id: HOST_ID, name: hostName, profileId: hostProfileId || null }],
    rules: { ...defaultRules },
    started: false,
  };
  let game = null;
  const botControlled = new Set(); // playerIds now driven by CPU
  let botTimer = null;

  // Undo support: remember the pre-action state so the most recent
  // actor can propose an undo, valid until the next action is applied.
  let undoSnapshot = null; // { state, actor }
  let undoVote = null;     // { requester, voters, votes, required, deadlineAt, timer }

  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
  const undoMeta = () => ({
    undoAvailable: !!undoSnapshot,
    lastActor: undoSnapshot?.actor || null,
    undoVote: undoVote ? {
      requester: undoVote.requester,
      voters: undoVote.voters,
      votes: undoVote.votes,
      required: undoVote.required,
      deadlineAt: undoVote.deadlineAt,
    } : null,
  });

  const broadcastLobby = () => {
    // Send a fresh shallow snapshot — the host's React setState compares
    // by reference, so mutating `lobby` in place would be a no-op render.
    const snap = {
      ...lobby,
      players: lobby.players.map((p) => ({ ...p })),
      rules: { ...lobby.rules },
    };
    onLobby?.(snap);
    for (const c of conns.values()) c.send({ type: 'lobby', lobby: snap });
  };
  const broadcastState = () => {
    const payload = { ...game, ...undoMeta() };
    onState?.(payload);
    for (const c of conns.values()) c.send({ type: 'state', state: payload });
    scheduleBotIfNeeded();
  };

  function applyAndSnapshot(pid, action) {
    if (!game) return { ok: false, error: 'No game' };
    const prev = deepClone(game);
    const res = applyAction(game, pid, action);
    if (!res.ok) return res;
    game = res.state;
    undoSnapshot = { state: prev, actor: pid };
    // Any in-flight vote was for a now-superseded action.
    if (undoVote) { clearTimeout(undoVote.timer); undoVote = null; }
    return { ok: true };
  }

  function handleUndoRequest(pid) {
    if (!game || game.winner) return { ok: false, error: 'No active game.' };
    if (!undoSnapshot || undoSnapshot.actor !== pid) {
      return { ok: false, error: 'No undoable action right now.' };
    }
    if (undoVote) return { ok: false, error: 'A vote is already in progress.' };

    const voters = lobby.players.filter((p) => p.id !== pid).map((p) => p.id);
    if (voters.length === 0) {
      // Solo game — just undo immediately.
      game = undoSnapshot.state;
      undoSnapshot = null;
      broadcastState();
      return { ok: true };
    }
    const votes = {};
    // Bot-controlled seats auto-approve — they can't vote themselves.
    for (const v of voters) {
      if (botControlled.has(v)) votes[v] = true;
    }
    undoVote = {
      requester: pid,
      voters,
      votes,
      required: Math.floor(voters.length / 2) + 1,
      deadlineAt: Date.now() + UNDO_VOTE_MS,
      timer: setTimeout(() => finalizeUndoVote(), UNDO_VOTE_MS),
    };
    const requesterName = lobby.players.find((p) => p.id === pid)?.name || 'Someone';
    broadcastChat({
      from: 'system', name: 'system',
      text: `${requesterName} requested an undo. ${undoVote.required}/${voters.length} yes votes needed.`,
      ts: Date.now(),
    });
    broadcastState();
    maybeFinalizeUndoVote();
    return { ok: true };
  }

  function handleUndoVote(pid, yes) {
    if (!undoVote) return { ok: false, error: 'No active vote.' };
    if (pid === undoVote.requester) return { ok: false, error: 'Cannot vote on your own undo.' };
    if (!undoVote.voters.includes(pid)) return { ok: false, error: 'You are not in this game.' };
    if (typeof undoVote.votes[pid] === 'boolean') return { ok: false, error: 'Already voted.' };
    undoVote.votes[pid] = !!yes;
    broadcastState();
    maybeFinalizeUndoVote();
    return { ok: true };
  }

  function maybeFinalizeUndoVote() {
    if (!undoVote) return;
    const voted = Object.keys(undoVote.votes).length;
    if (voted >= undoVote.voters.length) finalizeUndoVote();
  }

  function finalizeUndoVote() {
    if (!undoVote) return;
    clearTimeout(undoVote.timer);
    // Unvoted = auto-yes per house rules.
    let yes = 0;
    for (const vid of undoVote.voters) {
      const v = undoVote.votes[vid];
      if (v === true || v === undefined) yes++;
    }
    const approved = yes >= undoVote.required;
    const requesterName = lobby.players.find((p) => p.id === undoVote.requester)?.name || 'Someone';
    if (approved && undoSnapshot) {
      game = undoSnapshot.state;
      undoSnapshot = null;
      broadcastChat({
        from: 'system', name: 'system',
        text: `${requesterName}'s undo was approved (${yes}/${undoVote.voters.length}).`,
        ts: Date.now(),
      });
    } else {
      broadcastChat({
        from: 'system', name: 'system',
        text: `${requesterName}'s undo was denied (${yes}/${undoVote.voters.length}).`,
        ts: Date.now(),
      });
    }
    undoVote = null;
    broadcastState();
  }

  // If the current turn belongs to a CPU seat (either a player added
  // as CPU in the lobby or a human who disconnected mid-game), let the
  // CPU bot play out their turn. Difficulty is read from the lobby
  // player record; dropped humans fall back to 'normal'.
  function scheduleBotIfNeeded() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (!game || game.winner) return;
    if (!botControlled.has(game.turn)) return;
    const seat = lobby.players.find((p) => p.id === game.turn);
    const difficulty = seat?.cpuDifficulty || 'normal';
    const plan = cpuPlan(game, game.turn, difficulty);
    runBotActions(plan, 0);
  }
  function runBotActions(plan, i) {
    if (i >= plan.length) {
      botTimer = setTimeout(scheduleBotIfNeeded, botBetweenTurns ?? 700);
      return;
    }
    const act = plan[i];
    const delay = botActionDelay ? botActionDelay(act) : 1200;
    botTimer = setTimeout(() => {
      const res = applyAndSnapshot(game.turn, act);
      if (!res.ok) { scheduleBotIfNeeded(); return; }
      const payload = { ...game, ...undoMeta() };
      onState?.(payload);
      for (const c of conns.values()) c.send({ type: 'state', state: payload });
      runBotActions(plan, i + 1);
    }, delay);
  }
  const broadcastChat = (msg) => {
    onChat?.(msg);
    for (const c of conns.values()) c.send({ type: 'chat', message: msg });
  };

  peer.on('connection', (conn) => {
    let pid = null;
    conn.on('open', () => {
      pid = 'p_' + conn.peer.slice(-8);
      conns.set(pid, conn);
    });
    conn.on('data', (msg) => {
      const newPid = handleMessage(pid, msg, conn);
      if (newPid && newPid !== pid) pid = newPid;
    });
    conn.on('close', () => {
      if (!pid) return;
      conns.delete(pid);
      if (!lobby.started) {
        lobby.players = lobby.players.filter((p) => p.id !== pid);
        broadcastLobby();
        return;
      }
      // Mid-game drop: hand their seat to the CPU so the game continues.
      if (game && !game.winner && !botControlled.has(pid)) {
        botControlled.add(pid);
        const dropped = lobby.players.find((p) => p.id === pid);
        broadcastChat({
          from: 'system', name: 'system',
          text: `${dropped?.name || 'A player'} disconnected — CPU is playing their turns.`,
          ts: Date.now(),
        });
        scheduleBotIfNeeded();
      }
    });
    conn.on('error', (err) => onError?.(err));
  });

  function handleMessage(pid, msg, conn) {
    if (!msg || !msg.type) return;
    if (msg.type === 'hello') {
      const cleanName = String(msg.name || 'Player').slice(0, 20).trim() || 'Player';
      const profileId = msg.profileId ? String(msg.profileId) : null;

      // Mid-game reconnect: a player with a matching profileId can
      // reclaim their seat from the bot.
      if (lobby.started && profileId) {
        const seat = lobby.players.find((p) => p.profileId === profileId);
        if (seat && botControlled.has(seat.id)) {
          // Move the connection over to the original player id. Return
          // the new pid so the connection closure updates its captured
          // value — otherwise future messages would still be handled
          // under the throwaway peer id and actions would mis-route.
          conns.delete(pid);
          conns.set(seat.id, conn);
          botControlled.delete(seat.id);
          seat.name = cleanName;
          conn.send({ type: 'welcome', you: seat.id, lobby });
          conn.send({ type: 'state', state: game });
          broadcastLobby();
          broadcastChat({
            from: 'system', name: 'system',
            text: `${cleanName} reconnected.`, ts: Date.now(),
          });
          return seat.id;
        }
      }

      if (lobby.started) {
        conn.send({ type: 'error', message: 'Game already in progress.' });
        return;
      }
      if (lobby.players.length >= maxPlayers) {
        conn.send({ type: 'error', message: 'Room is full.' });
        conn.close();
        return;
      }
      lobby.players.push({ id: pid, name: cleanName, profileId });
      conn.send({ type: 'welcome', you: pid, lobby });
      broadcastLobby();
      broadcastChat({ from: 'system', name: 'system', text: `${cleanName} joined.`, ts: Date.now() });
      return;
    }
    if (msg.type === 'chat') {
      const player = lobby.players.find((p) => p.id === pid);
      if (!player) return;
      const text = String(msg.text || '').slice(0, 500);
      if (!text.trim()) return;
      broadcastChat({ from: pid, name: player.name, text, ts: Date.now() });
      return;
    }
    if (msg.type === 'rename') {
      const player = lobby.players.find((p) => p.id === pid);
      if (!player || lobby.started) return;
      const clean = String(msg.name || '').slice(0, 20).trim();
      if (!clean) return;
      player.name = clean;
      broadcastLobby();
      return;
    }
    if (msg.type === 'action') {
      const res = applyAndSnapshot(pid, msg.action);
      if (!res.ok) {
        conn.send({ type: 'error', message: res.error });
        return;
      }
      broadcastState();
      return;
    }
    if (msg.type === 'undo-request') {
      const res = handleUndoRequest(pid);
      if (!res.ok) conn.send({ type: 'error', message: res.error });
      return;
    }
    if (msg.type === 'undo-vote') {
      const res = handleUndoVote(pid, !!msg.yes);
      if (!res.ok) conn.send({ type: 'error', message: res.error });
      return;
    }
  }

  return {
    hostId: HOST_ID,
    roomCode,
    peer,
    getLobby: () => lobby,
    getState: () => game,
    updateRules(rules) {
      lobby.rules = { ...lobby.rules, ...rules };
      broadcastLobby();
    },
    setName(name) {
      lobby.players[0].name = String(name || 'Host').slice(0, 20).trim() || 'Host';
      broadcastLobby();
    },
    sendChat(text) {
      const clean = String(text || '').slice(0, 500);
      if (!clean.trim()) return;
      broadcastChat({ from: HOST_ID, name: lobby.players[0].name, text: clean, ts: Date.now() });
    },
    addCpu(difficulty = 'normal') {
      if (lobby.started) return { ok: false, error: 'Game already started' };
      if (lobby.players.length >= maxPlayers) return { ok: false, error: 'Room is full' };
      if (!['easy', 'normal', 'hard'].includes(difficulty)) difficulty = 'normal';
      // Pick the lowest unused CPU seat number so removing mid-lobby
      // and re-adding gives a predictable "CPU 1, CPU 2, ..." ordering.
      const usedNums = new Set(
        lobby.players
          .filter((p) => p.isCpu)
          .map((p) => parseInt(p.id.replace(/^cpu_/, ''), 10))
          .filter((n) => !Number.isNaN(n)),
      );
      let n = 1;
      while (usedNums.has(n)) n++;
      const id = `cpu_${n}`;
      lobby.players.push({
        id,
        name: `CPU ${n}`,
        profileId: null,
        isCpu: true,
        cpuDifficulty: difficulty,
      });
      botControlled.add(id);
      broadcastLobby();
      return { ok: true };
    },
    removeCpu(id) {
      if (lobby.started) return { ok: false, error: 'Game already started' };
      const seat = lobby.players.find((p) => p.id === id);
      if (!seat || !seat.isCpu) return { ok: false, error: 'Not a CPU seat' };
      lobby.players = lobby.players.filter((p) => p.id !== id);
      botControlled.delete(id);
      broadcastLobby();
      return { ok: true };
    },
    setCpuDifficulty(id, difficulty) {
      if (lobby.started) return { ok: false, error: 'Cannot change difficulty mid-game' };
      if (!['easy', 'normal', 'hard'].includes(difficulty)) {
        return { ok: false, error: 'Invalid difficulty' };
      }
      const seat = lobby.players.find((p) => p.id === id);
      if (!seat || !seat.isCpu) return { ok: false, error: 'Not a CPU seat' };
      seat.cpuDifficulty = difficulty;
      broadcastLobby();
      return { ok: true };
    },
    startGame() {
      if (lobby.started) return { ok: false, error: 'Already started' };
      if (lobby.players.length < minPlayers) return { ok: false, error: `Need ≥${minPlayers} players` };
      // P2P rooms require at least one non-host human. A host-only
      // room with CPUs is just "Play vs CPU" with extra steps.
      const humans = lobby.players.filter((p) => !p.isCpu);
      if (humans.length < 2) {
        return {
          ok: false,
          error: 'Need at least one other human in the room. Use "Play vs CPU" for solo games.',
        };
      }
      const ids = lobby.players.map((p) => p.id);
      const names = Object.fromEntries(lobby.players.map((p) => [p.id, p.name]));
      try {
        game = createGame(ids, names, lobby.rules);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      // Carry each seat's profileId into the engine state so cloud
      // game records can link participants back to their cross-device
      // profile. CPU-controlled seats stay null.
      for (const lp of lobby.players) {
        if (game.players[lp.id]) game.players[lp.id].profileId = lp.profileId || null;
      }
      undoSnapshot = null;
      if (undoVote) { clearTimeout(undoVote.timer); undoVote = null; }
      lobby.started = true;
      broadcastLobby();
      broadcastState();
      return { ok: true };
    },
    submitAction(action) {
      const res = applyAndSnapshot(HOST_ID, action);
      if (!res.ok) return res;
      broadcastState();
      return { ok: true };
    },
    requestUndo() {
      return handleUndoRequest(HOST_ID);
    },
    castUndoVote(yes) {
      return handleUndoVote(HOST_ID, yes);
    },
    destroy() {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onHostVisible);
      }
      for (const c of conns.values()) c.close();
      peer.destroy();
    },
  };
}

// ───────────────────────────── CLIENT ─────────────────────────────
export async function createClient({ roomCode, name, profileId, onLobby, onState, onChat, onError, onWelcome, onStatus }) {
  let peer = null;
  let conn = null;
  let myId = null;
  let destroyed = false;
  // Reconnect guard: `connecting` is true while establish() is running,
  // either for the initial connect or a subsequent reconnect. Prevents
  // overlapping reconnect attempts when several triggers fire at once
  // (conn-close, peer-close, and visibilitychange often arrive together
  // after iOS backgrounding).
  let connecting = false;

  const onData = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'welcome') { myId = msg.you; onWelcome?.(msg.you, msg.lobby); onLobby?.(msg.lobby); }
    else if (msg.type === 'lobby') onLobby?.(msg.lobby);
    else if (msg.type === 'state') onState?.(msg.state);
    else if (msg.type === 'chat') onChat?.(msg.message);
    else if (msg.type === 'error') onError?.(msg.message);
  };

  // Establish a peer + data-connection pair. Safe to call again after a
  // drop — fully tears down the previous peer so the new one owns a
  // fresh signaling connection and WebRTC transport. Sends `hello` with
  // the stored profileId so the host's mid-game reconnect logic can
  // re-seat us from bot control.
  async function establish({ reason = 'initial' } = {}) {
    if (destroyed) return;
    if (connecting) return;
    connecting = true;
    try {
      try { conn?.close(); } catch {}
      try { peer?.destroy(); } catch {}
      conn = null;
      peer = null;

      onStatus?.({ kind: reason === 'initial' ? 'connecting' : 'reconnecting', phase: 'signaling', reason });
      const opened = await openPeer();
      peer = opened.peer;

      let lastPeerError = null;
      peer.on('disconnected', () => onStatus?.({ kind: 'disconnected' }));
      peer.on('close', () => {
        onStatus?.({ kind: 'closed' });
        if (!destroyed && !connecting) scheduleReconnect('peer-close');
      });
      peer.on('error', (err) => {
        lastPeerError = err;
        if (err?.type !== 'peer-unavailable') {
          onStatus?.({ kind: 'error', type: err.type, message: err.message || String(err) });
        }
      });

      // Retry on peer-unavailable so invite links survive brief host outages
      // (tab reload, network blip). Hard errors bail immediately. Budget is
      // ~30s total — long enough to cover the PeerJS broker's ID-release
      // TTL so a host who refreshed their tab can reclaim their code.
      const ATTEMPT_TIMEOUT_MS = 8000;
      const RETRY_DELAY_MS = 2500;
      const TOTAL_TIMEOUT_MS = 30000;
      const startedAt = Date.now();
      let attempts = 0;
      let finalErr = null;
      while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
        if (destroyed) throw new Error('destroyed');
        attempts += 1;
        if (attempts > 1) onStatus?.({ kind: 'connecting', phase: 'host', attempt: attempts });
        if (!conn || conn.open === false) {
          try { conn?.close(); } catch {}
          conn = peer.connect(hostPeerId(roomCode), { reliable: true });
        }
        try {
          await new Promise((resolve, reject) => {
            const tmo = setTimeout(() => {
              const e = new Error('attempt-timeout');
              e.type = 'timeout';
              reject(e);
            }, ATTEMPT_TIMEOUT_MS);
            const cleanup = () => {
              clearTimeout(tmo);
              conn.off('open', onOpen);
              conn.off('error', onConnErr);
            };
            const onOpen = () => { cleanup(); resolve(); };
            const onConnErr = (err) => {
              cleanup();
              const type = err?.type || '';
              let msg = err?.message || String(err);
              if (type === 'network') msg = 'Signaling server unreachable. Check your connection or try disabling privacy extensions (Guardio, NortonSafeWeb, etc.).';
              else if (type === 'browser-incompatible') msg = 'This browser does not support WebRTC.';
              const e = new Error(msg); e.type = type; reject(e);
            };
            conn.once('open', onOpen);
            conn.once('error', onConnErr);
          });
          finalErr = null;
          break;
        } catch (err) {
          finalErr = err;
          const type = err?.type || lastPeerError?.type || '';
          // Hard errors — don't retry. peer-unavailable and timeout do retry.
          if (type !== 'peer-unavailable' && type !== 'timeout') {
            try { conn.close(); } catch {}
            onStatus?.({ kind: 'error', type: type || 'error', message: err.message });
            throw err;
          }
          try { conn.close(); } catch {}
          conn = null;
          onStatus?.({ kind: 'retrying', phase: 'host', elapsed: Date.now() - startedAt, reason: type });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      if (!conn || conn.open === false) {
        const msg = 'Timed out reaching host after 30s. The host may be offline, or a privacy extension (Guardio, NortonSafeWeb) is blocking the WebRTC signaling. Try again in a moment.';
        const e = new Error(msg);
        e.type = finalErr?.type || 'connect-timeout';
        onStatus?.({ kind: 'error', type: e.type, message: msg });
        try { peer.destroy(); } catch {}
        throw e;
      }

      onStatus?.({ kind: 'open', peerId: peer.id });
      conn.send({ type: 'hello', name, profileId });

      conn.on('data', onData);
      conn.on('close', () => {
        if (destroyed) return;
        // Don't surface as an error during the brief initial-connect
        // window; schedule a reconnect attempt instead.
        scheduleReconnect('conn-close');
      });
      conn.on('error', (err) => {
        if (destroyed) return;
        // Many WebRTC errors (ICE negotiation failures after backgrounding)
        // manifest here. A close usually follows — either way, attempt
        // reconnect rather than surfacing the raw error.
        scheduleReconnect(`conn-error:${err?.type || 'unknown'}`);
      });
    } finally {
      connecting = false;
    }
  }

  let reconnectTimer = null;
  function scheduleReconnect(reason) {
    if (destroyed) return;
    if (connecting) return;
    if (reconnectTimer) return;
    onStatus?.({ kind: 'reconnecting', reason });
    // Small delay so overlapping events (conn-close + peer-close) coalesce.
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (destroyed) return;
      try {
        await establish({ reason });
      } catch (err) {
        // establish() already reported the error. Leave the caller to
        // decide whether to try again (e.g. via visibilitychange).
      }
    }, 600);
  }

  // When the tab returns to foreground, iOS Safari may have killed the
  // WebRTC transport while suspended. Health-check the conn and trigger
  // a reconnect if it's stale — avoids the user waiting for their next
  // action to fail before anything happens.
  const onVis = () => {
    if (destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const connDead = !conn || conn.open === false;
    const peerDead = !peer || peer.destroyed || peer.disconnected;
    if (connDead || peerDead) scheduleReconnect('visibility');
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis);
  }

  await establish({ reason: 'initial' });

  return {
    getMyId: () => myId,
    sendAction(action) { try { conn?.send({ type: 'action', action }); } catch {} },
    requestUndo() { try { conn?.send({ type: 'undo-request' }); } catch {} },
    castUndoVote(yes) { try { conn?.send({ type: 'undo-vote', yes: !!yes }); } catch {} },
    sendRename(newName) {
      const clean = String(newName || '').slice(0, 20).trim();
      if (clean) try { conn?.send({ type: 'rename', name: clean }); } catch {}
    },
    sendChat(text) {
      const clean = String(text || '').slice(0, 500);
      if (!clean.trim()) return;
      try { conn?.send({ type: 'chat', text: clean }); } catch {}
    },
    destroy() {
      destroyed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
      try { conn?.close(); } catch {}
      try { peer?.destroy(); } catch {}
    },
  };
}
