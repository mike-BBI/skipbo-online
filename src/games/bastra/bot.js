// Greedy Bastra bot. Prefers captures (biggest capture first), then
// Bastras with jacks, then dumps low-scoring cards.

import { RANK_JACK, RANK_ACE } from './engine.js';

function cardScoreValue(c) {
  if (c.rank === RANK_JACK) return 6; // J is both scoring and a Bastra enabler — keep it
  if (c.rank === RANK_ACE) return 3;
  if (c.rank === 10 && c.suit === 'D') return 10;
  if (c.rank === 2 && c.suit === 'C') return 4;
  return 0;
}

export function cpuPlan(state, cpuId) {
  const p = state.players[cpuId];
  if (!p || p.hand.length === 0) return [];

  // 1. Best non-J capture (prefer capturing the most table cards).
  let bestCapture = null;
  for (let i = 0; i < p.hand.length; i++) {
    const c = p.hand[i];
    if (c.rank === RANK_JACK) continue;
    const matchCount = state.table.filter((t) => t.rank === c.rank).length;
    if (matchCount > 0) {
      const score = matchCount * 10 + cardScoreValue(c);
      if (!bestCapture || score > bestCapture.score) {
        bestCapture = { handIndex: i, score };
      }
    }
  }
  if (bestCapture) return [{ type: 'play', handIndex: bestCapture.handIndex }];

  // 2. Play a Jack if the table is non-empty — guaranteed Bastra.
  if (state.table.length > 0) {
    const jackIdx = p.hand.findIndex((c) => c.rank === RANK_JACK);
    if (jackIdx >= 0) return [{ type: 'play', handIndex: jackIdx }];
  }

  // 3. Dump the lowest-value non-scoring card, saving good stuff.
  let bestIdx = 0;
  let bestDumpScore = cardScoreValue(p.hand[0]);
  for (let i = 1; i < p.hand.length; i++) {
    const s = cardScoreValue(p.hand[i]);
    if (s < bestDumpScore) { bestDumpScore = s; bestIdx = i; }
  }
  return [{ type: 'play', handIndex: bestIdx }];
}
