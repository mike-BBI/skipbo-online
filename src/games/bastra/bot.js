// Greedy Bastra bot. For each hand card it finds the largest valid
// capture; best move is the one that nets the most cards (with a big
// bastra bonus). No captures available? Dump the lowest-scoring card.

import { RANK_JACK, RANK_ACE, findBestCapture } from './engine.js';

function cardScoreValue(c) {
  if (c.rank === RANK_JACK) return 6;
  if (c.rank === RANK_ACE) return 3;
  if (c.rank === 10 && c.suit === 'D') return 10;
  if (c.rank === 2 && c.suit === 'C') return 4;
  return 0;
}

function captureValue(playedCard, capturedTableCards) {
  // Heuristic: captured-card count + scoring cards in the haul. Plus
  // a big bonus if this clears the table (Bastra).
  let v = capturedTableCards.length * 3;
  v += cardScoreValue(playedCard);
  for (const c of capturedTableCards) v += cardScoreValue(c);
  return v;
}

export function cpuPlan(state, cpuId) {
  const p = state.players[cpuId];
  if (!p || p.hand.length === 0) return [];

  let bestAction = null;
  let bestValue = -1;

  for (let i = 0; i < p.hand.length; i++) {
    const card = p.hand[i];
    if (card.rank === RANK_JACK) {
      if (state.table.length > 0) {
        const v = captureValue(card, state.table) + 15; // +15 for guaranteed Bastra
        if (v > bestValue) {
          bestValue = v;
          bestAction = {
            type: 'play',
            handIndex: i,
            tableIndices: state.table.map((_, idx) => idx),
          };
        }
      }
      continue;
    }
    const capture = findBestCapture(card, state.table);
    if (capture.length === 0) continue;
    const capturedCards = capture.map((idx) => state.table[idx]);
    const isBastra = capture.length === state.table.length;
    const v = captureValue(card, capturedCards) + (isBastra ? 15 : 0);
    if (v > bestValue) {
      bestValue = v;
      bestAction = { type: 'play', handIndex: i, tableIndices: capture };
    }
  }

  if (bestAction) return [bestAction];

  // No capture available — dump the lowest-scoring non-scoring card.
  let bestIdx = 0;
  let bestDumpScore = cardScoreValue(p.hand[0]);
  for (let i = 1; i < p.hand.length; i++) {
    const s = cardScoreValue(p.hand[i]);
    if (s < bestDumpScore) { bestDumpScore = s; bestIdx = i; }
  }
  return [{ type: 'play', handIndex: bestIdx, tableIndices: [] }];
}
