# Project notes — Skip-Bo / Bastra / Play Nine online

Browser card-game app hosted on Vercel (`https://skipbo-online.vercel.app`). React 18 + Vite + JavaScript (no TypeScript). **Supabase Realtime + Postgres** for multiplayer (no more PeerJS), Supabase for profiles + optional cloud stats.

## Repo layout

- `src/App.jsx` — top-level shell: phase/mode routing (home → practice-setup → lobby → game), net wiring, CPU scheduling for practice mode, stats recording, **`GameErrorBoundary`** (wraps `<Game>` so render crashes show error + component stack).
- `src/realtimeNet.js` — **current networking layer.** Supabase Realtime + Postgres, no authoritative host. Room state lives in `rooms.state` jsonb with `rooms.version` optimistic-concurrency gate. `createHost()` / `createClient()` both call `attachRoom()`. Exposes `submitAction`, `requestUndo`, `castUndoVote`, `addCpu/removeCpu/setCpuDifficulty`, `startGame`. Bot election: every non-CPU client schedules CPU actions locally staggered by playerOrder index, first optimistic UPDATE wins. Chat is ephemeral Realtime broadcast.
- `src/net.js` — **legacy PeerJS host/client, not currently used.** Kept for reference; new code goes in `realtimeNet.js`.
- `src/rooms.js` — public room list subscription + heartbeat. Rooms older than 120s are stale; started rooms stay visible for mid-game rejoin.
- `src/stats.js` — localStorage history + `recordGame(state, profileId, myId, gameType)`. `vsHuman` field (true if ≥1 other profileId at end). `computeStats(h, { vsHumanOnly: true })` filters locally. **Supabase `game_records` table doesn't have `vs_human` column yet** — cloud stats ignore the flag.
- `src/profiles.js` — Supabase profile + `recordGameForProfile` cloud sync.
- `src/games/` — each game is a self-contained module (`skipbo/`, `bastra/`, `playnine/`) exporting `{ id, name, createGame, applyAction, cpuPlan, defaultRules, minPlayers, maxPlayers, botActionDelay, botBetweenTurns, Game, Lobby }` from `index.js`.
  - `bot.js` — each has `cpuPlan(state, cpuId, difficulty = 'normal')`. Easy / Normal / Hard tiers.

## Concurrency model (realtimeNet)

- Any client submitting an action runs `applyAction` locally, then `UPDATE rooms SET state=new, version=version+1 WHERE code=? AND version=expected`. 0 rows updated ⇒ stale, refetch + drop attempt. Supabase Realtime broadcasts the write to everyone.
- **Polling is the primary sync path**; Realtime is best-effort (`ca1f93f`). `postgres_changes` and `broadcast` run on separate channels (`f54270b`). `REPLICA IDENTITY FULL` is baked into the migration (`f87cbf5`).
- Undo vote (`a0a81c2`, ported from `net.js`): every `submitAction` snapshots pre-state on the room row. `requestUndo` builds a voters list, pre-fills YES for CPUs, writes vote with deadline (15s). `castUndoVote` records vote; finalization runs inline AND on row updates so expired votes get finalized by whoever polls next. Unvoted-at-deadline = auto-YES (silent = no objection). Bot scheduling pauses while a vote is open.
- Engine-level undo (Play Nine per-player): `submitAction` special-cases `action.type === 'undo'`, passes full state through engine without snapshot wrapping.

## Bastra specifics

- Ranks 1–13, 4 suits. 52-card deck. Jacks sweep the whole table (not a Bastra). Matching-rank captures. Clearing table via non-Jack = Bastra (+10 pts default).
- Scoring at round end: 10♦ ("Good 10") = 3 pts, 2♣ ("Good 2") = 2 pts, each Ace/Jack = 1 pt, most cards (not tied) = 3 pts, Bastra = 10 pts each.
- Match ends when either a target score is hit OR after N rounds (`rules.mode = 'target' | 'rounds'`).
- **First player is randomized once per match**, not per round (`state.firstPlayer` is locked in `createGame`).

### Bastra UI highlights

- **Card rendering uses `cardmeister`** custom element. `Card.jsx` creates `<playing-card cid="...">` imperatively in a `useEffect` with NO deps — React reconciliation of the custom element was unreliable. **Known gotcha: rank 10 MUST map to `"Ten"` not `"10"` in cidFor(), or cardmeister silently renders it as Ace.**
- **Capture stacks**: layered face-down cards (count / 3, capped at 8); Bastra play-cards rendered perpendicular (rotate 90°) sandwiched between "below" and "above" face-down layers. Count badge sits to the **right** of the pile.
- **Opponent "active" state**: saturated fill (hsl 85% sat, 42% light) + bright border + subtle halo pulse. User rejected a stronger halo as "overkill" — saturation does the heavy lifting.
- **Good-card banner** (`.good-card-celebrate`): smaller, quieter version of the Bastra banner. Fires when 10♦ or 2♣ is captured. Bastra banner says "BASTRA / OPA! / +N".
- **End-of-round reveal** (`RoundReveal` in `Game.jsx`) gated by 2.8s `overlayReady` delay so final move animation plays first.
  - Phase 1 ("closeup"): human only — captures cascade one at a time; scoring cards pause + pop a chip. Bastra + most-cards bonuses pop in. Ends → summary.
  - Phase 2 ("summary"): vertical stack of per-player rows, each with YOU label → horizontal cascade of flipping captures → count → scoring chips → Round/Total.
  - Chips use singular + `×N`: "Bastra ×2", "Jack ×3". 12-card cascade cap.
- **End-of-round crash fix** (`acdffa5`): non-Jack capture that triggered round end crashed because `endRoundIfDone` sweeps leftover table to last capturer (clears `state.table`), while `animEvent` still held pre-capture shape. The reconstruction loop indexed past an empty array. Fixed in `bastra/Game.jsx`.

## Skip-Bo specifics

- Standard Skip-Bo rules. Build piles count 1→12. Discard piles stack. Stock empty = winner.
- **Pile-complete animation fix** (`a72b50d`): `completingPiles` useEffect used to cancel its own clearing timer on cleanup → every state change orphaned the entry forever → invisible (but still playable) pile slot. Fix = let the 1300ms timer run unconditionally.
- **Undo vote** — full mechanism, ported to realtimeNet in `a0a81c2`.

## Play Nine specifics

- 108-card deck: 8 each of 0..12 (104) + 4 Hole-in-One at -5. 2×4 grid per player (8 face-down to start). Flip top deck card for discard. Each player "tees off" by flipping any 2 grid cards before play.
- Turn: draw from deck or discard, then replace any grid slot (replaced → discard) OR [deck only] discard drawn card and flip a face-down. When exactly 1 face-down remains, skip is allowed (draw, discard, don't flip).
- "Putting out": revealing/replacing the 8th face-down ends play for that player; others get exactly 1 more turn, then score.
- Scoring: face-down flipped. Column pairs (top+bottom match) cancel to 0 — **except Hole-in-One, which keeps its -5**. Bonuses for multiple matching pairs of same value: 2 pairs = -10, 3 pairs = -15, 4 pairs = -20. Two H1O pairs get -10 bonus on top (total -30 for those 4 cards).
- Match default: 9 holes. Lowest cumulative wins. Dealer rotates left each hole; first player is seat to dealer's left.
- **Per-player Undo** (`81ce0e9`): engine-level — reverts the player's most recent action only. Distinct from the vote-based undo that Skip-Bo / Bastra would use. Wired via `submitAction({ type: 'undo' })`.
- **Card faces** (`eada4f9`, `6ab2f5e`): custom SVG designed to match the physical Play Nine cards — card-stock feel, color band by value, red -5 with square flag on Hole-in-One, golf-flag watermark on card back (`caea83e`, `62c0363`).
- **End-of-hole reveal**: scorecard grid (not per-player cascade — `496c9f4`). Card flip animations + deck pulse (`e5cc7d8`).
- CPU pacing: teeOffFlip 500–750ms, draw actions 900–1400ms, play actions 1100–1900ms, between turns 400ms.

## CPU pacing

- Bastra: `botActionDelay: () => 1800 + Math.random() * 1400` (1.8–3.2s), `botBetweenTurns: 500`.
- Skip-Bo: defaults, `botBetweenTurns: 700`.
- Play Nine: see above.

## P2P + CPU feature

- Host-only "+ Add CPU" in all lobbies. Each CPU seat has Easy/Normal/Hard dropdown + Remove.
- **Starting a realtime room requires ≥1 other human.** Host-only-with-CPUs should funnel to "Play vs CPU" instead.
- Realtime: any client schedules the CPU turn locally, staggered by playerOrder index; optimistic write wins. Bot pauses while undo vote is open.
- **Practice setup** (home → Play vs CPU): per-CPU difficulty dropdowns. `App.jsx` state: `cpuDifficulties: string[]`, applied to each CPU's player record at `startPractice`; `scheduleCpuTurn` reads it per turn.

## Persistent rooms / rejoin

- Persistent room codes via invite links (`99ac5e2`). Graceful reconnect: auto-reconnect client conn + nudge on tab foreground (`b5dbe7c`).
- Started rooms stay in open-rooms list (`c8389e5`) so accidentally-closed players can find their way back. Realtime joiner checks `profileId` on join and either reclaims the existing seat or rejects "game already in progress" for strangers.

## Known issues / open

- **`vs_human` Supabase column** — schema migration not yet applied; cloud stats ignore the flag. Local stats filter works.
- **Legacy `net.js`** still in tree — unused by App.jsx but not deleted.

## User preferences + feedback trail

- **Never auto-commit.** Only commit+push when explicitly asked ("commit and push" or "push"). Saved in global memory at `C:\Users\Michael\.claude\projects\C--Users-Michael-SB-App\memory\feedback_commits.md`.
- Commit messages: imperative, focus on "why" not "what". Co-authored tag at bottom.
- Prefers horizontal stacked layout for Bastra round-summary rows.
- Bastra end-of-round reveal: full animation (closeup → summary with per-player row animations), not scaled-back.
- "OPA!" as Bastra banner subtitle.
- Gold star markers on card faces = rejected; prefers quieter celebration banner.
- Play Nine card art: match physical Play Nine cards (not generic playing cards).

## Testing workflow

- Preview server: `localhost:5173` via `npm run dev` (vite). Tools: `mcp__Claude_Preview__preview_*` — `preview_list` to find `serverId`, `preview_screenshot` / `preview_eval` / `preview_snapshot` to inspect. Viewport ~534×892 (mobile-ish), so `@media (max-width: 700px)` breakpoints apply.
- To demo a round reveal without playing a full match: temporarily add a `window.__practice = { setState, getState }` helper in `App.jsx`'s `startPractice`. Currently stripped — re-add temporarily for debugging, remove before committing.
- Tests: `npm test` (check `package.json`). Play Nine has `engine.test.mjs`.
- **Always clear pending setTimeouts before injecting state** (`for (let i = 0; i < lastId; i++) clearTimeout(i)`), otherwise the CPU scheduler clobbers your injected state within seconds.

## Recent commits (reverse chronological)

- `a0a81c2` Port Skip-Bo undo vote to realtimeNet
- `62c0363` Play Nine: tune hill curve + flag proportions
- `caea83e` Play Nine: polished SVG golf flag on the card back
- `6ebb346` Play Nine: red -5 and square flag on the card back
- `eada4f9` Play Nine: cards now match the physical Play Nine card art
- `6ab2f5e` Play Nine: redesign card faces to match the physical Play Nine cards
- `496c9f4` Play Nine: replace per-player reveal with a scorecard grid
- `c42abe9` Play Nine: bigger card panes, card-stock feel, golf-flag watermark on -5
- `22d68df` Play Nine: show -5 instead of H1O on Hole-in-One cards
- `81ce0e9` Play Nine: per-player Undo for their most recent action
- `e5cc7d8` Play Nine: card flip animations + deck pulse + cascading round reveal
- `7412cef` Play Nine: add real Easy and Hard CPU bots
- `028ea57` Add Play Nine card game (2×4 golf-style, 108-card deck)
- `c8389e5` Keep started rooms visible in open-rooms list for mid-game rejoin
- `ca1f93f` Poll rooms row as primary sync path, Realtime is best-effort
- `f54270b` Split postgres_changes and broadcast onto separate Realtime channels
- `f87cbf5` Bake REPLICA IDENTITY FULL into the realtime-rooms migration
- `4e00a07` Log realtime channel status to help debug CHANNEL_ERROR
- `6dcc7dc` Move networking off PeerJS to Supabase Realtime + Postgres
- `b5dbe7c` Auto-reconnect client conn + nudge host peer on tab foreground
- `99ac5e2` Persistent room codes via invite links + graceful host reconnect
- `acdffa5` Bastra: fix end-of-round crash when capture triggers round end

## Pending task (on resume)

No open task. Branch is clean, up-to-date with origin/main. Latest work: Skip-Bo undo vote ported to realtimeNet — the legacy PeerJS net.js path was silently dead after the Realtime migration, so Skip-Bo's Undo button had stopped rendering. Full mechanism now lives on `rooms.state` with optimistic-version writes and auto-finalize-on-deadline.
