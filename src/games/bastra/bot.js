// Bastra bot with three difficulty bands:
//   easy   — picks a random legal capture / random dump.
//   normal — greedy: largest haul (points + Bastra bonus). Current baseline.
//   hard   — greedy + smarter dumping (avoids feeding opponents same-rank
//            cards and protects own scoring cards).

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

// "Lower is better to discard" score used by hard mode: add a penalty
// for dumping a card whose rank is already on the table (opponent can
// capture it back) and for dumping scoring cards in general.
function hardDumpScore(card, state) {
  let penalty = cardScoreValue(card);
  if (state.table.some((t) => t.rank === card.rank)) penalty += 2;
  return penalty;
}

function legalPlays(state, cpuId) {
  const p = state.players[cpuId];
  const plays = [];
  for (let i = 0; i < p.hand.length; i++) {
    const card = p.hand[i];
    if (card.rank === RANK_JACK) {
      plays.push({
        type: 'play',
        handIndex: i,
        tableIndices: state.table.map((_, idx) => idx),
      });
      continue;
    }
    const capture = findBestCapture(card, state.table);
    plays.push({
      type: 'play',
      handIndex: i,
      tableIndices: capture.length > 0 ? capture : [],
    });
  }
  return plays;
}

function easyPlan(state, cpuId) {
  const p = state.players[cpuId];
  const plays = legalPlays(state, cpuId);
  // Prefer a capture if one exists — even a beginner would notice an
  // obvious same-rank match. Just don't bother optimizing between
  // multiple captures.
  const captures = plays.filter((m) => m.tableIndices.length > 0);
  if (captures.length > 0) {
    return [captures[Math.floor(Math.random() * captures.length)]];
  }
  // No capture — random dump.
  return [{
    type: 'play',
    handIndex: Math.floor(Math.random() * p.hand.length),
    tableIndices: [],
  }];
}

export function cpuPlan(state, cpuId, difficulty = 'normal') {
  const p = state.players[cpuId];
  if (!p || p.hand.length === 0) return [];

  if (difficulty === 'easy') return easyPlan(state, cpuId);

  let bestAction = null;
  let bestValue = -1;

  for (let i = 0; i < p.hand.length; i++) {
    const card = p.hand[i];
    if (card.rank === RANK_JACK) {
      if (state.table.length > 0) {
        let v = captureValue(card, state.table);
        // Hard mode: if the table is small and nothing on it is worth
        // grabbing, hold the Jack for a juicier sweep later. Subtract
        // a small value so a real capture can beat it.
        if (
          difficulty === 'hard'
          && state.table.length < 3
          && !state.table.some((c) => cardScoreValue(c) > 0)
        ) {
          v -= 5;
        }
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

  // No capture available — dump the lowest-value card. Hard mode
  // additionally penalizes dumping a rank already on the table (which
  // sets up opponent captures).
  const scoreFn = difficulty === 'hard'
    ? ((c) => hardDumpScore(c, state))
    : cardScoreValue;
  let bestIdx = 0;
  let bestDumpScore = scoreFn(p.hand[0]);
  for (let i = 1; i < p.hand.length; i++) {
    const s = scoreFn(p.hand[i]);
    if (s < bestDumpScore) { bestDumpScore = s; bestIdx = i; }
  }
  return [{ type: 'play', handIndex: bestIdx, tableIndices: [] }];
}
