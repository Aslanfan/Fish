import { SET_CARDS, SET_IDS } from "./cards";
import {
  applyAction, legalAsks, newGame, teamOf, viewFor,
  type Action, type Config, type GameState, type Seat,
} from "./engine";
import { checkInvariants } from "./invariants";
import { mulberry32, pick, type Rng } from "./rng";

export interface SimOptions {
  /** Chance per step that a team holding a whole set declares it correctly (test oracle that peeks at hands). */
  pOracleDeclare: number;
  /** Chance per step of a random, usually wrong, declaration (exercises scoring). */
  pRandomDeclare: number;
  maxSteps: number;
}
export const DEFAULT_SIM: SimOptions = { pOracleDeclare: 0.15, pRandomDeclare: 0.02, maxSteps: 20000 };

/** If one team holds every card of an undeclared set, return a correct declaration for it. */
function oracleDeclaration(state: GameState, rng: Rng): Action | null {
  const declared = new Set(state.declared.map((d) => d.setId));
  const candidates: Action[] = [];
  for (const setId of SET_IDS) {
    if (declared.has(setId)) continue;
    const holders = SET_CARDS[setId]!.map((c) => state.hands.findIndex((h) => h.includes(c)));
    if (new Set(holders.map(teamOf)).size !== 1) continue;
    const team = teamOf(holders[0]!);
    const members = state.hands.map((_, s) => s).filter((s) => teamOf(s) === team);
    const assignment = Object.fromEntries(SET_CARDS[setId]!.map((c, i) => [c, holders[i]!]));
    candidates.push({ type: "declare", by: pick(members, rng), setId, assignment });
  }
  return candidates.length ? pick(candidates, rng) : null;
}

function randomDeclaration(state: GameState, rng: Rng): Action | null {
  const declared = new Set(state.declared.map((d) => d.setId));
  const open = SET_IDS.filter((id) => !declared.has(id));
  if (!open.length) return null;
  const setId = pick(open, rng);
  const by: Seat = Math.floor(rng() * state.config.playerCount);
  const members = state.hands.map((_, s) => s).filter((s) => teamOf(s) === teamOf(by));
  const assignment = Object.fromEntries(SET_CARDS[setId]!.map((c) => [c, pick(members, rng)]));
  return { type: "declare", by, setId, assignment };
}

export interface SimResult {
  state: GameState;
  steps: number;
  errors: string[];
}

/** Play one whole game with random legal asks plus oracle/random declarations. Checks invariants every step. */
export function simulate(seed: number, config: Partial<Config> = {}, opts: Partial<SimOptions> = {}): SimResult {
  const o = { ...DEFAULT_SIM, ...opts };
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let state = newGame(config, seed);
  const errors: string[] = [];
  let steps = 0;

  while (state.phase !== "finished" && steps < o.maxSteps) {
    steps++;
    let action: Action | null = null;
    const r = rng();

    if (state.phase === "forced-declaration") {
      action = oracleDeclaration(state, rng) ?? randomDeclaration(state, rng);
    } else if (r < o.pOracleDeclare) {
      action = oracleDeclaration(state, rng);
    } else if (r < o.pOracleDeclare + o.pRandomDeclare) {
      action = randomDeclaration(state, rng);
    }
    if (!action) {
      const view = viewFor(state, state.turn!);
      const asks = legalAsks(view);
      if (asks.length) {
        const { to, card } = pick(asks, rng);
        action = { type: "ask", by: state.turn!, to, card };
      } else if (view.mustDeclare) {
        // Holding only complete sets: the player must declare one (always correct, all cards are theirs).
        const held = new Set(view.hand);
        const setId = SET_IDS.find((id) => SET_CARDS[id]!.every((c) => held.has(c)));
        if (!setId) { errors.push("mustDeclare without a complete set"); break; }
        action = { type: "declare", by: view.seat, setId, assignment: Object.fromEntries(SET_CARDS[setId]!.map((c) => [c, view.seat])) };
      } else {
        errors.push(`no legal action for seat ${state.turn}`);
        break;
      }
    }

    const res = applyAction(state, action);
    if (!res.ok) { errors.push(`rejected ${JSON.stringify(action)}: ${res.error}`); break; }
    state = res.state;
    for (const p of checkInvariants(state)) errors.push(`step ${steps}: ${p}`);
    if (errors.length) break;
  }
  if (state.phase !== "finished" && !errors.length) errors.push("did not finish within maxSteps");
  return { state, steps, errors };
}
