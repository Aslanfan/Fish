import { CARD_SET, FULL_DECK, SET_CARDS, SET_IDS, type Card, type SetId } from "./cards";
import { mulberry32, shuffle } from "./rng";

export type Seat = number;
export type Team = 0 | 1;
/** Maps each card of a set to the seat the declarer says holds it. */
export type Assignment = Record<Card, Seat>;

export interface Config {
  /** Must be even. Seats alternate teams around the table (seat % 2). Cards are dealt round-robin. */
  playerCount: number;
  /** First team to this many sets wins. */
  setsToWin: number;
  /** A fixed seat, or "random". */
  firstPlayer: "random" | Seat;
}

export const DEFAULT_CONFIG: Config = { playerCount: 6, setsToWin: 5, firstPlayer: "random" };

export type Phase = "playing" | "forced-declaration" | "finished";

export interface DeclaredSet {
  setId: SetId;
  by: Seat;
  assignment: Assignment;
  correct: boolean;
  awardedTo: Team;
}

export type GameEvent =
  | { type: "ask"; by: Seat; to: Seat; card: Card; success: boolean }
  | { type: "declare"; by: Seat; setId: SetId; assignment: Assignment; correct: boolean; awardedTo: Team }
  | { type: "forced-declaration"; reason: "one-team-out" | "no-asks-possible" }
  | { type: "game-over"; winner: Team };

export interface GameState {
  config: Config;
  /** Authoritative hidden state. Never send this to clients; use viewFor(). */
  hands: Card[][];
  turn: Seat | null;
  phase: Phase;
  declared: DeclaredSet[];
  scores: [number, number];
  winner: Team | null;
  log: GameEvent[];
}

export type Action =
  | { type: "ask"; by: Seat; to: Seat; card: Card }
  | { type: "declare"; by: Seat; setId: SetId; assignment: Assignment };

export type Result = { ok: true; state: GameState } | { ok: false; error: string };

export const teamOf = (seat: Seat): Team => (seat % 2) as Team;
const other = (t: Team): Team => (t === 0 ? 1 : 0);
const err = (error: string): Result => ({ ok: false, error });

// ---------------------------------------------------------------- setup

export function newGame(config: Partial<Config> = {}, seed: number = Date.now()): GameState {
  const cfg: Config = { ...DEFAULT_CONFIG, ...config };
  if (cfg.playerCount < 2 || cfg.playerCount % 2 !== 0) throw new Error("playerCount must be even");
  const rng = mulberry32(seed);
  const deck = shuffle(FULL_DECK, rng);
  const hands: Card[][] = Array.from({ length: cfg.playerCount }, () => []);
  deck.forEach((card, i) => hands[i % cfg.playerCount]!.push(card));
  const first = cfg.firstPlayer === "random" ? Math.floor(rng() * cfg.playerCount) : cfg.firstPlayer;
  return fromHands(hands, first, cfg);
}

/** Build a state from explicit hands (for tests, replays, and puzzles). */
export function fromHands(hands: Card[][], turn: Seat, config: Partial<Config> = {}): GameState {
  const cfg: Config = { ...DEFAULT_CONFIG, playerCount: hands.length, ...config };
  const state: GameState = {
    config: cfg,
    hands: hands.map((h) => [...h]),
    turn,
    phase: "playing",
    declared: [],
    scores: [0, 0],
    winner: null,
    log: [],
  };
  settle(state);
  return state;
}

// ---------------------------------------------------------------- actions

export function applyAction(state: GameState, action: Action): Result {
  if (state.phase === "finished") return err("The game is over.");
  return action.type === "ask" ? applyAsk(state, action) : applyDeclare(state, action);
}

function validSeat(state: GameState, seat: unknown): seat is Seat {
  return Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) < state.config.playerCount;
}

function applyAsk(state: GameState, a: Extract<Action, { type: "ask" }>): Result {
  const { by, to, card } = a;
  if (!validSeat(state, by) || !validSeat(state, to)) return err("Unknown player.");
  if (state.phase !== "playing") return err("Nobody is left to ask; the remaining sets must be declared.");
  if (state.turn !== by) return err("It is not your turn.");
  if (!canAsk(state.hands[by]!)) return err("You hold only complete sets, so you must declare them.");
  if (teamOf(by) === teamOf(to)) return err("You cannot ask a teammate.");
  if (state.hands[to]!.length === 0) return err("That player has no cards.");
  const setId = CARD_SET[card];
  if (!setId) return err("Unknown card.");
  if (state.hands[by]!.includes(card)) return err("You already hold that card.");
  if (!state.hands[by]!.some((c) => CARD_SET[c] === setId)) {
    return err("You must hold a card in that set to ask for one.");
  }

  const s = structuredClone(state);
  const idx = s.hands[to]!.indexOf(card);
  const success = idx >= 0;
  if (success) {
    s.hands[to]!.splice(idx, 1);
    s.hands[by]!.push(card);
  } else {
    s.turn = to;
  }
  s.log.push({ type: "ask", by, to, card, success });
  settle(s);
  return { ok: true, state: s };
}

function applyDeclare(state: GameState, a: Extract<Action, { type: "declare" }>): Result {
  const { by, setId, assignment } = a;
  if (!validSeat(state, by)) return err("Unknown player.");
  const cards = SET_CARDS[setId];
  if (!cards) return err("Unknown set.");
  if (state.declared.some((d) => d.setId === setId)) return err("That set has already been declared.");
  if (!assignment || Object.keys(assignment).length !== cards.length || !cards.every((c) => c in assignment)) {
    return err("A declaration must name a holder for each card in the set.");
  }
  for (const c of cards) {
    const holder = assignment[c];
    if (!validSeat(state, holder) || teamOf(holder) !== teamOf(by)) {
      return err("A declaration can only name your own teammates (including yourself).");
    }
  }

  const s = structuredClone(state);
  const correct = cards.every((c) => s.hands[assignment[c]!]!.includes(c));
  const awardedTo = correct ? teamOf(by) : other(teamOf(by));
  const inSet = new Set(cards);
  s.hands = s.hands.map((h) => h.filter((c) => !inSet.has(c)));
  s.declared.push({ setId, by, assignment: { ...assignment }, correct, awardedTo });
  s.scores[awardedTo]++;
  s.log.push({ type: "declare", by, setId, assignment: { ...assignment }, correct, awardedTo });
  settle(s); // declaring never changes whose turn it is, except to skip a player who just ran out of cards
  return { ok: true, state: s };
}

// ---------------------------------------------------------------- settling

/** A player can ask only if some card they hold belongs to a set they don't hold in full. */
export function canAsk(hand: readonly Card[]): boolean {
  const held = new Set(hand);
  return hand.some((c) => SET_CARDS[CARD_SET[c]!]!.some((x) => !held.has(x)));
}

/** Re-derive phase and turn after any change. Mutates `s`. */
function settle(s: GameState): void {
  for (const t of [0, 1] as Team[]) {
    if (s.scores[t] >= s.config.setsToWin) return finish(s, t);
  }
  if (s.declared.length === SET_IDS.length) return finish(s, s.scores[0] > s.scores[1] ? 0 : 1);

  const cardsByTeam = [0, 0];
  s.hands.forEach((h, seat) => (cardsByTeam[teamOf(seat)]! += h.length));
  const oneTeamOut = cardsByTeam[0] === 0 || cardsByTeam[1] === 0;
  const anyoneCanAsk = s.hands.some(canAsk);
  if (oneTeamOut || !anyoneCanAsk) {
    if (s.phase !== "forced-declaration") {
      s.phase = "forced-declaration";
      s.log.push({ type: "forced-declaration", reason: oneTeamOut ? "one-team-out" : "no-asks-possible" });
    }
    s.turn = null;
    return;
  }

  s.phase = "playing";
  if (s.turn === null) {
    s.turn = s.hands.findIndex(canAsk);
  } else if (s.hands[s.turn]!.length === 0) {
    s.turn = nextTeammateWithCards(s, s.turn);
  }
}

function finish(s: GameState, winner: Team): void {
  s.phase = "finished";
  s.winner = winner;
  s.turn = null;
  s.log.push({ type: "game-over", winner });
}

/**
 * Next teammate clockwise (increasing seat number) who still has cards. They may be holding only complete
 * sets, in which case they must declare them before the game can continue.
 */
function nextTeammateWithCards(s: GameState, from: Seat): Seat {
  const n = s.config.playerCount;
  for (let k = 1; k < n; k++) {
    const seat = (from + k) % n;
    if (teamOf(seat) === teamOf(from) && s.hands[seat]!.length > 0) return seat;
  }
  throw new Error("invariant: team has cards but no teammate holds any");
}

// ---------------------------------------------------------------- views

/** Everything one player is allowed to know. This is what the server sends to that player. */
export interface PlayerView {
  seat: Seat;
  team: Team;
  config: Config;
  hand: Card[];
  handCounts: number[];
  turn: Seat | null;
  /** True when it is this player's turn but they hold only complete sets, so they must declare. */
  mustDeclare: boolean;
  phase: Phase;
  scores: [number, number];
  declared: DeclaredSet[];
  remainingSets: SetId[];
  log: GameEvent[];
  winner: Team | null;
}

export function viewFor(state: GameState, seat: Seat): PlayerView {
  const done = new Set(state.declared.map((d) => d.setId));
  return structuredClone({
    seat,
    team: teamOf(seat),
    config: state.config,
    hand: state.hands[seat]!,
    handCounts: state.hands.map((h) => h.length),
    turn: state.turn,
    mustDeclare: state.phase === "playing" && state.turn === seat && !canAsk(state.hands[seat]!),
    phase: state.phase,
    scores: state.scores,
    declared: state.declared,
    remainingSets: SET_IDS.filter((id) => !done.has(id)),
    log: state.log,
    winner: state.winner,
  });
}

/** Every ask this player may legally make right now. Works from public info plus their own hand. */
export function legalAsks(view: PlayerView): { to: Seat; card: Card }[] {
  if (view.phase !== "playing" || view.turn !== view.seat) return [];
  const targets = view.handCounts
    .map((count, seat) => ({ count, seat }))
    .filter(({ count, seat }) => count > 0 && teamOf(seat) !== view.team)
    .map(({ seat }) => seat);
  const held = new Set(view.hand);
  const heldSets = new Set(view.hand.map((c) => CARD_SET[c]!));
  const askable = [...heldSets].flatMap((id) => SET_CARDS[id]!.filter((c) => !held.has(c)));
  return targets.flatMap((to) => askable.map((card) => ({ to, card })));
}
