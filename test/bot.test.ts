import assert from "node:assert/strict";
import { test } from "node:test";
import { DeductionBot, DIFFICULTY, type Difficulty } from "../src/bots/deduction";
import { nextBotAction } from "../src/bots/runner";
import { applyAction, fromHands, newGame, viewFor, type Action, type GameState } from "../src/engine";
import { checkInvariants } from "../src/invariants";

function botsFor(state: GameState, difficulty: Difficulty, humans: number[] = []) {
  return new Map(
    state.hands.map((_, s) => s).filter((s) => !humans.includes(s)).map((s) => [s, new DeductionBot(s, DIFFICULTY[difficulty], s + 7)]),
  );
}

function play(state: GameState, actions: Action[]): GameState {
  for (const a of actions) {
    const res = applyAction(state, a);
    assert.ok(res.ok, !res.ok ? res.error : "");
    state = res.state;
  }
  return state;
}

// Seat 3 (Nora) and seat 0 are opponents; seat 2 is seat 0's teammate.
const HANDS = [
  ["3H", "9S", "10S"],
  ["5S", "10H", "JH"],
  ["4H", "QH", "KH"],
  ["2H", "AH", "8C"],
  ["3S", "9D", "10D"],
  ["JD", "QD", "KD"],
];

test("bots: all-bot games finish cleanly at every difficulty, within their registers", () => {
  for (const difficulty of Object.keys(DIFFICULTY) as Difficulty[]) {
    for (let seed = 1; seed <= 25; seed++) {
      let state = newGame({}, seed);
      const bots = botsFor(state, difficulty);
      let steps = 0;
      while (state.phase !== "finished") {
        assert.ok(++steps < 5000, `seed ${seed} (${difficulty}) did not finish`);
        const action = nextBotAction(state, bots);
        assert.ok(action, `seed ${seed} (${difficulty}) stalled in phase ${state.phase}`);
        state = play(state, [action]);
        assert.deepEqual(checkInvariants(state), []);
        for (const bot of bots.values()) assert.ok(bot.memory.length <= bot.opts.registers);
      }
    }
  }
});

test("bots: with perfect memory a bot never declares wrongly unless the rules force a guess", () => {
  for (let seed = 1; seed <= 30; seed++) {
    let state = newGame({}, seed);
    const bots = botsFor(state, "nightmare");
    while (state.phase !== "finished") {
      const forced = state.phase === "forced-declaration";
      state = play(state, [nextBotAction(state, bots)!]);
      const last = state.log.at(-1);
      if (!forced && last?.type === "declare") assert.ok(last.correct, `seed ${seed}`);
    }
  }
});

test("bots: a miss rules out both players for that card", () => {
  const state = play(fromHands(HANDS, 0), [{ type: "ask", by: 0, to: 1, card: "JS" }]);
  const bot = new DeductionBot(2, DIFFICULTY.nightmare);
  assert.deepEqual([...bot.knowledge(viewFor(state, 2)).possible.get("JS")!].sort(), [3, 4, 5]);
});

test("bots: 'Nora has the 3 and 4 of low hearts plus more' takes three registers", () => {
  // Nora (3) takes the 3H from seat 0 and the 4H from seat 2. Each ask also shows she holds another low heart.
  const state = play(fromHands(HANDS, 3), [
    { type: "ask", by: 3, to: 0, card: "3H" },
    { type: "ask", by: 3, to: 2, card: "4H" },
  ]);
  const bot = new DeductionBot(4, DIFFICULTY.nightmare);
  const { possible, atLeast } = bot.knowledge(viewFor(state, 4));
  assert.equal(bot.memory.length, 3);
  assert.deepEqual([...possible.get("3H")!], [3]);
  assert.deepEqual([...possible.get("4H")!], [3]);
  assert.equal(atLeast.get("3:H-low"), 1);
});

test("bots: a full memory drops a note rather than growing", () => {
  const state = play(fromHands(HANDS, 3), [
    { type: "ask", by: 3, to: 0, card: "3H" },
    { type: "ask", by: 3, to: 2, card: "4H" },
  ]);
  const bot = new DeductionBot(4, { ...DIFFICULTY.nightmare, registers: 2 });
  bot.observe(viewFor(state, 4));
  assert.equal(bot.memory.length, 2);
});

test("bots: waits for the human when it is the human's turn", () => {
  const state = newGame({ firstPlayer: 0 }, 3);
  const action = nextBotAction(state, botsFor(state, "normal", [0]));
  assert.ok(action === null || action.type === "declare");
});
