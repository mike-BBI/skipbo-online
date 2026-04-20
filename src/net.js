// PeerJS networking layer. Host-authoritative star topology.
// Host holds truth for lobby + game state, broadcasts to all clients.

import { Peer } from 'peerjs';
import { createGame, applyAction, MAX_PLAYERS, MIN_PLAYERS, resolveRules } from './engine.js';
import { cpuPlan } from './bot.js';

const ROOM_PREFIX = 'skipbo-room-v1-';
export const hostPeerId = (room) => ROOM_PREFIX + room.toUpperCase() + '-host';

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer();
    const onOpen = (pid) => { cleanup(); resolve({ peer, id: pid }); };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => { peer.off('open', onOpen); peer.off('error', onError); };
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

// ───────────────────────────── HOST ─────────────────────────────
export async function createHost({ roomCode, hostName, hostProfileId, onLobby, onState, onChat, onError }) {
  const { peer } = await openPeer(hostPeerId(roomCode));

  const HOST_ID = 'p_host';
  const conns = new Map(); // playerId -> DataConnection
  const lobby = {
    roomCode,
    hostId: HOST_ID,
    players: [{ id: HOST_ID, name: hostName, profileId: hostProfileId || null }],
    rules: { stockSize: 30, handSize: 5, maxDiscardDepth: null },
    started: false,
  };
  let game = null;
  const botControlled = new Set(); // playerIds now driven by CPU
  let botTimer = null;

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
    onState?.(game);
    for (const c of conns.values()) c.send({ type: 'state', state: game });
    scheduleBotIfNeeded();
  };

  // If the current turn belongs to a disconnected player, let the CPU
  // bot play out their turn so the game doesn't stall. Same pacing as
  // practice-mode so remaining humans can follow the moves.
  function scheduleBotIfNeeded() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (!game || game.winner) return;
    if (!botControlled.has(game.turn)) return;
    const plan = cpuPlan(game, game.turn);
    runBotActions(plan, 0);
  }
  function runBotActions(plan, i) {
    if (i >= plan.length) {
      botTimer = setTimeout(scheduleBotIfNeeded, 700);
      return;
    }
    const act = plan[i];
    const delay = act.type === 'discard' ? 1400 : 1100;
    botTimer = setTimeout(() => {
      const res = applyAction(game, game.turn, act);
      if (!res.ok) { scheduleBotIfNeeded(); return; }
      game = res.state;
      onState?.(game);
      for (const c of conns.values()) c.send({ type: 'state', state: game });
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
      handleMessage(pid, msg, conn);
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
          // Move the connection over to the original player id.
          conns.delete(pid);
          pid = seat.id;
          conns.set(pid, conn);
          botControlled.delete(seat.id);
          seat.name = cleanName;
          conn.send({ type: 'welcome', you: seat.id, lobby });
          conn.send({ type: 'state', state: game });
          broadcastLobby();
          broadcastChat({
            from: 'system', name: 'system',
            text: `${cleanName} reconnected.`, ts: Date.now(),
          });
          return;
        }
      }

      if (lobby.started) {
        conn.send({ type: 'error', message: 'Game already in progress.' });
        return;
      }
      if (lobby.players.length >= MAX_PLAYERS) {
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
      if (!game) return;
      const res = applyAction(game, pid, msg.action);
      if (!res.ok) {
        conn.send({ type: 'error', message: res.error });
        return;
      }
      game = res.state;
      broadcastState();
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
    startGame() {
      if (lobby.started) return { ok: false, error: 'Already started' };
      if (lobby.players.length < MIN_PLAYERS) return { ok: false, error: `Need ≥${MIN_PLAYERS} players` };
      const ids = lobby.players.map((p) => p.id);
      const names = Object.fromEntries(lobby.players.map((p) => [p.id, p.name]));
      try {
        game = createGame(ids, names, lobby.rules);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      lobby.started = true;
      broadcastLobby();
      broadcastState();
      return { ok: true };
    },
    submitAction(action) {
      if (!game) return { ok: false, error: 'No game' };
      const res = applyAction(game, HOST_ID, action);
      if (!res.ok) return res;
      game = res.state;
      broadcastState();
      return { ok: true };
    },
    destroy() {
      for (const c of conns.values()) c.close();
      peer.destroy();
    },
  };
}

// ───────────────────────────── CLIENT ─────────────────────────────
export async function createClient({ roomCode, name, profileId, onLobby, onState, onChat, onError, onWelcome }) {
  const { peer } = await openPeer();
  const conn = peer.connect(hostPeerId(roomCode), { reliable: true });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Could not reach host. Check the room code.')), 10000);
    conn.on('open', () => { clearTimeout(timeout); resolve(); });
    conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });

  conn.send({ type: 'hello', name, profileId });

  let myId = null;
  conn.on('data', (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'welcome') { myId = msg.you; onWelcome?.(msg.you, msg.lobby); onLobby?.(msg.lobby); }
    else if (msg.type === 'lobby') onLobby?.(msg.lobby);
    else if (msg.type === 'state') onState?.(msg.state);
    else if (msg.type === 'chat') onChat?.(msg.message);
    else if (msg.type === 'error') onError?.(msg.message);
  });
  conn.on('close', () => onError?.('Lost connection to host.'));
  conn.on('error', (err) => onError?.(err.message || String(err)));

  return {
    getMyId: () => myId,
    sendAction(action) { conn.send({ type: 'action', action }); },
    sendRename(name) {
      const clean = String(name || '').slice(0, 20).trim();
      if (clean) conn.send({ type: 'rename', name: clean });
    },
    sendChat(text) {
      const clean = String(text || '').slice(0, 500);
      if (!clean.trim()) return;
      conn.send({ type: 'chat', text: clean });
    },
    destroy() { conn.close(); peer.destroy(); },
  };
}
