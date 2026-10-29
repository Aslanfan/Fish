import { FULL_DECK, SET_CARDS } from "./cards";
import { teamOf, type GameState } from "./engine";

/** Returns a list of violated invariants (empty means the state is consistent). */
export function checkInvariants(s: GameState): string[] {
  const problems: string[] = [];

  const inPlay = s.hands.flat();
  const declaredCards = s.declared.flatMap((d) => [...SET_CARDS[d.setId]!]);
  const all = [...inPlay, ...declaredCards];
  if (new Set(all).size !== all.length) problems.push("duplicate card");
  if (all.length !== FULL_DECK.length) problems.push(`card count ${all.length} != ${FULL_DECK.length}`);

  if (s.scores[0] + s.scores[1] !== s.declared.length) problems.push("scores do not match declared sets");

  if (s.phase === "playing") {
    if (s.turn === null) problems.push("playing but no turn");
    else if (s.hands[s.turn]!.length === 0) problems.push("turn belongs to a player with no cards");
    const teams = [0, 0];
    s.hands.forEach((h, seat) => (teams[teamOf(seat)]! += h.length));
    if (teams[0] === 0 || teams[1] === 0) problems.push("playing but one team has no cards");
  }
  if (s.phase === "forced-declaration" && s.turn !== null) problems.push("forced phase should have no turn");
  if (s.phase === "finished") {
    if (s.winner === null) problems.push("finished without winner");
    else if (s.scores[s.winner] <= s.scores[s.winner === 0 ? 1 : 0]) problems.push("winner does not lead");
  }
  return problems;
}
