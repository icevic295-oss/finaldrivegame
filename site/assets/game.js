/* Final Drive — game engine & UI logic */
export const CAT_LABEL = {
  pass: "Pass", run: "Run", spike: "Spike it", kneel: "Kneel",
  field_goal: "Field goal", punt: "Punt", timeout: "Timeout",
};
export const GRADE_ICON = ["🟢", "🟡", "🟠", "🔴"];
export const REAL_ICON = { Touchdown: "TD", "Field goal": "FG", Turnover: "TO", "Turnover on downs": "DOWN", "Interception": "TO", Fumble: "TO", Punt: "PUNT", "End of half": "EOH", "End of game": "EOG", "Missed field goal": "MISS" };

// route picker per position — mirrors the real route tree
export const ROUTES = {
  WR1: ["slant", "hitch", "out", "in", "post", "corner", "go", "screen"],
  WR2: ["slant", "hitch", "out", "in", "post", "corner", "go", "screen"],
  TE: ["flat", "hitch", "out", "cross", "in", "go"],
  RB: ["flat", "angle", "screen", "wheel"],
};
export const ROUTE_NAME = { go: "Go", post: "Post", corner: "Corner", out: "Quick out", in: "Dig", slant: "Slant", cross: "Crosser", hitch: "Hitch", screen: "Screen", flat: "Flat", wheel: "Wheel", angle: "Angle" };
const DEEP_ROUTES = new Set(["go", "post", "corner", "wheel"]);
export const routeDepth = (rt) => (DEEP_ROUTES.has(rt) ? "deep" : "short");

function bucket(state) {
  const dist = state.distance <= 3 ? "short" : state.distance <= 7 ? "mid" : "long";
  const diff = state.scoreDiff >= -3 ? "close" : state.scoreDiff >= -8 ? "td" : "far";
  const secs = state.seconds <= 30 ? "le30" : state.seconds <= 60 ? "le60" : "le120";
  return `${state.down}|${dist}|${diff}|${secs}`;
}

export class Game {
  constructor(puzzle, baselines) {
    this.puzzle = puzzle;
    this.bl = baselines;
    const s = puzzle.start;
    this.state = {
      seconds: s.seconds, down: s.down, distance: s.distance,
      yardline: s.yardline, scoreDiff: s.score_diff, timeouts: s.timeouts ?? 3,
    };
    this.wp = puzzle.plays[0]?.wp_before ?? puzzle.plays[0]?.wp ?? 0.2;
    this.startWp = this.wp;
    this.idx = 0;
    this.tempo = "nohuddle";   // nohuddle 0s | huddle 5s | milk 12s before the snap
    this.log = [];
    this.over = false;
    this.pendingTry = null;
    this.catAvg = {};
    const sums = {}, counts = {};
    for (const k of Object.keys(baselines.wp_delta)) {
      for (const [cat, v] of Object.entries(baselines.wp_delta[k])) {
        sums[cat] = (sums[cat] || 0) + v; counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    for (const c of Object.keys(sums)) this.catAvg[c] = sums[c] / counts[c];
  }

  expected(cat, state = this.state) {
    const b = this.bl.wp_delta[bucket(state)];
    return b?.[cat] ?? this.catAvg[cat] ?? 0;
  }

  usageTable(state = this.state) {
    return this.bl.usage?.[bucket(state)] || null;
  }

  bestExpected(state = this.state) {
    const b = this.bl.wp_delta[bucket(state)] || {};
    return Math.max(this.expected("run", state), this.expected("pass", state),
      b.field_goal ?? this.catAvg.field_goal ?? 0);
  }

  static gradeIndex(g) {
    return g >= 0.02 ? 0 : g >= -0.02 ? 1 : g >= -0.05 ? 2 : 3;
  }

  /* --- call matching: does the player's call mirror what really happened? --- */
  matchOf(call, real) {
    if (!call || !real?.call) return "none";
    if (call.family !== real.call.family) return "none";
    if (call.family === "run") return call.side === real.call.side ? "full" : "family";
    // pass
    if (call.target && call.target === real.call.target) {
      if (routeDepth(call.depth ?? "short") === routeDepth(real.call.depth ?? "short")) return "full";
      return "target";   // right receiver, wrong depth
    }
    return "family";
  }

  fgProb(dist = this.state.yardline + 17) {
    const buckets = Object.keys(this.bl.fg_rate).map(Number).sort((a, b) => a - b);
    let b = buckets[0];
    for (const x of buckets) if (x <= dist) b = x;
    return { p: this.bl.fg_rate[b] ?? 0.7, b };
  }

  chooseTimeout() {
    if (this.over || this.state.timeouts <= 0) return null;
    this.state.timeouts--;
    this.log.push({ cat: "timeout", neutral: true, desc: "Timeout — clock stops." });
    return this.log[this.log.length - 1];
  }

  /* run it down to 0:03, then take the timeout to set up the kick */
  chooseRundown() {
    if (this.over || this.state.timeouts <= 0 || this.state.seconds <= 20) return null;
    this.state.seconds = 3;
    this.state.timeouts--;
    this.log.push({ cat: "timeout", neutral: true, desc: "Ran the clock down to 0:03, then timeout — the field-goal unit jogs on." });
    return this.log[this.log.length - 1];
  }

  chooseTry(type) {
    if (!this.pendingTry) return null;
    const t = this.pendingTry;
    this.pendingTry = null;
    // pick the real try's own type → the real result; pick the other → league-average odds
    let good;
    if (type === t.type) good = t.good;
    else good = Math.random() < (type === "xp" ? 0.94 : 0.47);
    const pts = type === "xp" ? 1 : 2;
    if (good) this.state.scoreDiff += pts;
    this.log.push({
      neutral: true,
      desc: type === "xp"
        ? (t.good ? "Kick the XP — GOOD." : "Kick the XP — NO GOOD. The angle was bad all along.")
        : (t.good ? "Go for two — GOOD. Gutty call." : "Go for two — STUFFED."),
    });
    this.endDrive();
    return this.log[this.log.length - 1];
  }

  tempoCost() {
    return this.tempo === "milk" ? 12 : this.tempo === "huddle" ? 5 : 0;
  }

  choose(call) {
    if (this.over || this.pendingTry) return null;
    if (call === "timeout") return this.chooseTimeout();
    if (call === "rundown") return this.chooseRundown();

    const before = { ...this.state };
    const real = this.puzzle.plays[this.idx];
    let entry;

    const specials = ["field_goal", "punt", "spike", "kneel"];
    if (specials.includes(call.special)) {
      const cat = call.special;
      // mirror the real kick/punt when that's what actually happened
      if (real && real.cat === cat) {
        this.idx++;
        const p = real;
        this.state.seconds = p.seconds;
        if (p.down != null) this.state.down = p.down;
        if (p.distance != null) this.state.distance = p.distance;
        if (p.yardline != null) this.state.yardline = p.yardline;
        this.state.scoreDiff = p.score_diff;
        if (p.wp != null) this.wp = p.wp;
        const delta = (p.wp != null && p.wp_before != null) ? p.wp - p.wp_before : 0;
        entry = {
          cat, matched: true, match: "full", desc: p.desc, delta, wp: this.wp,
          seconds: p.seconds, scoreDiff: p.score_diff,
          grade: delta - this.expected(cat, before), realPlay: p,
        };
        this.log.push(entry);
        if (p.try) { this.pendingTry = p.try; return entry; }
        this.finishStep(entry);
        return entry;
      }
      let desc, delta = this.expected(cat, before);
      if (cat === "spike") {
        this.state.down++;
        desc = "QB spikes the ball — clock stops.";
      } else if (cat === "kneel") {
        this.state.seconds = Math.max(0, this.state.seconds - 40);
        this.state.down++;
        desc = "QB kneels — clock runs.";
      } else if (cat === "field_goal") {
        const dist = this.state.yardline + 17;
        const { p } = this.fgProb(dist);
        const made = Math.random() < p;
        desc = made ? `${dist}-yard field goal is GOOD.` : `${dist}-yard field goal is NO GOOD.`;
        if (made) { this.state.scoreDiff += 3; this.state.seconds = Math.max(0, this.state.seconds - 5); this.state.down = 5; }
        else this.state.down = 5;
      } else {
        desc = "Punt away — drive over. The crowd groans.";
        this.state.down = 5;
      }
      entry = {
        cat, matched: false, desc, delta,
        wp: Math.min(0.99, Math.max(0.01, this.wp + delta)),
        seconds: this.state.seconds, scoreDiff: this.state.scoreDiff,
        grade: this.expected(cat, before) - this.bestExpected(before),
      };
      this.wp = entry.wp;
      this.log.push(entry);
      this.finishStep(entry);
      return entry;
    }

    // run / pass call object: {family, side, target?, depth?, oob?}
    const m = this.matchOf(call, real);
    if (real && (m === "full" || m === "target")) {
      this.idx++;
      const p = real;
      this.state.seconds = p.seconds;
      if (p.down != null) this.state.down = p.down;
      if (p.distance != null) this.state.distance = p.distance;
      if (p.yardline != null) this.state.yardline = p.yardline;
      this.state.scoreDiff = p.score_diff;
      if (p.wp != null) this.wp = p.wp;
      const delta = (p.wp != null && p.wp_before != null) ? p.wp - p.wp_before : 0;
      entry = {
        cat: p.cat, matched: true, match: m, desc: p.desc, delta, wp: this.wp,
        seconds: p.seconds, scoreDiff: p.score_diff,
        grade: delta - this.expected(call.family, before) - (m === "target" ? 0.01 : 0),
        realPlay: p,
      };
      this.log.push(entry);
      if (p.try) { this.pendingTry = p.try; return entry; }   // try decision before ending
      this.finishStep(entry);
      return entry;
    }

    // synthetic outcome from league baselines
    const family = call.family;
    let desc, delta = this.expected(family, before);
    if (family === "pass") {
      const oob = !!call.oob;
      if (oob && Math.random() < 0.55) {
        const yds = 4 + Math.floor(Math.random() * 9);
        this.state.yardline = Math.max(1, this.state.yardline - yds);
        this.state.seconds = Math.max(0, this.state.seconds - 5);
        this.state.down++;
        desc = `Catch and get out of bounds! +${yds} — clock stops.`;
      } else if (oob) {
        this.state.down++;
        desc = "Driven toward the sideline — tackled in bounds. The clock keeps bleeding.";
        delta -= 0.01;
      } else {
        const complete = Math.random() < 0.55;
        const deep = routeDepth(call.depth ?? "short") === "deep";
        if (complete) {
          const yds = deep ? 14 + Math.floor(Math.random() * 18) : 5 + Math.floor(Math.random() * 9);
          this.state.yardline = Math.max(1, this.state.yardline - yds);
          this.state.seconds = Math.max(0, this.state.seconds - 5);
          this.state.down++;
          desc = `Pass complete for ${yds} yards.`;
        } else {
          this.state.down++;
          desc = deep ? "Shot downfield — incomplete, clock stops." : "Pass incomplete — clock stops.";
        }
      }
    } else {
      const yds = 2 + Math.floor(Math.random() * 5);
      this.state.yardline = Math.max(1, this.state.yardline - yds);
      this.state.seconds = Math.max(0, this.state.seconds - 40);
      this.state.down++;
      desc = `Run for ${yds} yards — tackled in bounds, clock keeps running.`;
    }
    entry = {
      cat: family, matched: false, match: m, desc, delta,
      wp: Math.min(0.99, Math.max(0.01, this.wp + delta)),
      seconds: this.state.seconds, scoreDiff: this.state.scoreDiff,
      grade: delta - this.bestExpected(before),
    };
    this.wp = entry.wp;
    this.log.push(entry);
    this.finishStep(entry);
    return entry;
  }

  finishStep(entry) {
    if (this.state.seconds <= 0) this.endDrive("clock");
    else if (this.state.down > 4) this.endDrive("downs");
    else if (entry.matched && this.idx >= this.puzzle.plays.length) this.endDrive();
  }

  endDrive(reason = null) {
    if (this.over) return;
    this.over = true;
    this.endReason = reason || this.puzzle.result || "end of drive";
    this.won = this.state.scoreDiff >= 0;
    this.totalGrade = this.log.filter(l => !l.neutral).reduce((a, l) => a + (l.grade || 0), 0);
    this.realCoachDelta = (this.puzzle.final_wp ?? 0) - this.startWp;
  }

  coachStyle() {
    const calls = this.log.filter(l => !l.neutral && l.cat !== "field_goal" && l.cat !== "punt");
    const passRate = calls.length ? calls.filter(c => c.cat === "pass").length / calls.length : 0;
    const spiked = this.log.some(l => l.cat === "spike");
    const toUsed = this.log.some(l => l.cat === "timeout");
    if (passRate >= 0.8) return { name: "The Gunslinger", note: "You live on the edge — every snap is a throw." };
    if (passRate <= 0.34) return { name: "Ground & Pound", note: "You trust the run game in crunch time." };
    if (spiked) return { name: "By The Book", note: "You manage the clock exactly like the chart says." };
    if (!toUsed) return { name: "Ice Veins", note: "You never blinked — didn't even need a timeout." };
    return { name: "Field General", note: "Balanced, calm, and in control of the clock." };
  }
}

export function dailyPuzzle(puzzles) {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const key = `${et.getFullYear()}-${et.getMonth() + 1}-${et.getDate()}`;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { puzzle: puzzles[h % puzzles.length], key };
}

export function shareText(puzzle, game) {
  const icons = game.log.filter(l => !l.neutral).map(l => GRADE_ICON[Game.gradeIndex(l.grade)]).join("");
  const res = game.won ? "🏆 WIN" : "💀 LOSS";
  const g = game.puzzle.game;
  return [
    `Final Drive ${g.season} W${g.week}: ${g.away} @ ${g.home}`,
    `${res} | ${icons}`,
    `${game.won ? "I drove my team to the lead" : "The drive came up short"} — can you do better?`,
    location.origin,
  ].join("\n");
}
