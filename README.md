# Library game: rules engine

Pure TypeScript rules engine for the 6-player team card game (Fish / Library / Russian Library).
No networking, no UI. A server, a bot, or a test calls the same function.

```
npm install
npm test            # unit tests + simulated full games
npm run sim 1000    # play 1000 random games, check invariants every step
npm run dev         # play against the bots in your browser
npm run phone       # same, over https on your Wi-Fi, for testing on a phone (accept the certificate warning)
```

## Shape

- `newGame(config, seed)` -> `GameState` (authoritative, hidden hands; never send to clients)
- `applyAction(state, action)` -> `{ ok: true, state } | { ok: false, error }` (never mutates)
- `viewFor(state, seat)` -> `PlayerView` (what that player may see: own hand, card counts, public log)
- `legalAsks(view)` -> every legal `{ to, card }` for that player (works from a view, so bots can use it)
- Actions: `{ type: "ask", by, to, card }` and `{ type: "declare", by, setId, assignment }`

## Rules implemented

- 54 cards, 9 sets of 6: 2-7 and 9-A in each suit, plus the 8s and both jokers. Jokers are distinct cards.
- Seats alternate teams (even seats vs odd seats). First team to 5 sets wins.
- Ask: your turn, an opponent who has cards, a card you do not hold, from a set you hold a card in.
  A hit keeps your turn; a miss passes the turn to the player you asked.
- Declare: anyone, any time, whether or not it is their turn or they hold cards in the set. Name a
  teammate (or yourself) for each card. Fully correct scores for the declarer's team; anything else
  scores for the other team. The set leaves play either way. Declaring does not change whose turn it is.
- If it would be a player's turn but they cannot take it, it goes to the next teammate clockwise.
- If only one team has cards left, nobody can ask: phase becomes `forced-declaration`.

- A player whose hand is only complete sets keeps the turn but cannot ask: they must declare (a teammate
  can declare for them). `PlayerView.mustDeclare` tells the UI. Once their hand is empty the turn goes to
  the next teammate clockwise who has cards.
- If nobody on either team can ask, the phase is `forced-declaration`.

## Decisions I made where the rules were silent (easy to change)

- A declaration may only name teammates (including the declarer).
- First player is random (`firstPlayer: "random"`), or set a seat.
