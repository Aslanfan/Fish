import { CARD_SET, SET_CARDS, type Card, type SetId } from "../cards";
import { legalAsks, teamOf, type Action, type GameEvent, type PlayerView, type Seat } from "../engine";
import { mulberry32, pick, type Rng } from "../rng";

export interface BotOptions {
  /** How many notes (see Note) the bot can hold at once. Its own hand and the card counts are free. */
  registers: number;
  /** Chance that the bot doesn't take in an ask at all. */
  lapse: number;
  /** Chance per ask of ignoring what it knows and asking something random (but legal). */
  blunder: number;
  /** When memory is full, drop the least useful note (true) or simply the stalest (false). */
  prioritize: boolean;
  /** Lowest odds of being right at which it will declare. 1 = only when sure. */
  nerve: number;
}

export type Difficulty = "easy" | "normal" | "hard" | "nightmare";
export const DIFFICULTY: Record<Difficulty, BotOptions> = {
  easy: { registers: 6, lapse: 0.25, blunder: 0.15, prioritize: true, nerve: 0.5 },
  normal: { registers: 10, lapse: 0.1, blunder: 0.05, prioritize: true, nerve: 1 },
  hard: { registers: 16, lapse: 0.03, blunder: 0, prioritize: true, nerve: 1 },
  nightmare: { registers: Infinity, lapse: 0, blunder: 0, prioritize: true, nerve: 1 },
};

/**
 * One register of memory. "Nora has the 3 and 4 of low hearts, plus more I can't name" is three notes.
 * - card: who holds one card or, if the bot doesn't know, who it has ruled out.
 * - set: at least how many cards of a set a seat holds beyond the ones the bot has placed.
 */
export type Note =
  | { kind: "card"; card: Card; holder: Seat | null; notWith: Set<Seat>; touched: number }
  | { kind: "set"; seat: Seat; setId: SetId; atLeast: number; touched: number };

export interface Knowledge {
  /** For each card still in play, the seats that might hold it. Can be wrong if the bot lapsed. */
  possible: Map<Card, Set<Seat>>;
  /** `${seat}:${setId}` -> at least this many cards of that set held by that seat beyond the placed ones. */
  atLeast: Map<string, number>;
}

type AskEvent = Extract<GameEvent, { type: "ask" }>;

function declaration(by: Seat, setId: SetId, holders: Seat[]): Action {
  return { type: "declare", by, setId, assignment: Object.fromEntries(SET_CARDS[setId]!.map((c, i) => [c, holders[i]!])) };
}

/**
 * Plays only from its own PlayerView, remembering what it has seen in a limited number of registers.
 * Never declares unless it believes it is sure, except when the rules force a guess.
 */
export class DeductionBot {
  private rng: Rng;
  private notes = new Map<string, Note>();
  /** Log entries already taken in. */
  private seen = 0;
  private clock = 0;

  constructor(readonly seat: Seat, readonly opts: BotOptions = DIFFICULTY.normal, seed: number = seat + 1) {
    this.rng = mulberry32(seed);
  }

  get memory(): Note[] {
    return [...this.notes.values()];
  }

  // ---------------------------------------------------------------- remembering

  /** Take in log entries since the last call. Every decision method calls this first. */
  observe(view: PlayerView): void {
    for (; this.seen < view.log.length; this.seen++) {
      const e = view.log[this.seen]!;
      this.clock++;
      if (e.type === "declare") this.forgetSet(e.setId);
      else if (e.type === "ask" && this.rng() >= this.opts.lapse) this.learn(e);
    }
    this.prune(view);
    while (this.notes.size > this.opts.registers) this.evict(view);
  }

  private learn(e: AskEvent): void {
    const { by, to, card, success } = e;
    const setId = CARD_SET[card]!;
    const note = this.cardNote(card);
    if (success) {
      if (note.holder !== to) this.lowerSet(to, setId); // one of the cards I couldn't place left `to`
      note.holder = by;
      note.notWith.clear();
    } else {
      if (note.holder === by || note.holder === to) note.holder = null; // what I remembered was wrong
      note.notWith.add(by);
      note.notWith.add(to);
    }
    // Asking proves `by` holds another card of that set; only worth noting if I can't already name one.
    if (!this.placedWith(by, setId, card)) this.raiseSet(by, setId);
  }

  private cardNote(card: Card): Extract<Note, { kind: "card" }> {
    const key = `c:${card}`;
    let n = this.notes.get(key);
    if (!n || n.kind !== "card") {
      n = { kind: "card", card, holder: null, notWith: new Set(), touched: this.clock };
      this.notes.set(key, n);
    }
    n.touched = this.clock;
    return n;
  }

  private raiseSet(seat: Seat, setId: SetId): void {
    if (seat === this.seat) return;
    const key = `s:${seat}:${setId}`;
    const n = this.notes.get(key);
    if (n?.kind === "set") {
      n.atLeast = Math.max(n.atLeast, 1);
      n.touched = this.clock;
    } else {
      this.notes.set(key, { kind: "set", seat, setId, atLeast: 1, touched: this.clock });
    }
  }

  private lowerSet(seat: Seat, setId: SetId): void {
    const key = `s:${seat}:${setId}`;
    const n = this.notes.get(key);
    if (n?.kind === "set" && --n.atLeast <= 0) this.notes.delete(key);
  }

  private placedWith(seat: Seat, setId: SetId, except: Card): boolean {
    return [...this.notes.values()].some((n) => n.kind === "card" && n.holder === seat && n.card !== except && CARD_SET[n.card] === setId);
  }

  private forgetSet(setId: SetId): void {
    for (const [key, n] of this.notes) {
      if ((n.kind === "card" ? CARD_SET[n.card] : n.setId) === setId) this.notes.delete(key);
    }
  }

  /** Drop notes that tell me nothing my hand and the card counts don't. */
  private prune(view: PlayerView): void {
    const hand = new Set(view.hand);
    for (const [key, n] of this.notes) {
      const useless = n.kind === "card"
        ? hand.has(n.card) || (n.holder === null && [...n.notWith].every((s) => s === this.seat || view.handCounts[s] === 0))
        : view.handCounts[n.seat] === 0;
      if (useless) this.notes.delete(key);
    }
  }

  private evict(view: PlayerView): void {
    let worst: string | null = null;
    let worstValue = Infinity;
    for (const [key, n] of this.notes) {
      const v = this.value(n, view);
      if (v < worstValue) { worst = key; worstValue = v; }
    }
    this.notes.delete(worst!);
  }

  private value(n: Note, view: PlayerView): number {
    const recency = n.touched / (this.clock + 1);
    if (!this.opts.prioritize) return recency;
    const setId = n.kind === "card" ? CARD_SET[n.card]! : n.setId;
    const canAskInSet = view.hand.some((c) => CARD_SET[c] === setId) ? 2 : 0;
    const strength = n.kind === "set" ? 0.75 : n.holder !== null ? 1 : 0.25 * n.notWith.size;
    return canAskInSet + strength + recency;
  }

  // ---------------------------------------------------------------- reasoning (free: uses no registers)

  knowledge(view: PlayerView): Knowledge {
    this.observe(view);
    const seats = view.handCounts.map((_, s) => s);
    const others = seats.filter((s) => s !== view.seat);
    const withCards = others.filter((s) => view.handCounts[s]! > 0);
    const hand = new Set(view.hand);

    const possible = new Map<Card, Set<Seat>>();
    for (const id of view.remainingSets) {
      for (const c of SET_CARDS[id]!) possible.set(c, new Set(hand.has(c) ? [view.seat] : withCards));
    }
    const atLeast = new Map<string, number>();
    for (const n of this.notes.values()) {
      if (n.kind === "set") {
        atLeast.set(`${n.seat}:${n.setId}`, n.atLeast);
        continue;
      }
      const p = possible.get(n.card);
      if (!p || hand.has(n.card)) continue;
      if (n.holder !== null && withCards.includes(n.holder)) {
        p.clear();
        p.add(n.holder);
      } else {
        for (const s of n.notWith) p.delete(s);
        if (p.size === 0) for (const s of withCards) p.add(s); // memory contradicted by the facts: start over
      }
    }

    for (let changed = true; changed; ) {
      changed = false;
      for (const s of others) {
        // A seat whose placed cards fill its hand holds nothing else; one with exactly as many candidate
        // cards as cards in hand holds all of them.
        const count = view.handCounts[s]!;
        const candidates = [...possible.values()].filter((p) => p.has(s));
        const placed = candidates.filter((p) => p.size === 1).length;
        if (placed >= count) {
          for (const p of candidates) if (p.size > 1 && p.delete(s)) changed = true;
        } else if (candidates.length <= count) {
          for (const p of candidates) if (p.size > 1) { p.clear(); p.add(s); changed = true; }
        }
      }
      // A set note means the seat holds the cards my notes place with it plus n more. If that is every card of
      // the set it could hold, it holds them all.
      for (const n of this.notes.values()) {
        if (n.kind !== "set") continue;
        const cards = SET_CARDS[n.setId]!.filter((c) => possible.get(c)?.has(n.seat));
        const noted = cards.filter((c) => { const m = this.notes.get(`c:${c}`); return m?.kind === "card" && m.holder === n.seat; });
        if (cards.length > noted.length + n.atLeast) continue;
        for (const c of cards) {
          const p = possible.get(c)!;
          if (p.size > 1) { p.clear(); p.add(n.seat); changed = true; }
        }
      }
    }
    return { possible, atLeast };
  }

  // ---------------------------------------------------------------- deciding

  /**
   * The set it is likeliest to declare correctly, if its odds (treating each card's possible holders as
   * equally likely) reach its nerve. With nerve 1 that means every card is placed with its own team.
   */
  confidentDeclaration(view: PlayerView): Action | null {
    const { possible } = this.knowledge(view);
    let best: { setId: SetId; holders: Seat[]; odds: number } | null = null;
    for (const setId of view.remainingSets) {
      let odds = 1;
      const holders: Seat[] = [];
      for (const c of SET_CARDS[setId]!) {
        const p = possible.get(c)!;
        const ours = [...p].filter((s) => teamOf(s) === view.team);
        if (!ours.length) { odds = 0; break; }
        odds /= p.size;
        holders.push(ours[0]!);
      }
      if (odds >= this.nerveNow(view) && (!best || odds > best.odds)) best = { setId, holders, odds };
    }
    return best && declaration(view.seat, best.setId, best.holders);
  }

  /** Its nerve, halved after 60 asks with no declaration and again every 30 more, so stuck games end. */
  private nerveNow(view: PlayerView): number {
    let quiet = 0;
    for (let i = view.log.length - 1; i >= 0 && view.log[i]!.type !== "declare"; i--) if (view.log[i]!.type === "ask") quiet++;
    return quiet < 60 ? this.opts.nerve : this.opts.nerve / 2 ** (1 + Math.floor((quiet - 60) / 30));
  }

  /** The ask most likely to hit. */
  chooseAsk(view: PlayerView): Action | null {
    const { possible, atLeast } = this.knowledge(view);
    const asks = legalAsks(view);
    if (!asks.length) return null;
    if (this.rng() < this.opts.blunder) return { type: "ask", by: view.seat, ...pick(asks, this.rng) };

    let best: typeof asks = [];
    let bestScore = -1;
    for (const a of asks) {
      const p = possible.get(a.card)!;
      let score = 0;
      if (p.has(a.to)) {
        score = 1 / p.size;
        const setId = CARD_SET[a.card]!;
        const n = atLeast.get(`${a.to}:${setId}`) ?? 0;
        if (n > 0) {
          const pool = SET_CARDS[setId]!.filter((c) => { const q = possible.get(c)!; return q.size > 1 && q.has(a.to); }).length;
          score = Math.max(score, n / Math.max(pool, 1));
        }
      }
      if (score > bestScore + 1e-9) { best = [a]; bestScore = score; }
      else if (Math.abs(score - bestScore) <= 1e-9) best.push(a);
    }
    return { type: "ask", by: view.seat, ...pick(best, this.rng) };
  }

  /** Forced-declaration phase: declare the set it is most sure of, guessing where it has to. */
  guessDeclaration(view: PlayerView): Action | null {
    const { possible } = this.knowledge(view);
    const team = view.handCounts.map((_, s) => s).filter((s) => teamOf(s) === view.team && view.handCounts[s]! > 0);
    if (!team.length || !view.remainingSets.length) return null;
    let best: { setId: SetId; holders: Seat[]; sure: number } | null = null;
    for (const setId of view.remainingSets) {
      let sure = 0;
      const holders = SET_CARDS[setId]!.map((c) => {
        const mine = [...possible.get(c)!].filter((s) => team.includes(s));
        if (mine.length === 1) sure++;
        return mine.length ? pick(mine, this.rng) : pick(team, this.rng);
      });
      if (!best || sure > best.sure) best = { setId, holders, sure };
    }
    return declaration(view.seat, best!.setId, best!.holders);
  }
}
