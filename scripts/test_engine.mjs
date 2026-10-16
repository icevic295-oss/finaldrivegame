import { Game } from "../site/assets/game.js";
import { readFileSync } from "fs";

const puzzles = JSON.parse(readFileSync(new URL("../site/data/puzzles.json", import.meta.url)));
const baselines = JSON.parse(readFileSync(new URL("../site/data/baselines.json", import.meta.url)));

let fails = 0;
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); fails++; } };

for (const p of puzzles) {
  assert(p.plays.length >= 3, `${p.slug} too few plays`);
  assert(p.start.timeouts >= 0 && p.start.timeouts <= 3, `${p.slug} timeouts`);
  for (const pl of p.plays) assert(pl.desc && pl.seconds >= 0, `${p.slug} play fields`);
  for (const pl of p.plays) {
    if (pl.call) {
      assert(["run", "pass"].includes(pl.call.family), `${p.slug} call family`);
      if (pl.call.family === "pass") assert(pl.call.target && pl.call.depth, `${p.slug} pass call fields`);
    }
    if (pl.try) assert(["xp", "two"].includes(pl.try.type) && typeof pl.try.good === "boolean", `${p.slug} try fields`);
  }
}

function mirrorCall(pl) {
  if (!pl.call) return { special: pl.cat === "field_goal" ? "field_goal" : pl.cat === "punt" ? "punt" : pl.cat === "spike" ? "spike" : "kneel" };
  return { family: pl.call.family, side: pl.call.side, target: pl.call.target, depth: pl.call.depth };
}

// mirror path on every puzzle
for (const p of puzzles) {
  const g = new Game(p, baselines);
  let guard = 0;
  while (!g.over && guard++ < 40) {
    if (g.pendingTry) { g.chooseTry(p.plays.find(pl => pl.try).try.type); continue; }
    const real = p.plays[g.idx];
    g.choose(mirrorCall(real));
  }
  assert(g.over, `${p.slug} mirror should end`);
  const expectedWon = g.state.scoreDiff >= 0;
  assert(g.won === expectedWon, `${p.slug} won flag consistent`);
  for (const l of g.log.filter(x => !x.neutral)) assert(Number.isFinite(l.grade), `${p.slug} grade finite`);
}
console.log("mirror paths: all", puzzles.length, "ended, grades finite");

// try scoring: the TD puzzle's mirrored final diff must include try points
const tdP = puzzles.find(p => p.plays.some(pl => pl.try));
if (tdP) {
  const g = new Game(tdP, baselines);
  let guard = 0;
  while (!g.over && guard++ < 40) {
    if (g.pendingTry) { g.chooseTry(tdP.plays.find(pl => pl.try).try.type); continue; }
    g.choose(mirrorCall(tdP.plays[g.idx]));
  }
  const realTry = tdP.plays.find(pl => pl.try).try;
  const pts = realTry.good ? (realTry.type === "xp" ? 1 : 2) : 0;
  assert(g.state.scoreDiff === tdP.plays[tdP.plays.length - 1].score_diff + pts,
    `try points folded: ${g.state.scoreDiff} vs ${tdP.plays[tdP.plays.length - 1].score_diff + pts}`);
  console.log("try scoring ok:", tdP.slug, "final diff", g.state.scoreDiff);
}

// loss path: punt immediately
const p0 = puzzles[0];
const g2 = new Game(p0, baselines);
g2.choose({ special: "punt" });
assert(g2.over && !g2.won, "punt should end in loss");

// timeout + rundown bookkeeping
const g3 = new Game(p0, baselines);
g3.choose("timeout");
assert(g3.state.timeouts === (p0.start.timeouts ?? 3) - 1, "timeout decrements");
const ok = g3.choose("rundown");
if (ok) assert(g3.state.seconds === 3, "rundown sets 0:03");

// usage table present for buckets
const g4 = new Game(p0, baselines);
assert(g4.usageTable() === null || typeof g4.usageTable() === "object", "usage table type");

// synthetic pass with wrong target scores worse than full match on a pass puzzle
const pPass = puzzles.find(p => p.plays[0].call?.family === "pass");
if (pPass) {
  const real = pPass.plays[0].call;
  const gFull = new Game(pPass, baselines);
  const gOff = new Game(pPass, baselines);
  gFull.choose({ family: "pass", side: real.side, target: real.target, depth: real.depth });
  const offTarget = real.target === "WR1" ? "WR2" : "WR1";
  gOff.choose({ family: "pass", side: "strong", target: offTarget, depth: real.depth === "deep" ? "short" : "deep", oob: false });
  assert(gFull.log[0].matched === true, "full match matches");
  assert(gOff.log[0].matched === false, "off-target is off script");
}
console.log("ALL PASS" + (fails ? ` (${fails} failures)` : ""));
if (fails) process.exit(1);
