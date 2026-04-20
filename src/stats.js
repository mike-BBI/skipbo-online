// Local profile + game history. Everything lives in localStorage;
// there is no backend. Each device has its own independent profile.
// At the end of a game the outcome is recorded with the stable
// profileId so lifetime stats survive across sessions.

const PROFILE_KEY = 'skipbo.profile';
const HISTORY_KEY = 'skipbo.history';
const HISTORY_LIMIT = 200;

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const COLORS = [
  '#38bdf8', '#22c55e', '#ec4899', '#f59e0b',
  '#a855f7', '#14b8a6', '#f43f5e', '#eab308',
];

export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const profile = {
    id: uuid(),
    name: localStorage.getItem('skipbo.name') || '',
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    createdAt: Date.now(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

export function setProfile(partial) {
  const current = getProfile();
  const next = { ...current, ...partial };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  if (typeof next.name === 'string') localStorage.setItem('skipbo.name', next.name);
  return next;
}

export function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

// Append a game outcome to local history. `state` is the final engine
// state; `profileId` is this device's player's stable id (so we can
// tell "did I win?" even if my display name changed).
export function recordGame(state, profileId, humanGameId) {
  const history = getHistory();
  const winnerHumanId = state.winner;
  const record = {
    id: uuid(),
    endedAt: Date.now(),
    startedAt: state.startedAt ?? null,
    durationMs: state.startedAt ? Date.now() - state.startedAt : null,
    turnCount: state.turnNumber ?? null,
    winnerGameId: winnerHumanId,
    winnerName: winnerHumanId ? state.players[winnerHumanId]?.name ?? null : null,
    didIWin: humanGameId != null && winnerHumanId === humanGameId,
    myProfileId: profileId,
    rules: {
      stockSize: state.rules?.stockSize,
      handSize: state.rules?.handSize,
      maxDiscardDepth: state.rules?.maxDiscardDepth,
    },
    deckCount: state.deckCount ?? 1,
    players: state.playerOrder.map((id) => ({
      gameId: id,
      name: state.players[id]?.name ?? id,
      stockRemaining: state.players[id]?.stock.length ?? 0,
    })),
  };
  history.push(record);
  // Cap history so localStorage never grows unbounded.
  while (history.length > HISTORY_LIMIT) history.shift();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return record;
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

// Summary statistics computed over the local history array.
export function computeStats(history = getHistory()) {
  const total = history.length;
  const wins = history.filter((r) => r.didIWin).length;
  const totalTurns = history.reduce((s, r) => s + (r.turnCount || 0), 0);
  const totalDuration = history.reduce((s, r) => s + (r.durationMs || 0), 0);
  const avgTurnsPerGame = total ? Math.round(totalTurns / total) : 0;
  const avgDurationMs = total ? Math.round(totalDuration / total) : 0;
  return {
    total,
    wins,
    losses: total - wins,
    winPct: total ? Math.round((wins / total) * 1000) / 10 : 0,
    avgTurnsPerGame,
    avgDurationMs,
  };
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
