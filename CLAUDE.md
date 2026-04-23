# Project notes — Skip-Bo / Bastra / Play Nine / Thirty-One online

Browser card-game app hosted on Vercel (`https://skipbo-online.vercel.app`). React 18 + Vite + JavaScript (no TypeScript). **Supabase Realtime + Postgres** for multiplayer (no more PeerJS), Supabase for profiles + optional cloud stats.

## Repo layout

- `src/App.jsx` — top-level shell: phase/mode routing (home → practice-setup → lobby → game), net wiring, CPU scheduling for practice mode, stats recording, **`GameErrorBoundary`** (wraps `<Game>` so render crashes show error + component stack). `scheduleCpuTurn` passes a **950ms head-start to the first action of each CPU turn** so the turn-announce banner + any in-flight overlay animations don't step on each other (via the `headStart` param in `playCpuActions`).
- `src/realtimeNet.js` — **current networking layer.** Supabase Realtime + Postgres, no authoritative host. Room state lives in `rooms.state` jsonb with `rooms.version` optimistic-concurrency gate. `createHost()` / `createClient()` both call `attachRoom()`. Exposes `submitAction`, `requestUndo`, `castUndoVote`, `addCpu/removeCpu/setCpuDifficulty`, `startGame`. Bot election: every non-CPU client schedules CPU actions locally staggered by playerOrder index, first optimistic UPDATE wins. Chat is ephemeral Realtime broadcast.
- `src/net.js` — **legacy PeerJS host/client, not currently used.** Kept for reference; new code goes in `realtimeNet.js`.
- `src/rooms.js` — public room list subscription + heartbeat. Rooms older than 120s are stale; started rooms stay visible for mid-game rejoin.
- `src/stats.js` — localStorage history + `recordGame(state, profileId, myId, gameType)`. `vsHuman` field (true if ≥1 other profileId at end). `computeStats(h, { vsHumanOnly: true })` filters locally. **Supabase `game_records` table doesn't have `vs_human` column yet** — cloud stats ignore the flag.
- `src/profiles.js` — Supabase profile + `recordGameForProfile` cloud sync.
- `src/games/` — each game is a self-contained module (`skipbo/`, `bastra/`, `playnine/`, `thirtyone/`) exporting `{ id, name, createGame, applyAction, cpuPlan, defaultRules, minPlayers, maxPlayers, botActionDelay, botBetweenTurns, Game, Lobby }` from `index.js`.
  - `bot.js` — each has `cpuPlan(state, cpuId, difficulty = 'normal')`. Easy / Normal / Hard tiers. `botActionDelay(action, state)` signature — second arg lets games inspect state (e.g. Thirty-One bumps delays while `state.knockBy` is set).

## Concurrency model (realtimeNet)

- Any client submitting an action runs `applyAction` locally, then `UPDATE rooms SET state=new, version=version+1 WHERE code=? AND version=expected`. 0 rows updated ⇒ stale, refetch + drop attempt. Supabase Realtime broadcasts the write to everyone.
- **Polling is the primary sync path**; Realtime is best-effort (`ca1f93f`). `postgres_changes` and `broadcast` run on separate channels (`f54270b`). `REPLICA IDENTITY FULL` is baked into the migration (`f87cbf5`).
- Undo vote (`a0a81c2`, ported from `net.js`): every `submitAction` snapshots pre-state on the room row. `requestUndo` builds a voters list, pre-fills YES for CPUs, writes vote with deadline (15s). `castUndoVote` records vote; finalization runs inline AND on row updates so expired votes get finalized by whoever polls next. Unvoted-at-deadline = auto-YES (silent = no objection). Bot scheduling pauses while a vote is open.
- Engine-level undo (Play Nine per-player, Thirty-One per-player): `submitAction` special-cases `action.type === 'undo'`, passes full state through engine without snapshot wrapping.

## Bastra specifics

- Ranks 1–13, 4 suits. 52-card deck. Jacks sweep the whole table (not a Bastra). Matching-rank captures. Clearing table via non-Jack = Bastra (+10 pts default).
- Scoring at round end: 10♦ = 3 pts, 2♣ = 2 pts, each Ace/Jack = 1 pt, most cards = 3 pts, Bastra = 10 pts each.
- Match ends at target score OR after N rounds (`rules.mode = 'target' | 'rounds'`).
- **First player is randomized once per match**, not per round (`state.firstPlayer` locked in `createGame`).
- **Card rendering uses `cardmeister`** custom element. `Card.jsx` creates `<playing-card cid="...">` imperatively in a `useEffect` with NO deps. **Gotcha: rank 10 MUST map to `"Ten"` not `"10"`, or cardmeister silently renders it as Ace.**
- **End-of-round reveal** (`RoundReveal`) gated by 2.8s `overlayReady` delay, then a **Continue button** (user clicks to open the detailed scorecard). Simple yellow button, not the old ornate tap-prompt.
- **End-of-round crash fix** (`acdffa5`): a non-Jack capture that cleared the table via `endRoundIfDone` then indexed past `state.table` in the animation reconstruction loop. Fix in `bastra/Game.jsx`.

## Skip-Bo specifics

- Standard Skip-Bo rules. Build piles count 1→12. Discard piles stack. Stock empty = winner.
- **Layout (current)**: `.my-area` flex row = Stock + Hand side-by-side (no extra border around the hand). `.my-discards-wrap` = discard piles in their own container BELOW `.my-area`. `.hand-wrap` has `flex: 1; min-width: 0;` — no background/border (the parent `.my-area` is the container).
- **Tap sensitivity**: drag-activation threshold raised 8px → **14px** (finger jitter exceeded 8px and silently flipped taps into drags that went nowhere). Added a tap-fallback: drag released off any drop target now runs the tap behavior instead of silently cancelling. Helper `handleTap(source)` is shared between the no-movement path and the drag-off-target path in `startDrag`.
- **Deal animation**: hand cards get the `.dealing` CSS class ONLY when newly added (`i >= handPrevLen`). Previously-held cards don't re-animate on an incremental refill. Per-new-card delay is `(i - handPrevLen) * 150ms`.
- **Directive opponent-flight overlay** (commit `73b096e`): when an opponent takes an action, a "ghost" card tweens from the source (opp stock / mini-hand / discard pile) to the destination (build pile or opp discard). Self moves don't get flights — tap → card-lands is already clear.
  - Refs: `oppStockRefs`, `oppHandRefs`, `oppDiscardRefs`, `buildPileRefs`.
  - Flight creation: `useLayoutEffect` on `[state.version]` — diffs `prevStateRef` vs current to figure out who acted, what left which pile, what landed where. `FlyingCard` is absolute-positioned (`z-index: 500`); size comes from target's `--card-w/h` CSS vars; transform transitions from source-center to target-center over `FLIGHT_MS = 800ms` with `cubic-bezier(0.33, 0, 0.2, 1)` (no overshoot — earlier bezier with y2=1.05 caused "dip and snap back").
  - **Flight target size** is derived from `getComputedStyle(wrap).getPropertyValue('--card-w/h')` on the WRAPPER. Do NOT measure the inner `.sb-card` — it can be mid-`.fly-in` transform (scale 1.15 + translateY -40px) and the rect gets distorted.
  - **Occlusion during flight**: build piles render `displayBp = bp.slice(0, -1)` while a flight is heading there; opp discards likewise (`displayD = d.slice(0, -1)`). Opp-discard target landing is computed as `lastCard.getBoundingClientRect().top + 3px` (compact cascade offset) — the DiscardPile layout uses a hardcoded 90px cardH that doesn't match opponent 50px cards, so `wrap.bottom` is unreliable.
  - **Immediate (same-render) occlusion**: detected via `prevStateRef` vs `state` diff DURING render, not in an effect. Without this, there's one frame where the new card pops at the destination before `useLayoutEffect` creates the flight.
  - **Skip `.fly-in` on opponent-placed tops**: per-pile ref `buildPileOpponentPlacedRef` tracks which piles were most recently updated by an opponent (vs self). While a pile's top is opponent-placed, `.fly-in` is NOT applied — the flight already did that animation; replaying `.fly-in` on any subsequent re-render would double-animate. Cleared when: (a) self plays to that pile, or (b) the pile completes (12 cards → 0).
  - **Globally suppress `.opponent .sb-card.fly-in`**: opponents use the flight system for all motion, so the built-in fly-in on their cards is redundant. Also `.opp-flight-target .sb-card.fly-in` — the wrapper around a flight-targeted opp discard gets this class synchronously via state diff so there's no frame where fly-in starts before flight suppression kicks in.
  - **Flight wrapper class `.sb-flight-opponent`** (NOT `.opponent`): applies opponent card-scale CSS variables WITHOUT the `.opponent` panel styling (green-gradient background + 1px border + padding). Those panel styles showed as a visible "container" around the flight card in earlier iterations.
- **Turn banner** (`.turn-announcement`): 900ms duration. Fires only when `flights.length === 0` so in-flight animations don't get stepped on by a turn-change banner. `lastTurnRef` initialized to `null` so the banner also fires on the very first render (game start) instead of only on subsequent turn changes.
- **Pile-complete animation fix** (`a72b50d`): the `completingPiles` useEffect cancelled its own 1300ms clearing timer on cleanup → orphaned entries → invisible (but still playable) pile slot. Fix = let the timer run unconditionally.
- **Undo vote** — full mechanism, ported to realtimeNet in `a0a81c2`.

## Play Nine specifics

- 108-card deck: 8 each of 0..12 (104) + 4 Hole-in-One at -5. 2×4 grid per player (8 face-down to start). Each player tees off by flipping any 2 grid cards.
- Turn: draw from deck or discard, then replace any grid slot (replaced → discard) OR [deck only] discard drawn card and flip a face-down. When 1 face-down remains, "skip" is allowed (draw, discard, don't flip).
- "Putting out": revealing/replacing the 8th face-down ends play for that player; others get 1 more turn, then score.
- Scoring: column pairs (top+bottom match) cancel to 0 — **except Hole-in-One, which keeps its -5**. Bonuses: 2 pairs of same value = -10, 3 = -15, 4 = -20. Two H1O pairs get -10 bonus (total -30 for those 4).
- Match default: 9 holes. Lowest cumulative wins. Dealer rotates left each hole; first player is seat to dealer's left.
- **Per-player Undo** (`81ce0e9`): engine-level — reverts player's most recent action.
- **Card faces** (`eada4f9`, `6ab2f5e`): custom SVG matching physical Play Nine cards. Red -5 with square flag for Hole-in-One; golf-flag watermark on card back.
- **End-of-hole reveal**: scorecard grid + **Continue button** (no ornate prompt). Opponent grids show `revealAll={true}` at hole-end; `BOARD_REVEAL_HOLD_MS = 2400` before the Continue button appears.
- **Directive placement animations** (commit `e1eb258`): new card in a replaced grid slot slides in from the "in hand" direction — above for your grid (`p9-placed.from-above`), below for opponents (`p9-placed.from-below`). Drawn card slides into the "In hand" slot from deck (left) or discard (right) side via `p9-drawn-from-deck` / `p9-drawn-from-discard`. Keyed on `state.lastAction.stamp` (added to engine in the same commit) so each action retriggers the animation.
- **Tap-to-discard** (commit `73b096e`): when you drew from the deck, tap the discard pile to enter `flipMode` (then tap a face-down grid card to complete `discardAndFlip`). The separate "Discard + flip a card" button is gone. Prompt updated to match.
- **Full flight overlay system (like Skip-Bo) — NOT YET PORTED.** User asked for it 2026-04-22. Scope: opponent replace/discardAndFlip actions should render a flying card from source → target. See Pending task.
- CPU pacing: teeOffFlip 500–750ms, draw actions 900–1400ms, play actions 1100–1900ms, between turns 400ms.

## Thirty-One specifics

Classic Scat rules. 52-card deck, 3 cards per hand, closest to 31 in a single suit wins.

- A=11, K/Q/J=10, 2..10 face value. Score = best same-suit sum. **Three of a kind = 30** (user's variant — standard rule is 30.5 between 30 and 31; we clamp to 30).
- Turn: knock (at start of turn only, before drawing) OR draw from deck/discard, then discard. Can't re-discard the card just taken from discard.
- **Blitz (31)**: if your hand is 31 after discarding, you reveal immediately — everyone else loses 1 life. Dealt 31 is also an instant blitz.
- **Knock**: everyone else gets one more turn, then showdown. Lowest hand loses a life. If knocker is at/tied for lowest, knocker loses 2 lives (configurable via `rules.knockerPenalty: 2 | 1`). Tied non-knocker lowest all lose 1.
- Lives: default 3. At 0, eliminated. Last player standing wins.
- **Card rendering**: cardmeister custom element (same as Bastra), via `PlayingCard` in `thirtyone/Card.jsx`.
- **UX**: big KNOCK! / 31! popup banner (Bastra OPA!-style), CPU pacing slows by +700ms after a knock (via `botActionDelay(action, state)` inspecting `state.knockBy`), "YOUR LAST TURN" red pulsing banner + board outline when you're up after an opponent's knock, flip-on-table reveal (opponent hands flip face-up on the board for 2.4s before the scorecard overlay opens), simple yellow Continue button.
- **Layout note**: deck-remaining count sits below the deck pile (moved there so it doesn't overlap the pile).
- **Partial flight-system groundwork** exists in `thirtyone/Game.jsx` (FlyingCard component, refs, version-based effect) but isn't fully wired. User said Thirty-One is fine without flights for now.
- **`state.lastAction`** is tracked by the engine — `{ type, playerId, card? }`. No `.stamp` field (unlike Play Nine).
- 79 engine unit tests in `thirtyone/engine.test.mjs`.

## CPU pacing

- Bastra: `botActionDelay: () => 1800 + Math.random() * 1400` (1.8–3.2s), `botBetweenTurns: 500`.
- Skip-Bo: defaults, `botBetweenTurns: 700`.
- Play Nine: see above.
- Thirty-One: `botActionDelay(action, state)` — 700–1100ms drawDeck/drawDiscard, 900–1400ms discard, 800–1300ms knock; +700ms bump to each action while `state.knockBy` is set.
- **First-action head-start** (App.jsx): every CPU turn's first action gets an additional 950ms delay so the turn-announce banner (~900ms) lands before any flight animation starts.

## P2P + CPU feature

- Host-only "+ Add CPU" in all lobbies. Each CPU seat has Easy/Normal/Hard dropdown + Remove.
- **Starting a realtime room requires ≥1 other human.** Host-only-with-CPUs should funnel to "Play vs CPU" instead.
- Realtime: any client schedules the CPU turn locally, staggered by playerOrder index; optimistic write wins. Bot pauses while undo vote is open.
- **Practice setup** (home → Play vs CPU): per-CPU difficulty dropdowns. `App.jsx` state: `cpuDifficulties: string[]`, applied to each CPU's player record at `startPractice`; `scheduleCpuTurn` reads it per turn.

## Persistent rooms / rejoin

- Persistent room codes via invite links (`99ac5e2`). Auto-reconnect client conn + nudge on tab foreground (`b5dbe7c`).
- Started rooms stay in the open-rooms list (`c8389e5`) so accidentally-closed players can find their way back. Realtime joiner checks `profileId` on join and reclaims the existing seat or rejects "game already in progress" for strangers.

## Known issues / open

- **Play Nine full opponent-flight system not yet ported.** See Pending task.
- **`vs_human` Supabase column** — schema migration not applied; cloud stats ignore the flag. Local stats filter works.
- **Legacy `net.js`** still in tree — unused by App.jsx but not deleted.

## User preferences + feedback trail

- **Never auto-commit.** Only commit+push when explicitly asked ("commit and push" / "push"). Global memory at `C:\Users\Michael\.claude\projects\C--Users-Michael-SB-App\memory\feedback_commits.md`.
- **"push" means push to PROD** (fast-forward origin/main to the branch tip). Vercel auto-deploys from `main`. Confirm if ambiguous.
- Commit messages: imperative, focus on "why" not "what". Co-authored tag at bottom.
- Animation philosophy: **directive motion** — user wants to SEE cards traveling from source to destination, not pop into place. Self moves = tap feedback is clear, no extra animation needed. Opponent moves = explicit flight overlay.
- Every "container" / "box" / "outline" around a flight card is a regression — keep flight wrappers transparent, no panel styling leakage.
- Slow opponent flight animations over fast ones (user feedback: ~800ms per flight reads well).
- Preference: "full system" when asked to port animations. Don't offer a cheap minimum.
- Bastra: "OPA!" banner, horizontal stacked summary rows, quieter Good-10/Good-2 celebration.
- Play Nine card art: match the physical cards.

## Testing workflow

- Preview server: `localhost:5173` via `npm run dev` (vite). Tools: `mcp__Claude_Preview__preview_*` — `preview_list` for `serverId`. Screenshot tool **frequently times out during running Skip-Bo animations** (CSS transitions block the screenshot thread) — prefer `preview_eval` to inspect DOM / computed styles, or ask the user for a screenshot or screen recording.
- For video feedback, user can send individual frames as images (Read tool handles PNG/JPG/GIF). Can't play MP4/WebM directly — ask for ffmpeg-extracted frames or an animated GIF.
- To demo a round reveal without playing a full match: temporarily add a `window.__practice = { setState, getState }` helper in `App.jsx`'s `startPractice`. Currently stripped; re-add for debugging, remove before committing.
- Tests: `node src/games/thirtyone/engine.test.mjs` (79 tests), `node src/games/playnine/engine.test.mjs` (217 tests). Skip-Bo / Bastra have no engine tests.
- **Always clear pending setTimeouts before injecting state** (`for (let i = 0; i < lastId; i++) clearTimeout(i)`), otherwise the CPU scheduler clobbers the injected state within seconds.

## Recent commits (reverse chronological)

- `73b096e` Skip-Bo directive animations, cross-game polish (flight overlay, tap-to-discard in Play Nine, layout changes, tap-sensitivity fix, banner timing)
- `e1eb258` Add Thirty-One (Scat) + scoring-game reveal polish
- `7d95efc` Refresh CLAUDE.md
- `a0a81c2` Port Skip-Bo undo vote to realtimeNet
- `62c0363` / `caea83e` / `6ebb346` / `eada4f9` / `6ab2f5e` / `c42abe9` / `22d68df` Play Nine card-face polish iterations
- `496c9f4` Play Nine: scorecard grid reveal
- `81ce0e9` Play Nine: per-player Undo
- `e5cc7d8` Play Nine: card flip animations + deck pulse
- `7412cef` Play Nine: Easy/Hard CPU bots
- `028ea57` Add Play Nine
- `c8389e5` Keep started rooms visible for mid-game rejoin
- `ca1f93f` Poll rooms row as primary sync, Realtime best-effort
- `6dcc7dc` Move networking off PeerJS to Supabase Realtime + Postgres
- `99ac5e2` Persistent room codes + graceful host reconnect
- `acdffa5` Bastra: fix end-of-round crash

## Pending task (on resume)

**Port the full opponent-flight overlay system to Play Nine.** User explicitly confirmed "full system" (same treatment as Skip-Bo):

- Refs: `deckRef`, `discardRef`, `oppPanelRefs[id]`, `oppGridSlotRefs[${id}:${slot}]`.
- Detect opponent actions via `state.lastAction.stamp` changes (engine already tracks this via commit `e1eb258`).
- Flights to render:
  - `drawDeck` / `drawDiscard`: source → opp panel (or wherever we want to represent their hand).
  - `replace`: drawn card → grid slot (occlude that slot during flight; show previous card until flight lands). Separately, the replaced card → discard pile (occlude discard).
  - `discardAndFlip`: drawn card → discard (occlude); grid slot flips.
  - `skip`: drawn card → discard (no grid change).
- Occlusion: grid slot and discard pile show pre-action state during relevant flights.
- Suppress existing `.flipping-in` / `.p9-placed` / `.p9-drawn-from-*` animations on opponent cards — redundant with the flight.
- Reuse patterns from Skip-Bo (flight wrapper, cubic-bezier no-overshoot, `FLIGHT_MS = 800ms`, `prevStateRef` for state-diff detection, `useLayoutEffect` to occlude in the same paint as the state update).
- Turn banner delay already exists conceptually (App.jsx CPU head-start) — verify Play Nine has an equivalent banner and that flights finish before the next banner fires.

Thirty-One partial groundwork is in `thirtyone/Game.jsx` but the user said it's fine as-is (no user-facing flight animation needed). Leave it unless they ask.
