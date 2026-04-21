// Supabase Realtime networking — replaces PeerJS. The room row in
// Postgres is the single source of truth for lobby + game state;
// everyone subscribes via Realtime and applies their own actions
// through optimistic-concurrency UPDATEs (version-gated). Dropping
// the "host holds state" model is the whole point: a backgrounded
// phone no longer kills the room.
//
// Concurrency model
// -----------------
// Game state lives in `rooms.state` (jsonb) with `rooms.version` (int)
// bumped on every write. Any client can submit an action:
//   1. Run applyAction(state, me, action) locally (engine is pure).
//   2. UPDATE rooms SET state=new, version=version+1
//      WHERE code=? AND version=expected.
//   3. If 0 rows updated, we were stale — refetch and drop the attempt.
//   4. Supabase Realtime broadcasts the write to everyone (incl. us).
//
// Bot election
// ------------
// When a CPU seat is to act, every non-CPU client schedules the bot
// action locally, staggered by their index in playerOrder. First write
// wins the optimistic update; others harmlessly no-op when they see
// the state advance. Collapses to a single bot action even if several
// clients are online, and keeps moving if the "primary" bot runner is
// offline.
//
// Chat
// ----
// Ephemeral Realtime broadcast on the same channel — not persisted.
// Messages are fire-and-forget and echo to the sender locally.

import { supabase } from './supabase.js';

const localId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2, 10);
};

// Stable per-device id for profileless fallback. Not durable across
// browsers but fine for a single session.
function stableId(profileId) {
  if (profileId) return profileId;
  try {
    const k = 'skipbo.anonId';
    let v = localStorage.getItem(k);
    if (!v) { v = localId(); localStorage.setItem(k, v); }
    return v;
  } catch {
    return localId();
  }
}

// Reasonable cap on bot cadence — the engine supplies per-action
// delays but we also enforce a floor so a bot's "fast" action doesn't
// fly before UI has rendered the previous state.
const BOT_STAGGER_MS = 1500;

function nowIso() { return new Date().toISOString(); }

async function fetchRoom(code) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// Update room with optimistic version check. Returns the new row or
// null on version conflict. Callers retry-by-resync when null.
async function updateRoomAtomic(code, patch, expectedVersion) {
  const q = supabase.from('rooms').update({ ...patch, updated_at: nowIso() }).eq('code', code);
  const filtered = expectedVersion != null ? q.eq('version', expectedVersion) : q;
  const { data, error } = await filtered.select().maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// Shared setup for both creator and joiner — subscribes to the room
// row + broadcast channel, exposes submit helpers. `initialRow` is the
// freshly-fetched-or-upserted row state.
function attachRoom({ game, roomCode, myPlayerId, myProfileId, myName, initialRow, onLobby, onState, onChat, onStatus }) {
  let currentRow = initialRow;
  let destroyed = false;
  let botTimer = null;

  onStatus?.({ kind: 'open', peerId: myPlayerId });

  const channel = supabase
    .channel(`room:${roomCode}`, { config: { broadcast: { self: false } } })
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` },
      (payload) => {
        if (destroyed) return;
        if (payload.eventType === 'DELETE') {
          onStatus?.({ kind: 'closed' });
          return;
        }
        applyRow(payload.new);
      },
    )
    .on('broadcast', { event: 'chat' }, (payload) => {
      if (destroyed) return;
      onChat?.(payload.payload);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onStatus?.({ kind: 'open', peerId: myPlayerId });
      else if (status === 'CHANNEL_ERROR') onStatus?.({ kind: 'error', type: 'channel', message: 'Realtime channel error' });
      else if (status === 'TIMED_OUT') onStatus?.({ kind: 'disconnected' });
      else if (status === 'CLOSED') onStatus?.({ kind: 'closed' });
    });

  // Push initial state through the callbacks so the UI renders the
  // current lobby/state even before the first Realtime event arrives.
  if (currentRow) applyRow(currentRow);

  function applyRow(row) {
    currentRow = row;
    if (row.lobby) onLobby?.(row.lobby);
    if (row.state) onState?.(row.state);
    scheduleBotIfNeeded();
  }

  async function refetch() {
    try {
      const row = await fetchRoom(roomCode);
      if (row) applyRow(row);
    } catch (err) {
      onStatus?.({ kind: 'error', type: 'fetch', message: err.message || String(err) });
    }
  }

  // Lobby mutation: retry-on-conflict since pre-game writes (add CPU,
  // rename, etc.) don't have a natural version to gate on — we just
  // re-read and re-apply if something raced us.
  async function mutateLobby(mutator, { maxAttempts = 3 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!currentRow) await refetch();
      if (!currentRow) return { ok: false, error: 'Room not found.' };
      const lobby = currentRow.lobby || { players: [], rules: { ...game.defaultRules }, started: false };
      const nextLobby = mutator({ ...lobby, players: (lobby.players || []).map((p) => ({ ...p })) });
      if (!nextLobby) return { ok: true }; // mutator signalled no-op
      const playerCount = nextLobby.players?.length ?? currentRow.player_count ?? 0;
      const updated = await updateRoomAtomic(
        roomCode,
        { lobby: nextLobby, player_count: playerCount },
        currentRow.version,
      );
      if (updated) { applyRow(updated); return { ok: true }; }
      await refetch();
    }
    return { ok: false, error: 'Could not apply change — please retry.' };
  }

  async function submitAction(playerId, action) {
    if (!currentRow) return { ok: false, error: 'Room not ready.' };
    if (!currentRow.state) return { ok: false, error: 'Game has not started.' };
    const expectedVersion = currentRow.version;
    const res = game.applyAction(currentRow.state, playerId, action);
    if (!res.ok) return res;
    const updated = await updateRoomAtomic(
      roomCode,
      { state: res.state, version: expectedVersion + 1 },
      expectedVersion,
    );
    if (!updated) {
      await refetch();
      return { ok: false, error: 'stale-state' };
    }
    applyRow(updated);
    return { ok: true };
  }

  function scheduleBotIfNeeded() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    if (destroyed) return;
    const state = currentRow?.state;
    const lobby = currentRow?.lobby;
    if (!state || state.winner || !lobby) return;
    const turnSeat = lobby.players?.find((p) => p.id === state.turn);
    if (!turnSeat?.isCpu) return;

    // Election: only non-CPU clients run bots. Each client picks its
    // staggered delay based on its rank among non-CPUs in playerOrder,
    // so the "primary" fires first and the rest collapse to no-ops
    // when they see the state advance. This lets the game keep moving
    // even if the primary is offline.
    const nonCpuSeats = (state.playerOrder || []).filter((id) => {
      const seat = lobby.players.find((p) => p.id === id);
      return seat && !seat.isCpu;
    });
    const myRank = nonCpuSeats.indexOf(myPlayerId);
    if (myRank < 0) return;

    const plan = game.cpuPlan(state, state.turn, turnSeat.cpuDifficulty || 'normal');
    if (!plan || plan.length === 0) return;
    const firstAction = plan[0];
    const baseDelay = game.botActionDelay ? game.botActionDelay(firstAction) : 1200;
    const stagger = myRank * BOT_STAGGER_MS;

    botTimer = setTimeout(async () => {
      botTimer = null;
      if (destroyed) return;
      // Re-verify it's still this CPU's turn at the same version —
      // avoids racing against another client who already fired.
      const cur = currentRow;
      if (!cur?.state) return;
      if (cur.state.turn !== state.turn) return;
      if (cur.version !== state.version) return;
      await submitAction(state.turn, firstAction);
    }, baseDelay + stagger);
  }

  async function sendChat(text) {
    const clean = String(text || '').slice(0, 500).trim();
    if (!clean) return;
    const msg = { from: myPlayerId, name: myName, text: clean, ts: Date.now() };
    try { channel.send({ type: 'broadcast', event: 'chat', payload: msg }); } catch {}
    onChat?.(msg); // self-echo so the sender sees their message immediately
  }

  function destroy() {
    destroyed = true;
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
    try { supabase.removeChannel(channel); } catch {}
  }

  return {
    myPlayerId,
    roomCode,
    getLobby: () => currentRow?.lobby,
    getState: () => currentRow?.state,
    refetch,

    // Lobby ops (UI gates creator-only ones).
    async updateRules(rules) {
      return mutateLobby((lobby) => ({ ...lobby, rules: { ...lobby.rules, ...rules } }));
    },
    async setName(newName) {
      const clean = String(newName || '').slice(0, 20).trim();
      if (!clean) return { ok: false, error: 'Name required.' };
      return mutateLobby((lobby) => ({
        ...lobby,
        players: lobby.players.map((p) => (p.id === myPlayerId ? { ...p, name: clean } : p)),
      }));
    },
    async addCpu(difficulty = 'normal') {
      if (!['easy', 'normal', 'hard'].includes(difficulty)) difficulty = 'normal';
      return mutateLobby((lobby) => {
        if ((lobby.players?.length || 0) >= game.maxPlayers) return null;
        const usedNums = new Set(
          lobby.players
            .filter((p) => p.isCpu)
            .map((p) => parseInt(String(p.id).replace(/^cpu_/, ''), 10))
            .filter((n) => !Number.isNaN(n)),
        );
        let n = 1;
        while (usedNums.has(n)) n += 1;
        return {
          ...lobby,
          players: [
            ...lobby.players,
            { id: `cpu_${n}`, name: `CPU ${n}`, profileId: null, isCpu: true, cpuDifficulty: difficulty },
          ],
        };
      });
    },
    async removeCpu(id) {
      return mutateLobby((lobby) => {
        const seat = lobby.players.find((p) => p.id === id);
        if (!seat || !seat.isCpu) return null;
        return { ...lobby, players: lobby.players.filter((p) => p.id !== id) };
      });
    },
    async setCpuDifficulty(id, difficulty) {
      if (!['easy', 'normal', 'hard'].includes(difficulty)) return { ok: false, error: 'Invalid difficulty' };
      return mutateLobby((lobby) => {
        const seat = lobby.players.find((p) => p.id === id);
        if (!seat || !seat.isCpu) return null;
        return { ...lobby, players: lobby.players.map((p) => (p.id === id ? { ...p, cpuDifficulty: difficulty } : p)) };
      });
    },
    async startGame() {
      if (!currentRow) await refetch();
      if (!currentRow) return { ok: false, error: 'Room not found.' };
      const lobby = currentRow.lobby;
      if (!lobby) return { ok: false, error: 'No lobby.' };
      const humans = lobby.players.filter((p) => !p.isCpu);
      if ((lobby.players?.length || 0) < game.minPlayers) {
        return { ok: false, error: `Need at least ${game.minPlayers} players` };
      }
      if (humans.length < 2) {
        return { ok: false, error: 'Need at least one other human in the room. Use "Play vs CPU" for solo games.' };
      }
      const ids = lobby.players.map((p) => p.id);
      const names = Object.fromEntries(lobby.players.map((p) => [p.id, p.name]));
      let state;
      try {
        state = game.createGame(ids, names, lobby.rules);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
      for (const lp of lobby.players) {
        if (state.players[lp.id]) state.players[lp.id].profileId = lp.profileId || null;
      }
      const updated = await updateRoomAtomic(
        roomCode,
        { state, version: 0, started: true, lobby: { ...lobby, started: true } },
        currentRow.version,
      );
      if (!updated) {
        await refetch();
        return { ok: false, error: 'Lobby changed while starting — please try again.' };
      }
      applyRow(updated);
      return { ok: true };
    },

    submitAction(action) { return submitAction(myPlayerId, action); },
    sendChat,
    // No undo in the realtime port yet — port from net.js as a follow-up.
    requestUndo() { return { ok: false, error: 'Undo not yet supported on realtime rooms.' }; },
    castUndoVote() { return { ok: false, error: 'Undo not yet supported on realtime rooms.' }; },
    sendRename(newName) { return this.setName(newName); },
    destroy,
  };
}

// ───────────────────────────── CREATOR ─────────────────────────────
export async function createHost({ game, roomCode, hostName, hostProfileId, onLobby, onState, onChat, onError, onStatus }) {
  if (!supabase) throw new Error('Supabase is required for online rooms.');
  onStatus?.({ kind: 'connecting' });
  const myPlayerId = stableId(hostProfileId);
  const initialLobby = {
    roomCode,
    creatorId: myPlayerId,
    hostId: myPlayerId,
    players: [{
      id: myPlayerId,
      name: hostName,
      profileId: hostProfileId || null,
      isCpu: false,
      isCreator: true,
    }],
    rules: { ...game.defaultRules },
    started: false,
  };

  // If a stale row exists for this code (previous session, broker TTL
  // etc.) and it's clearly not an active game of ours, upsert over it.
  // A genuine collision (two different hosts choosing the same code
  // within the freshness window) is vanishingly rare given 4-char
  // codes and short TTL.
  const row = {
    code: roomCode,
    host_name: hostName,
    player_count: 1,
    max_players: game.maxPlayers,
    started: false,
    game_type: game.id,
    lobby: initialLobby,
    state: null,
    version: 0,
    updated_at: nowIso(),
  };
  const { data, error } = await supabase
    .from('rooms')
    .upsert(row, { onConflict: 'code' })
    .select()
    .maybeSingle();
  if (error) {
    onStatus?.({ kind: 'error', type: 'insert', message: error.message });
    throw error;
  }

  const handle = attachRoom({
    game,
    roomCode,
    myPlayerId,
    myProfileId: hostProfileId,
    myName: hostName,
    initialRow: data || row,
    onLobby, onState, onChat, onStatus,
  });

  // Expose `hostId` for App.jsx which uses it to identify the creator's
  // seat in the local UI (isHost checks).
  return { ...handle, hostId: myPlayerId };
}

// ───────────────────────────── JOINER ─────────────────────────────
export async function createClient({ game, roomCode, name, profileId, onLobby, onState, onChat, onError, onWelcome, onStatus }) {
  if (!supabase) throw new Error('Supabase is required for online rooms.');
  onStatus?.({ kind: 'connecting', phase: 'signaling' });

  const row = await fetchRoom(roomCode);
  if (!row) {
    const msg = `Room ${roomCode} not found. Check the code or ask the host to create one.`;
    onStatus?.({ kind: 'error', type: 'peer-unavailable', message: msg });
    throw Object.assign(new Error(msg), { type: 'peer-unavailable' });
  }

  const lobby = row.lobby || { players: [], rules: { ...game.defaultRules }, started: false };
  const myPlayerId = stableId(profileId);

  // Reconnect path: if a seat with this profileId already exists, reuse
  // it (keeps game state references valid). Otherwise add a new seat.
  const existing = profileId
    ? lobby.players.find((p) => p.profileId === profileId)
    : lobby.players.find((p) => p.id === myPlayerId);

  if (!existing) {
    if (lobby.started) {
      const msg = 'Game already in progress.';
      onStatus?.({ kind: 'error', type: 'already-started', message: msg });
      throw new Error(msg);
    }
    if (lobby.players.length >= game.maxPlayers) {
      const msg = 'Room is full.';
      onStatus?.({ kind: 'error', type: 'room-full', message: msg });
      throw new Error(msg);
    }
    const nextLobby = {
      ...lobby,
      players: [
        ...lobby.players,
        { id: myPlayerId, name, profileId: profileId || null, isCpu: false, isCreator: false },
      ],
    };
    const updated = await updateRoomAtomic(
      roomCode,
      { lobby: nextLobby, player_count: nextLobby.players.length },
      row.version,
    );
    if (updated) row.lobby = updated.lobby;
  } else if (existing.name !== name) {
    // Keep the display name in sync with whatever the client chose.
    const nextLobby = {
      ...lobby,
      players: lobby.players.map((p) => (p.id === existing.id ? { ...p, name } : p)),
    };
    await updateRoomAtomic(roomCode, { lobby: nextLobby }, row.version);
  }

  const freshRow = await fetchRoom(roomCode);
  const handle = attachRoom({
    game,
    roomCode,
    myPlayerId: existing?.id || myPlayerId,
    myProfileId: profileId,
    myName: name,
    initialRow: freshRow || row,
    onLobby, onState, onChat, onStatus,
  });

  onWelcome?.(existing?.id || myPlayerId, freshRow?.lobby || row.lobby);
  return handle;
}

// Room code generator preserved from net.js so callers stay identical.
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
