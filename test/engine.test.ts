import test from "node:test";
import assert from "node:assert/strict";
import { CARD_SET, FULL_DECK, JOKERS, SET_CARDS, SET_IDS } from "../src/cards";
import { applyAction, fromHands, legalAsks, newGame, viewFor, type Action, type GameState } from "../src/engine";
import { checkInvariants } from "../src/invariants";
import { simulate } from "../src/sim";

const must = (s: GameState, a: Action): GameState => {
  const r = applyAction(s, a);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.state;
};
const rejects = (s: GameState, a: Action, pattern: RegExp) => {
  const r = applyAction(s, a);
  assert.ok(!r.ok, "expected rejection");
  assert.match(r.ok ? "" : r.error, pattern);
};
const ask = (by: number, to: number, card: string): Action => ({ type: "ask", by, to, card });
const declare = (by: number, setId: string, holders: number[]): Action => ({
  type: "declare", by, setId,
  assignment: Object.fromEntries(SET_CARDS[setId]!.map((c, i) => [c, holders[i]!])),
});

// Seats 0,2,4 are team 0; seats 1,3,5 are team 1.
const base = () =>
  fromHands(
    [["2S", "9H"], ["3S", "KD"], ["4D", "5D"], ["6C", "7C"], ["JH", "QH"], ["AC", "10C"]],
    0,
  );

test("deck: 9 sets of 6, 54 unique cards, jokers grouped with the 8s", () => {
  assert.equal(SET_IDS.length, 9);
  assert.ok(SET_IDS.every((id) => SET_CARDS[id]!.length === 6));
  assert.equal(new Set(FULL_DECK).size, 54);
  assert.equal(CARD_SET["2S"], "S-low");
  assert.equal(CARD_SET["7S"], "S-low");
  assert.equal(CARD_SET["9S"], "S-high");
  assert.equal(CARD_SET["AS"], "S-high");
  assert.equal(CARD_SET["8H"], "EIGHTS");
  assert.deepEqual(JOKERS.map((j) => CARD_SET[j]), ["EIGHTS", "EIGHTS"]);
});

test("deal: six hands of nine, deterministic per seed, random first player varies", () => {
  const g = newGame({}, 42);
  assert.ok(g.hands.every((h) => h.length === 9));
  assert.deepEqual(newGame({}, 42), g);
  assert.deepEqual(checkInvariants(g), []);
  const firsts = new Set(Array.from({ length: 40 }, (_, i) => newGame({}, i).turn));
  assert.ok(firsts.size > 1);
  assert.equal(newGame({ firstPlayer: 3 }, 1).turn, 3);
});

test("ask: a hit transfers the card and keeps the turn", () => {
  const s = must(base(), ask(0, 1, "3S"));
  assert.ok(s.hands[0]!.includes("3S") && !s.hands[1]!.includes("3S"));
  assert.equal(s.turn, 0);
  assert.deepEqual(s.log.at(-1), { type: "ask", by: 0, to: 1, card: "3S", success: true });
});

test("ask: a miss passes the turn to the player asked", () => {
  const s = must(base(), ask(0, 3, "4S"));
  assert.equal(s.turn, 3);
  assert.deepEqual(s.hands, base().hands);
});

test("ask: illegal asks are rejected", () => {
  const s = base();
  rejects(s, ask(1, 0, "2S"), /not your turn/);
  rejects(s, ask(0, 2, "3S"), /teammate/);
  rejects(s, ask(0, 1, "2S"), /already hold/);
  rejects(s, ask(0, 1, "KC"), /must hold a card in that set/);
  rejects(s, ask(0, 1, "ZZ"), /Unknown card/);
  rejects(s, ask(0, 9, "3S"), /Unknown player/);
  const withEmpty = fromHands([["2S", "9H"], ["3S"], ["4D"], ["6C"], ["JH"], []], 0);
  rejects(withEmpty, ask(0, 5, "3S"), /no cards/);
});

test("jokers can be asked for individually", () => {
  const s = fromHands([["8S"], ["JKR-R", "2D"], ["4D"], ["JKR-B"], ["JH"], ["AC"]], 0);
  const hit = must(s, ask(0, 1, "JKR-R"));
  assert.ok(hit.hands[0]!.includes("JKR-R"));
  const miss = must(s, ask(0, 1, "JKR-B"));
  assert.equal(miss.turn, 1);
});

test("declare: correct declaration scores for the declaring team, any time, by anyone", () => {
  // Team 0 holds all of S-low across seats 0 and 2; seat 4 holds none of it but declares anyway, out of turn.
  const s0 = fromHands(
    [["2S", "3S", "4S", "KH"], ["9D"], ["5S", "6S", "7S", "AH"], ["10D"], ["JH"], ["QD"]],
    0,
  );
  const s = must(s0, declare(4, "S-low", [0, 0, 0, 2, 2, 2]));
  assert.deepEqual(s.scores, [1, 0]);
  assert.equal(s.declared[0]!.correct, true);
  assert.equal(s.turn, 0, "declaring does not change whose turn it is");
  assert.ok(s.hands.flat().every((c) => CARD_SET[c] !== "S-low"));
});

test("declare: a wrong teammate assignment gives the point to the other team", () => {
  const s0 = fromHands(
    [["2S", "3S", "4S", "KH"], ["9D"], ["5S", "6S", "7S", "AH"], ["10D"], ["JH"], ["QD"]],
    0,
  );
  const s = must(s0, declare(0, "S-low", [0, 0, 2, 2, 2, 2])); // 4S is actually with seat 0
  assert.deepEqual(s.scores, [0, 1]);
  assert.equal(s.declared[0]!.correct, false);
  assert.equal(s.declared[0]!.awardedTo, 1);
  assert.ok(s.hands.flat().every((c) => CARD_SET[c] !== "S-low"), "set leaves play either way");
});

test("declare: cards held by the opponents make it wrong", () => {
  const s0 = fromHands(
    [["2S", "3S", "4S", "KH"], ["7S", "9D"], ["5S", "6S", "AH"], ["10D"], ["JH"], ["QD"]],
    0,
  );
  const s = must(s0, declare(0, "S-low", [0, 0, 0, 2, 2, 2]));
  assert.deepEqual(s.scores, [0, 1]);
});

test("declare: malformed declarations are rejected", () => {
  const s = fromHands(
    [["2S", "3S", "4S", "KH"], ["9D"], ["5S", "6S", "7S", "AH"], ["10D"], ["JH"], ["QD"]],
    0,
  );
  rejects(s, declare(0, "S-low", [0, 0, 0, 1, 2, 2]), /own teammates/);
  rejects(s, { type: "declare", by: 0, setId: "S-low", assignment: { "2S": 0 } }, /each card/);
  rejects(s, { type: "declare", by: 0, setId: "NOPE", assignment: {} }, /Unknown set/);
  const done = must(s, declare(0, "S-low", [0, 0, 0, 2, 2, 2]));
  rejects(done, declare(0, "S-low", [0, 0, 0, 2, 2, 2]), /already been declared/);
});

test("turn skips a player whose hand was emptied, to the next teammate clockwise", () => {
  const s0 = fromHands(
    [["2S", "3S"], ["9D"], ["4S", "5S", "6S", "7S", "9H"], ["10D"], ["KH"], ["QD"]],
    0,
  );
  const s = must(s0, declare(2, "S-low", [0, 0, 2, 2, 2, 2]));
  assert.equal(s.turn, 2);
});

test("a player holding only complete sets keeps the turn but must declare", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], ["9D"], ["9H"], ["10D"], ["KH"], ["QD"]],
    0,
  );
  assert.equal(s0.turn, 0);
  assert.equal(s0.phase, "playing");
  assert.equal(viewFor(s0, 0).mustDeclare, true);
  assert.equal(viewFor(s0, 2).mustDeclare, false);
  assert.deepEqual(legalAsks(viewFor(s0, 0)), []);
  rejects(s0, ask(0, 1, "9H"), /must declare/);
  const s1 = must(s0, declare(0, "S-low", [0, 0, 0, 0, 0, 0]));
  assert.equal(s1.turn, 2, "hand emptied, so the turn goes to the next teammate with cards");
});

test("a teammate can declare for a player who is stuck holding complete sets", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], ["9D"], ["9H"], ["10D"], ["KH"], ["QD"]],
    0,
  );
  const s1 = must(s0, declare(4, "S-low", [0, 0, 0, 0, 0, 0]));
  assert.deepEqual(s1.scores, [1, 0]);
  assert.equal(s1.turn, 2);
});

test("holding several complete sets means declaring each before the turn moves on", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!, ...SET_CARDS["S-high"]!], ["9D"], ["9H"], ["10D"], ["KH"], ["QD"]],
    0,
  );
  const s1 = must(s0, declare(0, "S-low", [0, 0, 0, 0, 0, 0]));
  assert.equal(s1.turn, 0);
  assert.equal(viewFor(s1, 0).mustDeclare, true);
  const s2 = must(s1, declare(0, "S-high", [0, 0, 0, 0, 0, 0]));
  assert.equal(s2.turn, 2);
});

test("completing a set by asking can leave you needing to declare", () => {
  const s0 = fromHands(
    [["2S", "3S", "4S", "5S", "6S"], ["7S", "9D"], ["9H"], ["10D"], ["KH"], ["QD"]],
    0,
  );
  const s1 = must(s0, ask(0, 1, "7S"));
  assert.equal(s1.turn, 0);
  assert.equal(viewFor(s1, 0).mustDeclare, true);
});

test("forced declaration when one team has no cards; asks rejected, declarations still work", () => {
  const cfg = { setsToWin: 5 };
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], [], [...SET_CARDS["S-high"]!], [], [...SET_CARDS["H-low"]!], []],
    0,
    cfg,
  );
  assert.equal(s0.phase, "forced-declaration");
  assert.equal(s0.turn, null);
  assert.deepEqual(s0.log[0], { type: "forced-declaration", reason: "one-team-out" });
  rejects(s0, ask(0, 1, "3S"), /remaining sets must be declared/);

  const s1 = must(s0, declare(4, "S-low", [0, 0, 0, 0, 0, 0]));
  assert.deepEqual(s1.scores, [1, 0]);
  const s2 = must(s1, declare(2, "S-high", [4, 2, 2, 2, 2, 2])); // 9S is actually with seat 2
  assert.deepEqual(s2.scores, [1, 1]);
  const s3 = must(s2, declare(0, "H-low", [4, 4, 4, 4, 4, 4]));
  assert.deepEqual(s3.scores, [2, 1]);
});

test("the opposing team may declare in the forced phase, but it can only hurt them", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], [], [...SET_CARDS["S-high"]!], [], [...SET_CARDS["H-low"]!], []],
    0,
  );
  const s = must(s0, declare(1, "S-low", [1, 1, 1, 1, 1, 1]));
  assert.deepEqual(s.scores, [1, 0]);
});

test("everyone holding only complete sets also forces declarations", () => {
  const s = fromHands([[...SET_CARDS["S-low"]!], [...SET_CARDS["H-low"]!], [], [], [], []], 0);
  assert.equal(s.phase, "forced-declaration");
  assert.deepEqual(s.log[0], { type: "forced-declaration", reason: "no-asks-possible" });
});

test("first team to the target wins and the game then locks", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], [], [...SET_CARDS["S-high"]!], [], [...SET_CARDS["H-low"]!], []],
    0,
    { setsToWin: 2 },
  );
  const s1 = must(s0, declare(0, "S-low", [0, 0, 0, 0, 0, 0]));
  const s2 = must(s1, declare(2, "S-high", [2, 2, 2, 2, 2, 2]));
  assert.equal(s2.phase, "finished");
  assert.equal(s2.winner, 0);
  rejects(s2, declare(4, "H-low", [4, 4, 4, 4, 4, 4]), /over/);
});

test("views never include other players' hands", () => {
  const g = newGame({}, 7);
  const v = viewFor(g, 2);
  assert.deepEqual(v.hand, g.hands[2]);
  assert.ok(!("hands" in v));
  assert.equal(v.revealedHands, null);
  assert.deepEqual(v.handCounts, g.hands.map((h) => h.length));
});

test("once the game is over, every view reveals the cards still in hands", () => {
  const s0 = fromHands(
    [[...SET_CARDS["S-low"]!], ["9H"], [...SET_CARDS["S-high"]!], ["10H"], ["JH"], []],
    0,
    { setsToWin: 2 },
  );
  const s1 = must(s0, declare(0, "S-low", [0, 0, 0, 0, 0, 0]));
  assert.equal(viewFor(s1, 1).revealedHands, null);
  const s2 = must(s1, declare(2, "S-high", [2, 2, 2, 2, 2, 2]));
  assert.deepEqual(viewFor(s2, 1).revealedHands, [[], ["9H"], [], ["10H"], ["JH"], []]);
});

test("legalAsks: opponents only, unheld cards only, sets you hold only", () => {
  const asks = legalAsks(viewFor(base(), 0));
  assert.ok(asks.length > 0);
  assert.ok(asks.every((a) => a.to % 2 === 1));
  assert.ok(asks.every((a) => !["2S", "9H"].includes(a.card)));
  assert.ok(asks.every((a) => ["S-low", "H-high"].includes(CARD_SET[a.card]!)));
  assert.deepEqual(legalAsks(viewFor(base(), 1)), [], "not their turn");
});

test("simulation: 150 random games finish cleanly with all invariants intact", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = simulate(seed);
    assert.deepEqual(r.errors, [], `seed ${seed}`);
    assert.equal(r.state.phase, "finished");
  }
});

test("simulation also works for other even player counts", () => {
  for (const playerCount of [2, 4]) {
    for (let seed = 1; seed <= 60; seed++) {
      const r = simulate(seed, { playerCount });
      assert.deepEqual(r.errors, [], `players ${playerCount} seed ${seed}`);
    }
  }
});
