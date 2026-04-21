// Play Nine engine tests. Run via:  node src/games/playnine/engine.test.mjs
//
// Covers deck composition, scoring edge cases (matching pairs, H1O
// exception, mixed values), and a handful of action/turn flow
// assertions so future refactors can't silently change rules.

import {
  buildDeck, shuffle, scoreGrid, scoreBreakdown, HOLE_IN_ONE, createGame,
  applyAction, COLUMNS, faceDownCount,
} from './engine.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log('  ok -', msg); }
  else { failed += 1; console.log('  FAIL:', msg); }
}
function section(name) { console.log('\n' + name); }

// ─────────────────────────── Deck ───────────────────────────
section('Deck composition');
{
  const d = buildDeck();
  assert(d.length === 108, '108 cards total');
  assert(d.filter((c) => c === HOLE_IN_ONE).length === 4, '4 Hole-in-One');
  for (let v = 0; v <= 12; v += 1) {
    assert(d.filter((c) => c === v).length === 8, `8 copies of ${v}`);
  }
}

section('Shuffle');
{
  // Card conservation after shuffle.
  const orig = buildDeck();
  const shuf = shuffle(orig);
  assert(shuf.length === orig.length, 'same size after shuffle');
  const origSorted = [...orig].sort((a, b) => a - b).join(',');
  const shufSorted = [...shuf].sort((a, b) => a - b).join(',');
  assert(origSorted === shufSorted, 'same multiset');
  // Distinctness: 500 shuffles → 500 distinct permutations.
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(shuffle(buildDeck()).join(','));
  assert(seen.size === 500, '500/500 shuffles were distinct');
}

// ─────────────────────────── Scoring ───────────────────────────
section('Scoring: no matches');
{
  // All 8 unique non-matching values: sum face values.
  //    grid:   0 1 2 3
  //            4 5 6 7
  const grid = [0, 1, 2, 3, 4, 5, 6, 7];
  assert(scoreGrid(grid) === 0 + 1 + 2 + 3 + 4 + 5 + 6 + 7, 'sums all face values when no column matches');
}

section('Scoring: one matching pair, no bonus');
{
  //    7 3 5 9
  //    7 2 4 8
  // Only column 0 matches (7/7). Canceled → 0 strokes.
  // Rest: 3+5+9+2+4+8 = 31.
  const grid = [7, 3, 5, 9, 7, 2, 4, 8];
  assert(scoreGrid(grid) === 3 + 5 + 9 + 2 + 4 + 8, 'one non-H1O pair cancels with no bonus');
}

section('Scoring: two matching pairs of same value (-10 bonus)');
{
  //    7 7 3 5
  //    7 7 2 4
  // Columns 0, 1 match (7/7 both). -10 bonus.
  // Rest: 3+5+2+4 = 14. Total = 14 + -10 = 4.
  const grid = [7, 7, 3, 5, 7, 7, 2, 4];
  assert(scoreGrid(grid) === 4, 'two pairs of 7 → 0 strokes for those 4 cards + -10 bonus');
}

section('Scoring: three matching pairs (-15 bonus)');
{
  //    4 4 4 9
  //    4 4 4 2
  const grid = [4, 4, 4, 9, 4, 4, 4, 2];
  // Cols 0,1,2 match 4s. Rest: 9+2=11. Total: 11 + -15 = -4.
  assert(scoreGrid(grid) === -4, 'three pairs of 4 → -15 bonus');
}

section('Scoring: four matching pairs (-20 bonus)');
{
  //    6 6 6 6
  //    6 6 6 6
  const grid = [6, 6, 6, 6, 6, 6, 6, 6];
  // All pairs match. Total: -20.
  assert(scoreGrid(grid) === -20, 'four pairs of 6 → -20 bonus, all cards cancel');
}

section('Scoring: Hole-in-One single matching pair does NOT cancel');
{
  //    H1O 3 5 9
  //    H1O 2 4 8
  const grid = [HOLE_IN_ONE, 3, 5, 9, HOLE_IN_ONE, 2, 4, 8];
  // H1O pair doesn't cancel — each scores -5, no bonus for 1 pair.
  // -5 + -5 + 3+5+9+2+4+8 = -10 + 31 = 21.
  assert(scoreGrid(grid) === 21, 'H1O matched pair keeps -5 face value');
}

section('Scoring: Four Hole-in-One Bonus (-30 total for the 4 H1O)');
{
  //    H1O H1O 3 7
  //    H1O H1O 2 8
  const grid = [HOLE_IN_ONE, HOLE_IN_ONE, 3, 7, HOLE_IN_ONE, HOLE_IN_ONE, 2, 8];
  // Cols 0,1 match H1O each. Each card still scores -5 → -20 + -10 bonus = -30.
  // Rest: 3+7+2+8 = 20. Total: -30 + 20 = -10.
  assert(scoreGrid(grid) === -10, 'four H1O in two matching pairs: -5 each + -10 bonus');
}

section('Scoring: mixed H1O and regular matches');
{
  //    H1O 7 9 11
  //    H1O 7 9 11
  const grid = [HOLE_IN_ONE, 7, 9, 11, HOLE_IN_ONE, 7, 9, 11];
  // Col 0: H1O pair → -10 (kept).
  // Cols 1,2,3: pairs of 7, 9, 11 — each a single pair of distinct value, cancels to 0, no bonus.
  // Total: -10.
  assert(scoreGrid(grid) === -10, 'H1O pair + three single non-H1O pairs, each distinct, no bonus');
}

section('Scoring: matched zeros');
{
  //    0 0 3 5
  //    0 0 2 4
  const grid = [0, 0, 3, 5, 0, 0, 2, 4];
  // Two pairs of 0s → cancel + -10 bonus. Rest: 3+5+2+4=14. Total: 4.
  assert(scoreGrid(grid) === 4, 'two pairs of 0 still earn the -10 bonus');
}

// ─────────────────────────── Breakdown ───────────────────────────
section('scoreBreakdown marks matched/cancelled cards correctly');
{
  const grid = [7, 3, 5, 9, 7, 2, 4, 8];
  const bd = scoreBreakdown(grid);
  assert(bd.cards[0].matched === true && bd.cards[0].cancelled === true, 'col-0 top 7 is matched + cancelled');
  assert(bd.cards[4].matched === true && bd.cards[4].cancelled === true, 'col-0 bottom 7 is matched + cancelled');
  assert(bd.cards[1].matched === false, '3 (no pair) is not matched');
  assert(bd.bonuses.length === 0, 'one pair → no bonus line');
}
{
  // H1O pair: matched but NOT cancelled (still scores).
  const grid = [HOLE_IN_ONE, 3, 5, 9, HOLE_IN_ONE, 2, 4, 8];
  const bd = scoreBreakdown(grid);
  assert(bd.cards[0].matched === true, 'H1O matched');
  assert(bd.cards[0].cancelled === false, 'H1O not cancelled');
}

// ─────────────────────────── Game lifecycle ───────────────────────────
section('createGame deals 8 cards per player and one discard');
{
  const g = createGame(['a', 'b'], { a: 'A', b: 'B' });
  assert(g.players.a.grid.length === 8, 'player A has 8 grid cards');
  assert(g.players.b.grid.length === 8, 'player B has 8 grid cards');
  assert(g.players.a.flipped.every((f) => f === false), 'all face-down initially');
  assert(g.discard.length === 1, 'discard has one card');
  assert(g.phase === 'teeOff', 'phase is teeOff');
  assert(g.deck.length === 108 - 16 - 1, 'deck has expected remaining count');
}

section('Tee-off: each player flips two before play begins');
{
  let g = createGame(['a', 'b'], {});
  // Player a flips 2
  g.turn = 'a';
  let r = applyAction(g, 'a', { type: 'teeOffFlip', slot: 0 });
  assert(r.ok, 'a flip 1');
  g = r.state;
  r = applyAction(g, 'a', { type: 'teeOffFlip', slot: 1 });
  assert(r.ok, 'a flip 2');
  g = r.state;
  assert(g.turn === 'b', 'turn moves to b after a flips 2');
  assert(g.phase === 'teeOff', 'still teeOff');
  // B flips 2
  r = applyAction(g, 'b', { type: 'teeOffFlip', slot: 0 });
  g = r.state;
  r = applyAction(g, 'b', { type: 'teeOffFlip', slot: 1 });
  g = r.state;
  assert(g.phase === 'play', 'phase transitions to play after everyone flips 2');
  assert(g.turn === g.firstPlayer, 'first player (dealer + 1) takes first play turn');
}

section('Draw + replace revealing a face-down card');
{
  let g = createGame(['a', 'b'], {});
  // Fast-forward tee-off
  for (let s = 0; s < 2; s += 1) g = applyAction(g, 'a', { type: 'teeOffFlip', slot: s }).state;
  for (let s = 0; s < 2; s += 1) g = applyAction(g, 'b', { type: 'teeOffFlip', slot: s }).state;
  const actor = g.turn;
  const before = faceDownCount(g.players[actor]);
  g = applyAction(g, actor, { type: 'drawDeck' }).state;
  assert(g.players[actor].drawn !== null, 'drawn card populated');
  // Replace a face-down slot
  const fdSlot = g.players[actor].flipped.findIndex((f) => !f);
  g = applyAction(g, actor, { type: 'replace', slot: fdSlot }).state;
  assert(g.players[actor].flipped[fdSlot] === true, 'replaced slot is face-up');
  assert(g.players[actor].drawn === null, 'hand cleared after replace');
  assert(faceDownCount(g.players[actor]) === before - 1, 'face-down count -1');
  assert(g.turn !== actor, 'turn passed after replace');
}

section('discardAndFlip requires deck-sourced drawn card');
{
  let g = createGame(['a', 'b'], {});
  for (let s = 0; s < 2; s += 1) g = applyAction(g, 'a', { type: 'teeOffFlip', slot: s }).state;
  for (let s = 0; s < 2; s += 1) g = applyAction(g, 'b', { type: 'teeOffFlip', slot: s }).state;
  const actor = g.turn;
  // Draw from DISCARD
  g = applyAction(g, actor, { type: 'drawDiscard' }).state;
  const fdSlot = g.players[actor].flipped.findIndex((f) => !f);
  const r = applyAction(g, actor, { type: 'discardAndFlip', slot: fdSlot });
  assert(!r.ok, 'cannot discard-and-flip when card came from discard');
}

section('Putting out triggers one last turn for others');
{
  let g = createGame(['a', 'b', 'c'], {});
  for (const id of ['a', 'b', 'c']) {
    for (let s = 0; s < 2; s += 1) g = applyAction(g, id, { type: 'teeOffFlip', slot: s }).state;
  }
  // Force the first player into "6 face-up" then let them flip their last two.
  const leader = g.turn;
  // Manually expose 5 more cards (they already have 2 face-up from tee-off).
  for (let i = 2; i < 7; i += 1) g.players[leader].flipped[i] = true;
  // Now they have 1 face-down left. Replace it.
  g = applyAction(g, leader, { type: 'drawDeck' }).state;
  g = applyAction(g, leader, { type: 'replace', slot: 7 }).state;
  assert(g.puttingOutBy === leader, 'leader is putting out');
  assert(faceDownCount(g.players[leader]) === 0, 'leader has no face-downs');
  assert(g.finalLapRemaining && g.finalLapRemaining.length >= 1, 'final-lap queue populated');
  // Exhaust final lap by taking dummy turns for the remaining players.
  while (!g.holeEnded) {
    const who = g.turn;
    g = applyAction(g, who, { type: 'drawDeck' }).state;
    // Replace slot 0 (already face-up → just swaps).
    g = applyAction(g, who, { type: 'replace', slot: 0 }).state;
  }
  assert(g.holeEnded === true, 'hole ends after final lap');
  assert(g.roundScores != null, 'round scores populated');
  for (const id of g.playerOrder) {
    assert(g.players[id].flipped.every((f) => f), `${id} has all cards face-up for scoring`);
  }
}

section('Skip only legal with exactly 1 face-down remaining');
{
  let g = createGame(['a', 'b'], {});
  for (const id of ['a', 'b']) {
    for (let s = 0; s < 2; s += 1) g = applyAction(g, id, { type: 'teeOffFlip', slot: s }).state;
  }
  const actor = g.turn;
  // With 6 face-downs, skip should fail.
  const r = applyAction(g, actor, { type: 'skip' });
  assert(!r.ok, 'skip fails with more than 1 face-down');
  // Force to 1 face-down and retry.
  for (let i = 2; i < 7; i += 1) g.players[actor].flipped[i] = true;
  const r2 = applyAction(g, actor, { type: 'skip' });
  assert(r2.ok, 'skip succeeds with exactly 1 face-down');
  assert(r2.state.turn !== actor, 'skip still advances the turn');
}

// ─────────────────────────── Bot difficulty sanity ───────────────────────────
import { cpuPlan } from './bot.js';

section('Bot: each difficulty returns legal actions from a mid-game state');
{
  for (const difficulty of ['easy', 'normal', 'hard']) {
    let g = createGame(['a', 'b', 'c'], { a: 'A', b: 'B', c: 'C' });
    // Complete tee-off for everyone.
    for (const id of ['a', 'b', 'c']) {
      let done = 0;
      while (done < 2) {
        const plan = cpuPlan(g, id, difficulty);
        assert(plan.length > 0, `${difficulty} returns tee-off plan for ${id}`);
        for (const act of plan) {
          const res = applyAction(g, g.turn, act);
          assert(res.ok, `${difficulty} tee-off action legal: ${JSON.stringify(act)} → ${res.error || 'ok'}`);
          g = res.state;
        }
        done = g.teeOffFlips[id] || 0;
      }
    }
    // Play ~20 turns via the bot at this difficulty and ensure every
    // action is legal. Doesn't verify cleverness, just legality.
    for (let step = 0; step < 40 && !g.holeEnded; step += 1) {
      const actor = g.turn;
      const plan = cpuPlan(g, actor, difficulty);
      if (plan.length === 0) break;
      for (const act of plan) {
        const res = applyAction(g, actor, act);
        assert(res.ok, `${difficulty} mid-game action legal: ${JSON.stringify(act)} → ${res.error || 'ok'}`);
        if (!res.ok) { g = null; break; }
        g = res.state;
      }
      if (!g) break;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
