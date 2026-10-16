/* Final Drive — game UI (broadcast-style, competitor-grade call dock) */
import { Game, dailyPuzzle, shareText, CAT_LABEL, GRADE_ICON, REAL_ICON, ROUTES, ROUTE_NAME, routeDepth } from "./game.js?v=8";
import { createField } from "./field.js?v=7";

let PUZZLES, BASELINES, STORIES, PROFILES;
const $ = (sel) => document.querySelector(sel);
const fmtClock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const QTR = { 1: "1ST", 2: "2ND", 3: "3RD", 4: "4TH", 5: "OT" };
const FAM = { run: "Run", pass: "Pass" };

async function loadData() {
  const [p, b, s, pl] = await Promise.all([
    fetch("data/puzzles.json?v=7", { cache: "reload" }).then(r => r.json()),
    fetch("data/baselines.json?v=7", { cache: "reload" }).then(r => r.json()),
    fetch("data/stories.json?v=7", { cache: "reload" }).then(r => r.json()).catch(() => ({})),
    fetch("data/players.json?v=7", { cache: "reload" }).then(r => r.json()).catch(() => ({})),
  ]);
  PUZZLES = p; BASELINES = b; STORIES = s; PROFILES = pl;
}

export async function runGame({ mode, slug }) {
  await loadData();
  let puzzle = slug ? PUZZLES.find(p => p.slug === slug) : null;
  if (!puzzle) puzzle = mode === "unlimited"
    ? PUZZLES[Math.floor(Math.random() * PUZZLES.length)]
    : dailyPuzzle(PUZZLES).puzzle;
  const game = new Game(puzzle, BASELINES);
  const g = puzzle.game;
  document.title = `${g.away} @ ${g.home} — Final Drive`;
  renderGame(puzzle, game);
}

/* ---------- the whole game on one screen, straight on load ---------- */
function renderGame(puzzle, game) {
  const g = puzzle.game, s = puzzle.start;
  const story = STORIES[puzzle.slug];
  $("#app").innerHTML = `
  <section class="scoreboard">
    <div class="sb-main">
      <div class="sb-team"><span class="sb-abbr">${g.posteam}</span><span class="sb-score" id="sb-pos">${s.posteam_score}</span></div>
      <div class="sb-mid">
        <span class="sb-clock" id="sb-clock">${fmtClock(s.seconds)}</span>
        <span class="sb-qtr">${QTR[s.qtr] || ""}</span>
      </div>
      <div class="sb-team"><span class="sb-abbr">${g.defteam}</span><span class="sb-score" id="sb-def">${s.defteam_score}</span></div>
    </div>
    <div class="sb-sub">
      <span class="sb-wp">WIN PROB <b id="sb-wp">${Math.round(game.wp * 100)}%</b></span>
      <span class="sb-wpbar"><i id="sb-wpfill" style="width:${game.wp * 100}%"></i></span>
    </div>
  </section>
  <div class="gamegrid">
    <div class="gameleft">
      <section id="fieldbox" class="fieldbox"></section>
      ${story ? `<details class="card storycard"><summary>The Story — ${g.season} W${g.week}</summary><p>${story}</p></details>` : ""}
      <section id="situation" class="card situation-line"></section>
      <section id="log" class="log"></section>
    </div>
    <aside id="dock" class="card dock"></aside>
  </div>
  <div id="end"></div>`;
  const numbers = {};
  for (const [slot, prof] of Object.entries(puzzle.participants || {}))
    if (slot !== "QB" && prof?.no) numbers[slot] = String(prof.no);
  const field = createField($("#fieldbox"), { posteam: g.posteam, defteam: g.defteam, numbers });
  game._field = field;
  field.onRecvTap((slot, kind) => {
    if (kind === "info") return showPlayerCard(puzzle, game, slot);
    if (game._ui?.step === "pass" && game._ui.pass) {
      const list = ROUTES[slot];
      game._ui.pass.routes[slot] = list[(list.indexOf(game._ui.pass.routes[slot]) + 1) % list.length];
      drawDock(puzzle, game);
    } else {
      showPlayerCard(puzzle, game, slot);
    }
  });
  this_ui(game, puzzle);
}

function this_ui(game, puzzle) {
  game._ui = { step: "family", fam: null, pass: null };
  updateSituation(puzzle, game);
  drawDock(puzzle, game);
}

function updateSituation(puzzle, game) {
  const st = game.state, s = puzzle.start;
  const pos = s.posteam_score + (st.scoreDiff - s.score_diff);
  const def = s.defteam_score - (st.scoreDiff - s.score_diff);
  $("#situation").innerHTML = `
    <span class="pill down">${st.down} & ${st.distance}</span>
    <span class="pill">Own ${100 - st.yardline}</span>
    <span class="pill clock">${fmtClock(Math.max(0, st.seconds))}</span>
    <span class="pill">TO ×${st.timeouts}</span>`;
  $("#sb-clock").textContent = fmtClock(Math.max(0, st.seconds));
  $("#sb-pos").textContent = pos;
  $("#sb-def").textContent = def;
  $("#sb-wp").textContent = Math.round(game.wp * 100) + "%";
  $("#sb-wpfill").style.width = (game.wp * 100) + "%";
  game._field.update({ yardline: st.yardline, distance: st.distance });
}

/* ---------- the call dock ---------- */
function familiesAvailable(puzzle, game) {
  // which families the real script can reward (with side variants)
  const fams = new Set();
  for (let i = game.idx; i < puzzle.plays.length; i++) {
    const c = puzzle.plays[i].call;
    if (c) fams.add(c.family);
  }
  return ["run", "pass"].filter(f => fams.has(f));
}

function runPassRows(puzzle, game, fam) {
  const st = game.state;
  const sideName = (sd) => sd === "strong" ? "Strong →" : sd === "weak" ? "← Weak" : "Middle";
  const bases = ["Run", "Quick pass", "Deep pass"];
  const rows = [];
  for (const base of bases) {
    const sides = ["strong", "middle", "weak"].map(sd => ({ sd, label: sideName(sd) }));
    if (fam === "run" && base === "Run") rows.push({ base, sides });
    if (fam === "pass" && base !== "Run") rows.push({ base, sides });
  }
  return rows;
}

function drawDock(puzzle, game) {
  const dock = $("#dock");
  if (game.over) { dock.innerHTML = ""; return; }
  if (game.pendingTry) return drawTryPicker(game);
  const ui = game._ui;
  const st = game.state;
  const fgDist = st.yardline + 17;
  const { p: fgP } = game.fgProb(fgDist);

  if (ui.step === "family") {
    const fams = familiesAvailable(puzzle, game);
    let html = `<h2>Your call</h2><div class="famrow">`;
    for (const f of fams) html += `<button class="btn act primary fam ${ui.fam === f ? "open" : ""}" data-fam="${f}">${FAM[f]}</button>`;
    html += `</div>`;
    // sub-options expand right below the family row (accordion)
    if (ui.fam === "run") {
      html += `<div class="subpanel open"><div class="plays">`;
      for (const row of runPassRows(puzzle, game, "run")) {
        html += `<div class="prow"><div class="lab">${row.base}</div><div class="sides">`;
        for (const sd of row.sides) html += `<button class="btn act primary side" data-side="${sd.sd}">${sd.label}</button>`;
        html += `</div></div>`;
      }
      html += `</div></div>`;
    }
    html += `<div class="specrow">`;
    html += `<button class="btn act gold spec" data-spec="field_goal">Field goal <small>${fgDist} yds · ${Math.round(fgP * 100)}%</small></button>`;
    if (st.down >= 3) html += `<button class="btn act gold spec" data-spec="punt">Punt</button>`;
    if (!game.puzzle.plays[game.idx] || game.puzzle.plays[game.idx].cat !== "spike")
      html += `<button class="btn act gold spec" data-spec="spike" ${st.seconds > 35 ? "disabled" : ""}>Spike</button>`;
    html += `<button class="btn act gold spec" data-spec="timeout" ${st.timeouts > 0 ? "" : "disabled"}>Timeout <small>${st.timeouts} left</small></button>`;
    if (st.timeouts > 0 && st.seconds > 20 && fgDist <= 55)
      html += `<button class="btn act gold spec" data-spec="rundown">Run it down <small>timeout at 0:03</small></button>`;
    html += `</div>`;
    dock.innerHTML = html;
    dock.querySelectorAll(".fam").forEach(b => b.onclick = () => {
      const f = b.dataset.fam;
      if (ui.step === "family" && ui.fam === f) { ui.fam = null; drawDock(puzzle, game); return; }  // toggle closed
      ui.fam = f;
      ui.step = f === "pass" ? "pass" : "family";
      if (f === "pass") ui.pass = { target: null, routes: { WR1: "slant", WR2: "out", TE: "hitch", RB: "flat" }, pa: false, roll: false, oob: false };
      drawDock(puzzle, game);
    });
    dock.querySelectorAll(".side").forEach(b => b.onclick = () => onCall(puzzle, game, { family: "run", base: "Run", side: b.dataset.side }));
    dock.querySelectorAll(".spec").forEach(b => b.onclick = () => onCall(puzzle, game, { special: b.dataset.spec }));
    return;
  }

  if (ui.step === "pass") return drawPassPainter(puzzle, game);

  // run detail rows
  let html = `<h2>${FAM[ui.fam]}</h2><div class="plays">`;
  for (const row of runPassRows(puzzle, game, ui.fam)) {
    html += `<div class="prow"><div class="lab">${row.base}</div><div class="sides">`;
    for (const sd of row.sides)
      html += `<button class="btn act primary side" data-side="${sd.sd}">${sd.label}</button>`;
    html += `</div></div>`;
  }
  html += `</div><button class="btn ghost back">◀ Back</button>`;
  dock.innerHTML = html;
  dock.querySelectorAll(".side").forEach(b => b.onclick = () => onCall(puzzle, game, { family: "run", base: "Run", side: b.dataset.side }));
  dock.querySelector(".back").onclick = () => { ui.step = "family"; drawDock(puzzle, game); };
}

function drawPassPainter(puzzle, game) {
  const ui = game._ui;
  let html = `<h2>Pass — set your routes</h2><div class="rcvrow">`;
  for (const slot of Object.keys(ROUTES)) {
    const rt = ui.pass.routes[slot];
    html += `<button class="btn act gold rcv" data-slot="${slot}">${slot}<small>${ROUTE_NAME[rt]}</small></button>`;
  }
  html += `</div>
  <div class="prow"><div class="lab">Target</div><div class="sides" id="targets">
    ${Object.keys(ROUTES).map(s => `<button class="btn act primary tgt ${ui.pass.target === s ? "on" : ""}" data-slot="${s}">${s}</button>`).join("")}
  </div></div>
  <div class="togrow">
    <button class="btn gold chip ${ui.pass.pa ? "on" : ""}" data-mod="pa">Play action</button>
    <button class="btn gold chip ${ui.pass.roll ? "on" : ""}" data-mod="roll">Roll out</button>
    <button class="btn gold chip ${ui.pass.oob ? "on" : ""}" data-mod="oob">Get out of bounds <small>no guarantee</small></button>
  </div>
  <button id="throw" class="btn primary big">Throw it</button>
  <button class="btn ghost back">◀ Back</button>`;
  const dock = $("#dock");
  dock.innerHTML = html;
  const redraw = () => { drawDock(puzzle, game); game._field.setRoutes(ui.pass.routes); };
  dock.querySelectorAll(".rcv").forEach(b => b.onclick = () => {
    const slot = b.dataset.slot;
    const list = ROUTES[slot];
    ui.pass.routes[slot] = list[(list.indexOf(ui.pass.routes[slot]) + 1) % list.length];
    redraw();
  });
  dock.querySelectorAll(".tgt").forEach(b => b.onclick = () => {
    ui.pass.target = ui.pass.target === b.dataset.slot ? null : b.dataset.slot;
    drawDock(puzzle, game);
  });
  dock.querySelectorAll(".chip").forEach(b => b.onclick = () => {
    ui.pass[b.dataset.mod] = !ui.pass[b.dataset.mod];
    drawDock(puzzle, game);
  });
  dock.querySelector("#throw").onclick = () => {
    if (!ui.pass.target) { ui.pass.target = "WR1"; }
    const depth = routeDepth(ui.pass.routes[ui.pass.target]);
    onCall(puzzle, game, { family: "pass", base: depth === "deep" ? "Deep pass" : "Quick pass", side: "middle", target: ui.pass.target, depth, oob: ui.pass.oob });
  };
  dock.querySelector(".back").onclick = () => { ui.step = "family"; drawDock(puzzle, game); };
  game._field.setRoutes(ui.pass.routes);
}

function drawTryPicker(game) {
  const dock = $("#dock");
  dock.innerHTML = `<h2>Touchdown — the try</h2>
    <div class="famrow">
      <button class="btn act primary spec" data-try="xp">Kick the XP</button>
      <button class="btn act gold spec" data-try="two">Go for two</button>
    </div>`;
  dock.querySelectorAll(".spec").forEach(b => b.onclick = () => {
    const entry = game.chooseTry(b.dataset.try);
    updateSituation(puzzle_, game);
    appendLog(entry);
    drawDock(puzzle_, game);
    if (game.over) renderEnd(puzzle_, game);
  });
}

let puzzle_ = null; // active puzzle ref for handlers

function playScript(entry, prev) {
  const d = (entry.realPlay?.desc || entry.desc || "").toUpperCase();
  const p = { kind: entry.cat, callout: null };
  if (entry.cat === "pass") {
    const ydsM = d.match(/FOR (-?[\d]+) YARDS?/);
    p.target = entry.matched ? (entry.realPlay.call?.target || "WR1") : (entry.desc.includes("out of bounds") ? "WR2" : "WR1");
    p.depth = /DEEP/.test(d) || (entry.realPlay?.call?.depth === "deep") ? "deep" : "short";
    if (d.includes("INCOMPLETE")) { p.result = "incomplete"; p.yards = 0; }
    else { p.result = d.includes("TOUCHDOWN") ? "td" : "complete"; p.yards = ydsM ? Math.max(1, prev.yardline - gameYards(entry)) : 8; }
    if (d.includes("SACKED")) { p.kind = "run"; p.result = "sack"; p.yards = 0; }
    if (d.includes("INTERCEPTED")) { p.result = "int"; }
    p.oob = d.includes("PUSHED OB") || d.includes("RUNS OB");
  } else if (entry.cat === "run") {
    const ydsM = d.match(/FOR (-?[\d]+) YARDS?/);
    p.side = entry.matched ? (entry.realPlay.call?.side || "middle") : "middle";
    p.result = d.includes("TOUCHDOWN") ? "td" : "run";
    p.yards = ydsM ? Math.max(1, prev.yardline - gameYards(entry)) : 4;
  } else if (entry.cat === "field_goal") {
    p.result = d.includes("GOOD") ? "good" : "no_good";
    p.callout = { text: d.includes("GOOD") ? "FIELD GOAL" : "NO GOOD", color: d.includes("GOOD") ? "#2fbf71" : "#e5484d" };
  }
  return p;
}
function gameYards(entry) { return entry.realPlay ? entry.realPlay.yardline : null; }

async function onCall(puzzle, game, call) {
  puzzle_ = puzzle;
  const prev = { ...game.state };
  const entry = game.choose(call);
  if (!entry) return;
  game._field.setRoutes(null);
  $("#dock").style.pointerEvents = "none";
  if (!entry.neutral) {
    const script = playScript(entry, prev);
    if (script.kind === "pass" || script.kind === "run") {
      await game._field.animatePlay(script, prev.yardline).catch(() => {});
    }
  }
  $("#dock").style.pointerEvents = "";
  updateSituation(puzzle, game);
  appendLog(entry, prev, game);
  drawDock(puzzle, game);
  if (game.over) renderEnd(puzzle, game);
  else if (game.pendingTry) drawDock(puzzle, game);
}

function appendLog(entry, prev, game) {
  const el = document.createElement("div");
  el.className = "play-entry";
  if (entry.neutral) {
    el.classList.add("neutral");
    el.innerHTML = `<span class="desc">${entry.desc}</span>`;
  } else {
    const gi = Game.gradeIndex(entry.grade);
    el.classList.add(`g${gi}`);
    const pct = (entry.grade >= 0 ? "+" : "") + (entry.grade * 100).toFixed(1);
    const matchTag = entry.matched ? "" : " <em>(off script)</em>";
    el.innerHTML = `
      <div class="play-head">
        <span class="grade">${GRADE_ICON[gi]}</span>
        <span class="call">${CAT_LABEL[entry.cat] || entry.cat}${matchTag}</span>
        <span class="delta">${pct} pp</span>
      </div>
      <div class="desc">${entry.desc}</div>`;
    if (prev) {
      const yds = prev.yardline - game.state.yardline;
      const d = entry.desc.toUpperCase();
      const banner = d.includes("TOUCHDOWN") ? "TOUCHDOWN"
        : entry.cat === "field_goal" ? (d.includes("GOOD") ? "FIELD GOAL" : "MISSED FG")
        : d.includes("INCOMPLETE") ? "INCOMPLETE"
        : yds > 0 ? `+${yds} YDS` : yds < 0 ? `${yds} YDS` : "NO GAIN";
      game._field.flash(banner, gi);
    }
    el.appendChild(reviewTable(entry, game));
  }
  $("#log").prepend(el);
}

/* collapsed per-call review table: every option, NFL usage, expected win prob */
function reviewTable(entry, game) {
  const u = game.usageTable() || {};
  const opts = [
    ["Run", u.run ?? null, fmtExp(game.expected("run"))],
    ["Pass", u.pass ?? null, fmtExp(game.expected("pass"))],
    ["Field goal", u.field_goal ?? null, fmtExp(game.expected("field_goal"))],
  ];
  let bestIdx = 0;
  opts.forEach((o, i) => { if (parseFloat(o[2]) > parseFloat(opts[bestIdx][2])) bestIdx = i; });
  opts[bestIdx][3] = "best";
  if (entry.cat === "run") opts[0][3] = "you";
  if (entry.cat === "pass") opts[1][3] = "you";
  if (entry.cat === "field_goal") opts[2][3] = "you";
  const det = document.createElement("details");
  det.className = "review";
  det.innerHTML = `<summary>Compare with the league</summary><table>
    <tr><th>Call</th><th>NFL use</th><th>Exp. WP</th></tr>
    ${opts.map(o => `<tr class="${o[3] || ""}"><td>${o[0]}${o[3] === "you" ? " (you)" : o[3] === "best" ? " ★" : ""}</td><td>${typeof o[1] === "number" ? Math.round(o[1] * 100) + "%" : "—"}</td><td>${o[2]}</td></tr>`).join("")}
  </table>`;
  return det;
}
const fmtExp = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

function renderEnd(puzzle, game) {
  $("#dock").innerHTML = "";
  const style = game.coachStyle();
  const grades = game.log.filter(l => !l.neutral).map(l => GRADE_ICON[Game.gradeIndex(l.grade)]).join("");
  const g = puzzle.game;
  const realRow = REAL_ICON[puzzle.result] ?? puzzle.result;
  const share = shareText(puzzle, game);
  $("#end").innerHTML = `
  <section class="card end ${game.won ? "win" : "loss"}">
    <h1>${game.won ? "🏆 You did it!" : "💀 The drive dies"}</h1>
    <p class="end-sub">${game.won
      ? `${g.posteam} take the lead — the stadium erupts.`
      : `Final: trail by ${Math.abs(game.state.scoreDiff)}. Coach ${g.defteam} sleeps easy.`}</p>
    <div class="end-grid">
      <div><span class="k">Win prob</span><span class="v">${Math.round(game.wp * 100)}%</span></div>
      <div><span class="k">Calls graded</span><span class="v">${grades || "—"}</span></div>
      <div><span class="k">You</span><span class="v">${game.won ? "WIN" : "LOSS"}</span></div>
      <div><span class="k">Real coach</span><span class="v">${realRow}</span></div>
    </div>
    <div class="style">
      <h3>Your style: ${style.name}</h3>
      <p>${style.note}</p>
    </div>
    <div class="end-acts">
      <button id="share" class="btn primary">📋 Copy share card</button>
      <button id="another" class="btn">🔁 Play another drive</button>
    </div>
    <p class="hint">Compare with the real drive below — every real call, in order.</p>
  </section>
  <section class="card realdrive">
    <h2>The Real Drive</h2>
    ${puzzle.plays.map(p => `
      <div class="rd-play">
        <span class="rd-clock">${fmtClock(p.seconds)}</span>
        <span class="rd-cat">${CAT_LABEL[p.cat] || p.cat}</span>
        <span class="rd-desc">${p.desc}</span>
      </div>`).join("")}
    <p class="hint">Real result: <b>${puzzle.result}</b></p>
  </section>`;
  $("#share").onclick = async () => {
    try { await navigator.clipboard.writeText(share); $("#share").textContent = "✅ Copied — go paste it"; }
    catch { prompt("Copy your result:", share); }
  };
  $("#another").onclick = () => {
    const p2 = PUZZLES[Math.floor(Math.random() * PUZZLES.length)];
    const g2 = new Game(p2, BASELINES);
    document.title = `${p2.game.away} @ ${p2.game.home} — Final Drive`;
    renderGame(p2, g2);
  };
}


/* player card overlay on the field */
function showPlayerCard(puzzle, game, slot) {
  const prof = puzzle.participants?.[slot];
  if (!prof) return;
  const pl = PROFILES[prof.name] || prof;
  const pos = game._field.slotPos(slot);
  const box = $("#fieldbox");
  let card = box.querySelector(".pcard");
  if (card && card.dataset.slot === slot) { card.remove(); return; }
  card?.remove();
  card = document.createElement("div");
  card.className = "pcard";
  card.dataset.slot = slot;
  card.innerHTML = `
    <div class="pc-head"><b>${pl.name}</b><span>${prof.no != null ? "#" + prof.no : ""} ${pl.pos || ""}</span></div>
    ${pl.blurb ? `<div class="pc-blurb">${pl.blurb}</div>` : ""}
    ${game._ui?.step === "pass" && game._ui.pass ? `<button class="btn gold chip pc-route">Route: ${ROUTE_NAME[game._ui.pass.routes[slot]]} — tap to change</button>` : ""}`;
  const fb = box.getBoundingClientRect();
  const scale = fb.width / 360;
  const x = Math.min(Math.max(pos.x * scale, 90), fb.width - 90);
  const y = Math.min(pos.y * scale + 20, fb.height - 110);
  card.style.left = `${x}px`; card.style.top = `${y}px`;
  box.appendChild(card);
  card.querySelector(".pc-route")?.addEventListener("click", () => {
    const list = ROUTES[slot];
    game._ui.pass.routes[slot] = list[(list.indexOf(game._ui.pass.routes[slot]) + 1) % list.length];
    drawDock(puzzle, game);
    showPlayerCard(puzzle, game, slot);   // refresh label
  });
}
