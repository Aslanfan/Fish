# Library game (Fish / Library / Russian Library)

Online, real-time, mobile-friendly card game for friends. 6 players, 2 teams of 3, 54 cards (52 + 2 jokers).
Owner: Caleb. Comfortable with hands-on technical work; wants to stay hands-on with the code.

## Decisions already made (don't re-litigate; ask first if something needs to change)

- Web app first, mobile-first (touch targets, portrait layout, no hover-only interactions). Aim for a PWA.
  App stores are a possible later step (e.g. Capacitor), not now.
- Main mode: real-time online play with friends, one player creates a room and shares a code or link.
- Does NOT want to run/maintain his own server right now.
- Bots: a secondary mode, mainly for playtesting. Bots must not trounce humans (the game is partly memory).
  Caleb's design idea: bots have a limited number of memory registers for deductions/events, and difficulty
  scales with register count, lapse rate, and quality of prioritization logic.
- 6 players for now. Other game modes may be tried later in private testing, so keep player count, teams,
  set definitions, and win threshold in config rather than hard-coded.

## Leaning, not final (my recommendations, open to discussion)

- Server-authoritative: the engine runs on the server and each client only receives its own `PlayerView`.
  Never send `GameState` (it contains every hand) to a client.
- Hosting on a managed realtime platform (Cloudflare Durable Objects or PartyKit; one object per room)
  rather than peer-to-peer, because mobile hosts get backgrounded and drop the game. Check current pricing/limits.
- Client: Svelte or React + Vite, cards drawn with CSS/SVG, a public game log (central to deduction).
- Reconnection handling matters a lot on mobile (sockets drop when the phone locks).

## Rules (implemented in src/engine.ts, covered by test/engine.test.ts)

- 9 sets of 6 cards: 2-7 and 9-A in each suit, plus the four 8s and both jokers. Jokers are distinct cards.
- Seats alternate teams (seat % 2). First team to 5 sets wins.
- Ask: your turn, an opponent who has cards, a card you don't hold, from a set you hold a card in.
  Hit: keep the turn. Miss: the player you asked gets the turn.
- Declare: anyone, any time, regardless of turn or whether they hold cards in the set. Name a holder (a
  teammate or yourself) for every card. Fully correct: point to the declarer's team. Otherwise: point to the
  other team. The set leaves play either way. Declaring doesn't change whose turn it is.
- Out of cards on your turn: turn goes to the next teammate clockwise who has cards.
- Holding only complete sets (nothing to ask for): you keep the turn but must declare them; a teammate may
  declare for you. See `PlayerView.mustDeclare`.
- If only one team has cards left, or nobody can ask: phase `forced-declaration`; no more asks, the remaining
  sets must be declared.
- Starting player: random by default (configurable).

## Architecture

- `src/engine.ts` is a pure rules module: `applyAction(state, action)` returns a new state or an error. No
  I/O, no networking, no randomness except the seeded RNG used for dealing. Keep it that way: server,
  bots, tests, and replays all call the same function.
- `viewFor(state, seat)` is the only thing that should cross the network to a client.
- `legalAsks(view)` works from a view, so bots can only use information a human could have.
- `src/sim.ts` plays whole random games and checks invariants every step.

## Commands

- `npm test` runs unit tests and simulated games. `npm run sim 1000` runs 1000 games. `npm run typecheck`.
- `npm run dev` serves `web/`, a local playtest page (you + 2 bots vs 3 bots, engine in the browser, no server).
  It is vanilla TS for now; the real client framework is still open.
- `src/bots/deduction.ts`: bots remember deductions in a fixed number of registers (Caleb's design). One
  register per card ("Nora has the 3♥", or "not Max, not Iris") and one per seat+set ("Nora holds n more low
  hearts I can't name"). Own hand, card counts, and reasoning over registers are free. Difficulty knobs:
  registers, lapse (ask not taken in), blunder (random ask), prioritize (what to evict), nerve (odds needed to
  declare; halves when a game stalls). Easy has at least 6 registers (one full set). Nightmare is unlimited.
  `src/bots/runner.ts` decides which bot acts next.

## Conventions

- Any rule change comes with a test. Run `npm test` and `npm run typecheck` before finishing a task.
- Keep the engine dependency-free.

## Suggested next steps (in rough order)

1. Set up git, commit this baseline.
2. First bot (`src/bots/`): start with a random legal-move bot plus a simple deduction bot, then Caleb's
   memory-register design. Use bot-vs-bot simulation to tune difficulty.
3. Transport/rooms layer (room codes, seats, teams, reconnection), using the platform decision above.
4. Mobile-first client UI.
