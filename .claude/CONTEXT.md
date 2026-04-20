# Skip-Bo Online — Project Context

Context snapshot for resuming work in a new Claude session.

## What this is

Browser-based Skip-Bo (Mattel card game) playable online with friends via
peer-to-peer WebRTC. No backend — host runs the game state in their
browser, clients connect via PeerJS signaling. Mobile-first, free to host
on Vercel.

Repo: https://github.com/mike-BBI/skipbo-online
Deploy: Vercel, auto-deploys from `main`
Domain: `skipbo-online.vercel.app` (or similar — check Vercel dashboard)

## Stack

- Vite + React (no framework), pure JS (no TS)
- PeerJS for WebRTC signaling (free public server `0.peerjs.com` by default)
- All state in localStorage (profile, history)
- Zero backend, zero monthly cost

## File structure

```
src/
  App.jsx             — top-level router (home/practice-setup/lobby/game/stats)
  engine.js           — pure game engine: buildDeck, createGame, applyAction
  engine.test.mjs     — Node smoke tests (run `node src/engine.test.mjs`)
  bot.js              — CPU player logic (cpuPlan)
  net.js              — PeerJS host/client, bot takeover on drop, reconnection
  stats.js            — profile, history, computeStats (localStorage)
  Game.jsx            — gameplay UI: build piles, stock, discards, hand, drag-drop
  Lobby.jsx           — multiplayer lobby (name, rules, chat, start)
  Stats.jsx           — profile + lifetime stats + recent games
  Card.jsx            — Card / EmptySlot / Stockpile / DiscardPile / Deck / MiniHand
  Chat.jsx            — chat message list + input
  styles.css          — all styling, including mobile @media
.claude/launch.json   — preview server config (vite on 5173)
vercel.json           — SPA rewrites for Vercel
```

## What's built (all done)

- Full Skip-Bo engine: 162-card deck, rules-compliant, verified via tests
- Multi-deck auto-scaling when player × stock > one deck capacity
- Bot CPU with greedy strategy (stock > discards > hand, saves wilds)
- Practice vs CPU (1-7 opponents) with configurable rules
- Online multiplayer (2-8 players) via PeerJS rooms
- Lobby: name entry, rules editing, chat, start button
- In-game chat (hidden in practice mode)
- Profiles (localStorage): id, name, color, createdAt
- Game history recorded on win; lifetime stats (games, wins, win%, avg turns, etc.)
- Reconnection: matches by profileId, reclaims bot-controlled seat
- Bot takeover: if a non-host player drops mid-game, CPU plays their turns
- Host disconnect = game ends (migration intentionally skipped as too complex)
- Drag-and-drop cards (pointer events, works mobile + desktop), tap-to-select still works
- Card art: custom CSS, matches real Skip-Bo (purple/green/pink groups, wild design,
  SB badges, card back with blue/red diagonal + SKIP-BO text)
- Mobile layout: horizontal-scroll opponents, compact cards, shrunk discards
- Discard piles: tight cascade by default, tap to expand
- Animations: staggered hand deal, card fly-in on build/discard pile changes,
  active-opponent gold pulse, active opponent rotates to leftmost slot
- CPU move pacing: 1500ms plays, 1800ms discards, 900ms between turns
- Connection diagnostic: status dot (green=connected, yellow=connecting, red=error)
  visible on home + lobby screens
- Typed error messages for common PeerJS failures (peer-unavailable, network, etc.)

## Open issue (unresolved, waiting on user decision)

**Some users can't connect to hosted games** — specifically one user
consistently fails with "Negotiation of connection to [peer-id] failed"
even though signaling (reaching `0.peerjs.com`) works fine.

Root cause: their network (likely corporate/carrier-grade NAT or strict
firewall) blocks direct WebRTC peer-to-peer. The current setup relies on
OpenRelay free public TURN servers (`openrelay.metered.ca`) as fallback,
but that free service is unreliable — sometimes works, sometimes doesn't.

Current config (in `src/net.js`):
```js
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};
```

### Decision pending from user

Choose between:

1. **Option A**: Bump timeout, retry with iceTransportPolicy:'relay', hope
   OpenRelay stabilizes. Free, flaky.

2. **Option B**: Get proper TURN credentials and wire them in. Still free
   at our scale. User needs to sign up:
   - **Cloudflare Realtime TURN** (recommended) — free 1 TB/month, has
     Cloudflare account already likely
   - **Metered free tier** — 500 MB/month, smaller signup
   - **Self-hosted coturn** on a $5/mo VPS — real control

User preferred Cloudflare but hasn't signed up / provided credentials yet.
Next step: when they provide the credentials, replace the OpenRelay block
in `PEER_CONFIG` with the real ones. See
https://developers.cloudflare.com/calls/turn/ for current instructions.

## Other backlog (user-acknowledged, deprioritized)

- **Presence / online-friends list / invite-by-name**: discussed, user
  chose to defer. Requires a real backend (Supabase free tier recommended
  if revisited). Current alternative is shareable invite URLs which
  haven't been built yet — would be trivial (add `?join=CODE` query
  param handling on home screen).
- **Full card flight animations** (card visibly traveling from deck to
  hand, hand to build pile, etc.): partial implementation done (staggered
  deal animation + fly-in on build/discard pile changes). Full
  source-to-destination flight not built; user OK with current.
- **Host migration on host drop**: explicitly decided against. Too
  complex for P2P architecture. Game ends if host drops.
- **Team play / tournament scoring**: listed as unimplemented official
  Skip-Bo variants; low priority.

## User preferences captured along the way

- Wants app to play exactly like a real game (correctness over
  optimization)
- $0 cost, no backend
- Mobile-first, vertical space is premium
- Subtle visual design — "slightly rounded" not fully, hand cards bigger
  than opponents', discards tight by default expand on tap
- Font: Lilita One for numbers on cards, Fredoka One for card back and
  wild card SKIP-BO text
- Colors: purple (1-4, `#312e81` indigo), green (5-8, `#16a34a`),
  pink (9-12, `#db2777`)
- Lobby title: "Mav Family Skip-Bo" (renamed from "Skip-Bo")
- Underline on 6 cards is thin in opponent mini view but still present

## How to run / deploy

```bash
npm install
npm run dev        # localhost:5173
npm run build      # builds to dist/
node src/engine.test.mjs   # engine unit tests
```

Deploy: push to `main`, Vercel auto-deploys. Build command `npm run build`,
output dir `dist`.

## Recent commits (tail of history)

- `f863ea5` Add free TURN servers for NAT traversal
- `cd84c27` Add peer connection diagnostic UI + rename lobby title
- `71a06bd` Fix host's rule dropdowns not updating own UI
- earlier: drag-and-drop, stats, animations, mobile layout, ...
