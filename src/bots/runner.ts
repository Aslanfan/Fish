import { teamOf, viewFor, type Action, type GameState, type Seat } from "../engine";
import type { DeductionBot } from "./deduction";

/**
 * The next thing any bot wants to do, or null if the game is waiting on a human (or over).
 * Seats missing from `bots` are humans.
 */
export function nextBotAction(state: GameState, bots: ReadonlyMap<Seat, DeductionBot>): Action | null {
  if (state.phase === "finished") return null;

  // Anyone may declare at any time; bots do so as soon as they are confident enough.
  for (const [seat, bot] of bots) {
    const a = bot.confidentDeclaration(viewFor(state, seat));
    if (a) return a;
  }

  if (state.phase === "playing") {
    const bot = state.turn === null ? undefined : bots.get(state.turn);
    return bot ? bot.chooseAsk(viewFor(state, bot.seat)) : null;
  }

  // Forced declaration: an all-bot team guesses at what it cannot prove. A team with a human leaves the
  // guessing to the human.
  for (const team of [0, 1]) {
    const members = state.hands.map((_, s) => s).filter((s) => teamOf(s) === team);
    if (!members.every((s) => bots.has(s))) continue;
    if (!members.some((s) => state.hands[s]!.length > 0)) continue;
    const a = bots.get(members[0]!)!.guessDeclaration(viewFor(state, members[0]!));
    if (a) return a;
  }
  return null;
}
