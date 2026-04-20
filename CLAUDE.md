# Project notes — Skip-Bo / Bastra online

Browser card-game app hosted on Vercel (`https://skipbo-online.vercel.app`). React 18 + Vite + JavaScript (no TypeScript). PeerJS for P2P WebRTC multiplayer, Supabase for profiles + optional cloud stats.

## Repo layout

- `src/App.jsx` — top-level shell: phase/mode routing (home → practice-setup → lobby → game), host/client net wiring, CPU scheduling for practice mode, stats recording, **`GameErrorBoundary`** (wraps `<Game>` so render crashes show error + component stack instead of blank screen).
- `src/net.js` — PeerJS host + client. Host is authoritative. `createHost()` exposes `addCpu/removeCpu/setCpuDifficulty`, `startGame`, `submitAction`, undo voting. CPU seats live in `lobby.players` with `isCpu: true` and `cpuDifficulty: 'easy'|'normal'|'hard'`.
- `src/stats.js` — localStorage history + `recordGame(state, profileId, myId, gameType)`. Includes `vsHuman` field (true if ≥1 other profileId present at end). `computeStats(h, { vsHumanOnly: true })` filters. **Does NOT send `vsHuman` to Supabase yet** — adding the field would require a `vs_human boolean` column migration on `game_records`.
- `src/profiles.js` — Supabase profile + `recordGameForProfile` cloud sync.
- `src/games/` — each game is a self-contained module.
  - `skipbo/`, `bastra/` each export `{ id, name, createGame, applyAction, cpuPlan, defaultRules, minPlayers, maxPlayers, botActionDelay, botBetweenTurns, Game, Lobby }` from `index.js`.
  - `bot.js` — each has `cpuPlan(state, cpuId, difficulty = 'normal')`. Easy = mostly random but still plays obvious captures / stock-top. Normal = current heuristics. Hard = more conservative with wilds / holds Jacks for bigger sweeps / avoids dumping scoring cards.

## Bastra specifics

- Ranks 1–13, 4 suits. 52-card deck. Jacks sweep the whole table (not a Bastra). Matching-rank captures. Clearing table via non-Jack = Bastra (+10 pts default).
- Scoring at round end: 10♦ ("Good 10") = 3 pts, 2♣ ("Good 2") = 2 pts, each Ace/Jack = 1 pt, most cards (not tied) = 3 pts, Bastra = 10 pts each.
- Match ends when either a target score is hit OR after N rounds (rules.mode = `'target'` | `'rounds'`).
- **First player is randomized once per match**, not per round (`state.firstPlayer` is locked in `createGame`).

### Bastra UI highlights

- **Card rendering uses `cardmeister`** custom element. `Card.jsx` creates `<playing-card cid="...">` **imperatively** in a `useEffect` with NO deps (runs every render) — React reconciliation of the custom element was unreliable (stale SVGs). **Known gotcha: rank 10 MUST map to `"Ten"` not `"10"` in cidFor(), or cardmeister silently renders it as Ace.**
- **Capture stacks** (`CaptureStack` component in `Game.jsx`): layered face-down cards (count / 3, capped at 8); Bastra play-cards rendered perpendicular (rotate 90°) sandwiched between "below" and "above" face-down layers for visual density. Count badge sits to the **right** of the pile (saves vertical space in opponent containers).
- **Opponent "active" state**: saturated fill (hsl 85% sat, 42% light) + bright border + subtle halo pulse. User explicitly rejected a stronger halo as "overkill" — saturation does the heavy lifting.
- **Good-card banner** (`.good-card-celebrate`): smaller, shorter-lived version of the Bastra banner. Fires when 10♦ or 2♣ is captured. Bastra banner says "BASTRA / OPA! / +N".
- **End-of-round reveal** (`RoundReveal` in `Game.jsx`) gated by a 2.8s `overlayReady` delay so the final move animation plays first.
  - **Phase 1 ("closeup")**: human player only — captures cascade in one at a time with a running tally; scoring cards pause and pop a chip. Non-scoring cards fly past. Then Bastra + Most-cards bonuses pop in. Ends → summary.
  - **Phase 2 ("summary")**: vertical stack of per-player rows, each with name/YOU label → **straight horizontal cascade** of captures flipping face-down→face-up → cards count → scoring chips → Round/Total. Mobile grid re-layout stacks everything vertically within the row.
  - Chips use singular + `×N` multiplier for plural counts: "Bastra ×2", "Jack ×3", "Ace ×2". "Most cards" stays as-is. 12-card cascade cap; overflow indicator was removed (the "N CARDS" label is sufficient).

## Skip-Bo specifics

- Standard Skip-Bo rules. Build piles count up 1→12. Discard piles allow stacking. Stock winds down until empty = winner.
- **Pile-complete animation bug** (fixed in `a72b50d`): the `completingPiles` useEffect in `skipbo/Game.jsx` used to cancel its own clearing timer on cleanup, so every subsequent state change would orphan the entry in state forever → the pile-complete card's final `opacity: 0` frame hid the whole build-pile slot (invisible but still playable). Fix = let the 1300ms timer run unconditionally.

## P2P + CPU feature

- Host-only "+ Add CPU" button in both lobbies. Each CPU seat has a difficulty dropdown (Easy/Normal/Hard) and Remove button.
- **Starting a P2P room requires ≥1 other human** (besides the host). Start button disables with "Waiting for another human player to join". Host-only-with-CPUs should funnel to "Play vs CPU" instead.
- Host runs CPU turns via the existing `scheduleBotIfNeeded` in `net.js`, which was previously only used when a human disconnected mid-game. Difficulty is read from `lobby.players[i].cpuDifficulty` at each turn.
- **Practice setup** (home → Play vs CPU → setup) also has per-CPU difficulty dropdowns. `App.jsx` state: `cpuDifficulties: string[]`, applied to each CPU's player record at `startPractice` via `g.players[id].cpuDifficulty = …`; `scheduleCpuTurn` reads it per turn.

## CPU pacing

- Bastra `botActionDelay: () => 1800 + Math.random() * 1400` (1.8–3.2s randomized think), `botBetweenTurns: 500`. Previously 3800/2400 — CPU-to-CPU was ~6.2s vs user-to-CPU ~3.8s, which felt inconsistent.
- Skip-Bo unchanged (`botActionDelay` stays at its defaults, `botBetweenTurns: 700`).

## Known issues / open

- **Intermittent end-of-Bastra-round blank screen.** User reported a crash at round end that `GameErrorBoundary` caught, but the boundary was only showing a minified Safari stack (`KHuzR2eN.js:123:97776` style) with no error message or component stack. `db1980f` added explicit error-message + React componentStack display to the boundary. **Next crash should tell us which component threw.** I could not reproduce in preview with synthetic state injection — must be specific to real-game timing or data.
- **`vs_human` Supabase column** — schema migration not yet applied; cloud stats ignore the flag. Local stats filter works.
- **No undo for Bastra** — only Skip-Bo has undo vote mechanics (`handleUndoRequest` etc. in net.js).

## User preferences + feedback trail

- **Never auto-commit.** Only commit+push when explicitly asked ("commit and push" or "push"). Saved in global memory at `C:\Users\Michael\.claude\projects\C--Users-Michael-SB-App\memory\feedback_commits.md`.
- Commit messages: imperative, focus on "why" not "what". Co-authored tag at bottom.
- Prefers horizontal stacked layout for round-summary rows (reverted from a short-lived horizontal-player-columns experiment).
- For end-of-round reveal: user requested full animation (closeup → summary with per-player row animations), not scaled-back.
- "OPA!" as the Bastra banner subtitle (instead of "{Name} swept the table!").
- Gold star markers on card faces for scoring cards = rejected. Preferred: smaller banner on capture (like Bastra's but quieter). The `Good 10 / Good 2` celebration lives at `goodCardEvent` in `Game.jsx` + `.good-card-celebrate` CSS.

## Testing workflow

- Preview server: `localhost:5173` via `npm run dev` (vite). Tools use `mcp__Claude_Preview__preview_*` — `preview_list` to find `serverId`, `preview_screenshot` / `preview_eval` / `preview_snapshot` to inspect. Viewport is ~534×892 (mobile-ish) so mobile CSS breakpoints (`@media (max-width: 700px)`) apply.
- To demo the round reveal without playing a full match: previous sessions temporarily added a `window.__practice = { setState, getState }` helper in `App.jsx`'s `startPractice` for state injection. It's been stripped — re-add temporarily if needed for debugging, then remove before committing.
- Running tests: `npm test` (if any) — check `package.json`.
- **Always clear pending setTimeouts before injecting state** (`for (let i = 0; i < lastId; i++) clearTimeout(i)`), otherwise the CPU scheduler clobbers your injected state within seconds.

## Recent commits (reverse chronological, recent first)

- `db1980f` Show error message + component stack in game crash screen
- `a72b50d` Skip-Bo: fix invisible pile slot after a build pile completes
- `a576f9c` Faster (and randomized) Bastra CPU pacing + render error boundary
- `ea81572` Fix Bastra "By rounds" dropdown in practice setup
- `c4293da` CPU players in P2P rooms + Easy/Normal/Hard difficulty
- `d91fc9a` Bastra polish: card backs, capture stacks, round-end reveal
- `3f998d4` Separate played-card animation; laid-down Jack; single empty-slot
- `fd51f7e` Bastra UX pass: card fix, layout, animations, rules

## Pending task (on resume)

**Awaiting user retest** — after they hit the blank-screen Bastra round-end crash again with the updated error boundary (`db1980f`), the screen should now display the actual error name/message and React component stack. With that info, fix whichever `<RevealRow>`/`<SelfCloseup>`/`<CaptureCascade>` is throwing. Most likely candidates:
- A `useEffect` in `SelfCloseup` setting state after onDone transitions the parent (stale ref)
- `CaptureCascade` receiving a `captures` array with a malformed card (unlikely since engine is strict)
- `RevealRow`'s rAF callback firing after unmount (already cleaned with `cancelAnimationFrame`, but worth double-checking)
