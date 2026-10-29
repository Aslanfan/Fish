import { simulate } from "./sim";

const games = Number(process.argv[2] ?? 500);
let bad = 0, steps = 0, wrongDecl = 0, forced = 0;
const wins = [0, 0];
for (let seed = 1; seed <= games; seed++) {
  const r = simulate(seed);
  if (r.errors.length) { bad++; console.log(`seed ${seed}:`, r.errors[0]); continue; }
  steps += r.steps;
  wins[r.state.winner!]!++;
  wrongDecl += r.state.declared.filter((d) => !d.correct).length;
  if (r.state.log.some((e) => e.type === "forced-declaration")) forced++;
}
console.log(`${games} games, ${bad} failures`);
console.log(`avg steps ${(steps / (games - bad)).toFixed(1)}, team wins ${wins.join(" / ")}`);
console.log(`wrong declarations ${wrongDecl}, games reaching forced-declaration ${forced}`);
