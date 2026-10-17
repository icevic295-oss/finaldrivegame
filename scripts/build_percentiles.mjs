/* Precompute total-grade distributions per puzzle by simulating random call paths. */
import { Game } from "../site/assets/game.js";
import { readFileSync, writeFileSync } from "fs";

const puzzles = JSON.parse(readFileSync(new URL("../site/data/puzzles.json", import.meta.url)));
const baselines = JSON.parse(readFileSync(new URL("../site/data/baselines.json", import.meta.url)));
const N = 300;

function randomCall(g, rng) {
  const roll = rng();
  const st = g.state;
  if (roll < 0.05 && st.down >= 3) return { special: "field_goal" };
  if (roll < 0.08) return { special: "spike" };
  if (roll < 0.12) return { special: "punt" };
  if (roll < 0.16) return "timeout";
  if (roll < 0.42) {
    const sides = ["strong", "middle", "weak"];
    return { family: "run", base: "Run", side: sides[Math.floor(rng() * 3)] };
  }
  const slots = ["WR1", "WR2", "TE", "RB"];
  const target = slots[Math.floor(rng() * 4)];
  const depth = rng() < 0.3 ? "deep" : "short";
  return { family: "pass", base: depth === "deep" ? "Deep pass" : "Quick pass", side: "middle", target, depth };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); return ((t ^ (t >>> 16)) >>> 0) / 4294967296; };
}

const out = {};
for (const p of puzzles) {
  const rng = mulberry32(1234567);
  const grades = [];
  for (let i = 0; i < N; i++) {
    const g = new Game(p, baselines);
    let guard = 0;
    while (!g.over && guard++ < 40) {
      if (g.pendingTry) { g.chooseTry(rng() < 0.7 ? "xp" : "two"); continue; }
      g.choose(randomCall(g, rng));
    }
    g.endDrive();
    grades.push(Number(g.totalGrade.toFixed(4)));
  }
  grades.sort((a, b) => a - b);
  out[p.slug] = grades;
}
writeFileSync(new URL("../site/data/percentiles.json", import.meta.url), JSON.stringify(out));
console.log(`distributions written for ${Object.keys(out).length} puzzles (N=${N})`);
