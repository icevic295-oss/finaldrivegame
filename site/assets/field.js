/* Broadcast-style SVG football field renderer — vertical orientation.
   Offense (posteam) starts at the bottom and drives UP toward the top end zone. */

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};

export function createField(container, { posteam, defteam, numbers = {} }) {
  container.innerHTML = "";
  const W = 360, H = 620, EZ = 78;                 // end zone height
  const T = H - EZ - 8, B = EZ + 8;                // goal line tops
  const Y = (ydTraveled) => T - (ydTraveled / 100) * (T - B); // bottom(0) → top(100)
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "field-svg" });

  // turf + stripes
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, rx: 14, fill: "#0d2a17" }));
  for (let i = 0; i < 10; i++) {
    const y0 = Y(i * 10), y1 = Y((i + 1) * 10);
    if (i % 2 === 0) svg.appendChild(el("rect", { x: 8, y: y1, width: W - 16, height: y0 - y1, fill: "#ffffff", opacity: 0.03 }));
  }

  // end zones: top = defense (red), bottom = offense (blue)
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: EZ, rx: 14, fill: "#3d1220" }));
  const ezT = el("text", { x: W / 2, y: EZ / 2 + 9, class: "ez-text" }, defteam);
  svg.appendChild(ezT);
  svg.appendChild(el("rect", { x: 0, y: H - EZ, width: W, height: EZ, rx: 14, fill: "#132b3d" }));
  const ezB = el("text", { x: W / 2, y: H - EZ / 2 + 9, class: "ez-text" }, posteam);
  svg.appendChild(ezB);
  svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, rx: 14, fill: "none", stroke: "#ffffff22", "stroke-width": 2 }));

  // yard lines every 5, numbers every 10
  for (let yd = 5; yd < 100; yd += 5) {
    const big = yd % 10 === 0;
    const y = Y(yd);
    svg.appendChild(el("line", { x1: 14, y1: y, x2: W - 14, y2: y, stroke: "#ffffff", opacity: big ? 0.55 : 0.3, "stroke-width": big ? 2 : 1 }));
    if (big) {
      const n = yd <= 50 ? yd : 100 - yd;
      svg.appendChild(el("text", { x: 40, y: y + 7, class: "field-num" }, String(n)));
      svg.appendChild(el("text", { x: W - 40, y: y + 7, class: "field-num" }, String(n)));
    }
  }
  // hash marks
  for (let yd = 1; yd < 100; yd++) {
    if (yd % 5 === 0) continue;
    const y = Y(yd);
    for (const hx of [W * 0.36, W * 0.64]) {
      svg.appendChild(el("line", { x1: hx - 5, y1: y, x2: hx + 5, y2: y, stroke: "#ffffff", opacity: 0.35, "stroke-width": 1.5 }));
    }
  }
  // midfield mark
  svg.appendChild(el("text", { x: W / 2, y: Y(50) - 8, class: "field-logo" }, "FINAL DRIVE"));

  // first down (gold) + LOS (blue) — horizontal
  const fdLine = el("line", { x1: 10, x2: W - 10, stroke: "#ffcf40", "stroke-width": 3, id: "fd-line" });
  svg.appendChild(fdLine);
  const losLine = el("line", { x1: 10, x2: W - 10, stroke: "#3b82f6", "stroke-width": 3, id: "los-line" });
  svg.appendChild(losLine);

  // generic formation, moves with the ball (LOS horizontal, offense below it)
  const formation = el("g", { id: "formation" });
  svg.appendChild(formation);
  // route lines (pass painter)
  const routesG = el("g", { id: "routes" });
  svg.appendChild(routesG);

  // receiver screen positions relative to ball x-center: [dx from center, dy from ballY]
  const RECV = {
    WR1: { dx: -122, dy: -30 }, WR2: { dx: 122, dy: -30 },
    TE: { dx: 62, dy: 6 }, RB: { dx: 26, dy: 34 },
  };
  function recvPoses() {
    const y = Y(100 - _curSafe());
    for (const [slot, p] of Object.entries(RECV)) recvPos[slot] = { x: W / 2 + p.dx, y: y + p.dy };
  }
  function _curSafe() { return _cur?.yardline ?? 25; }
  const ROUTE_SHAPE = {
    slant: [[26, -18], [46, -30]], hitch: [[0, -14], [2, -2]],
    out: [[10, -12], [64, -16]], in: [[10, -12], [-52, -16]],
    post: [[16, -22], [30, -54]], corner: [[16, -22], [-26, -52]],
    go: [[4, -60]], screen: [[-8, 18], [-40, 8]],
    flat: [[-46, 6]], cross: [[12, -10], [-60, -8]],
    wheel: [[30, 10], [42, -44]], angle: [[16, 8], [34, -18]],
  };

  // ball marker (points up the field)
  const ball = el("g", { id: "ball", style: "transition: transform .7s cubic-bezier(.22,1,.36,1)" });
  ball.appendChild(el("polygon", { points: "0,-15 7,-25 15,-13 8,-4", fill: "#e5484d", stroke: "#fff", "stroke-width": 1.5 }));
  ball.appendChild(el("ellipse", { cx: 0, cy: 4, rx: 7, ry: 5, fill: "#7a3c10", stroke: "#fff", "stroke-width": 1.5 }));
  ball.appendChild(el("line", { x1: -4, y1: 4, x2: 4, y2: 4, stroke: "#fff", "stroke-width": 1.5 }));
  svg.appendChild(ball);

  // result banner
  const banner = el("g", { id: "banner", opacity: 0, style: "transition: opacity .25s" });
  banner.appendChild(el("rect", { x: W / 2 - 105, y: H / 2 - 30, width: 210, height: 54, rx: 10, fill: "#000d", stroke: "#ffffff33" }));
  banner.appendChild(el("text", { x: W / 2, y: H / 2 + 4, id: "banner-text", class: "banner-text" }));
  svg.appendChild(banner);

  container.appendChild(svg);

  const recvPos = {};   // slot -> {x, y} svg coords
  function drawFormation(ydTraveled) {
    formation.innerHTML = "";
    recvPoses();
    const y = Y(ydTraveled);
    const cx = W / 2;
    const P = (x, yy, team, num, recv) => {
      const g = el("g", recv ? { class: "recv", "data-slot": recv, transform: `translate(${x},${yy})` }
                          : { transform: `translate(${x},${yy})` });
      g.appendChild(el("circle", { r: 11, fill: team === "o" ? "#f4f6f8" : "#1d2630", stroke: team === "o" ? "#17212b" : "#8fa3b0", "stroke-width": 2 }));
      g.appendChild(el("text", { y: 4, class: "player-num", fill: team === "o" ? "#17212b" : "#e8eef3" }, recv ? (numbers[recv] ?? num) : num));
      if (recv) {
        g.appendChild(el("circle", { cy: -15, r: 7, class: "recv-info", fill: "#ffcf40" }));
        g.appendChild(el("text", { y: -12, class: "player-num", fill: "#17212b", "text-anchor": "middle" }, "i"));
      }
      formation.appendChild(g);
    };
    [-56, -28, 0, 28, 56].forEach((dx, i) => P(cx + dx, y + 22, "o", String(i + 61))); // OL on the LOS
    P(cx, y + 2, "o", "7");       // QB under center
    P(cx + 30, y + 42, "o", "28", "RB");
    P(cx - 122, y - 30, "o", "11", "WR1"); P(cx + 122, y - 30, "o", "80", "WR2");
    P(cx + 62, y + 6, "o", "85", "TE");
    [-16, -5, 5, 16].forEach((dx, i) => P(cx + dx, y - 20, "d", String(9 - i))); // LBs
  }

  /* routes: {WR1:'slant',...} — draws each route as a polyline from the receiver */
  function setRoutes(routes) {
    routesG.innerHTML = "";
    if (!routes) return;
    const ydTraveled = 100 - _cur.yardline;
    const y = Y(ydTraveled), cx = W / 2;
    for (const [slot, rt] of Object.entries(routes)) {
      const pos = RECV[slot];
      if (!pos || !rt) continue;
      const pts = ROUTE_SHAPE[rt] || [[0, -20]];
      let px = cx + pos.dx, py = y + pos.dy;
      let d = `M ${px} ${py}`;
      for (const [dx, dy] of pts) { px += dx; py += dy; d += ` L ${px} ${py}`; }
      routesG.appendChild(el("path", { d, fill: "none", stroke: "#ffcf40", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.9 }));
    }
  }

  let _cur = { yardline: 25, distance: 10 };
  function update({ yardline, distance }) {
    const traveled = 100 - yardline;                 // yards from own goal (bottom)
    const fdTraveled = Math.min(100, traveled + distance);
    _cur = { yardline, distance };
    ball.style.transform = `translate(${W / 2}px, ${Y(traveled) - 6}px)`;
    losLine.setAttribute("y1", Y(traveled)); losLine.setAttribute("y2", Y(traveled));
    if (fdTraveled < 100) {
      fdLine.style.display = "";
      fdLine.setAttribute("y1", Y(fdTraveled)); fdLine.setAttribute("y2", Y(fdTraveled));
    } else fdLine.style.display = "none";
    drawFormation(traveled);
  }

  function flash(text, gradeIdx) {
    const t = svg.querySelector("#banner-text");
    t.textContent = text;
    t.setAttribute("fill", ["#2fbf71", "#e3b341", "#f08a3c", "#e5484d"][gradeIdx ?? 1]);
    banner.setAttribute("opacity", "1");
    clearTimeout(flash._t);
    flash._t = setTimeout(() => banner.setAttribute("opacity", "0"), 1600);
  }

  update({ yardline: 25, distance: 10 });

  // taps on receivers/info badges: cb(slot, kind) where kind is 'route'|'info'
  function onRecvTap(cb) {
    svg.addEventListener("click", (ev) => {
      const g = ev.target.closest(".recv");
      if (!g) return;
      const slot = g.dataset.slot;
      cb(slot, ev.target.classList.contains("recv-info") || ev.target.textContent === "i" ? "info" : "route");
    });
  }
  /* ---------------- play animation ----------------
     Broadcast-style timeline driven by real play facts:
     PRE (huddle) -> ZI (camera pushes in) -> T (the play) -> hold -> ZO (camera out).
     Skippable by tapping the field; disabled by prefers-reduced-motion. */
  const EASE = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FULL = () => ({ x: 0, y: 0, w: W, h: H });
  function setCam(v) { svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`); }
  function camFor(pt, zoom) {
    const vw = W / zoom, vh = H / zoom;
    return { x: Math.max(-6, Math.min(W - vw + 6, pt.x - vw / 2)),
             y: Math.max(-6, Math.min(H - vh + 6, pt.y - vh / 2)), w: vw, h: vh };
  }
  const YPX = (T - B) / 100;

  /* play: {kind, target?, depth?, yards?, result, oob?, callout?} */
  function animatePlay(play, fromYardline) {
    return new Promise((resolve) => {
      if (REDUCED) { resolve(false); return; }
      try {
        const traveled = 100 - (fromYardline ?? _cur.yardline);
        const y0 = Y(traveled), cx = W / 2;
        const qb = { x: cx, y: y0 + 2 };
        let T = 0.9, tgt = null, land = null, defFrom = null;

        const slot = play.target && RECV[play.target] ? play.target : "WR1";
        const rp = RECV[slot];
        const depthYds = play.depth === "deep" ? 20 : 8;
        const startX = cx + rp.dx, startY = y0 + rp.dy;

        if (play.kind === "pass") {
          const air = play.result === "incomplete" ? depthYds : Math.max(depthYds * 0.55, (play.yards ?? depthYds) * 0.8);
          land = { x: Math.max(24, Math.min(W - 24, startX + (cx - startX) * 0.25)), y: y0 - air * YPX };
          tgt = { from: { x: startX, y: startY }, to: { ...land }, t0: 0.15, t1: 1.1 };
          defFrom = { x: cx + (rp.dx > 0 ? 90 : -90), y: y0 - 20 };
          T = 1.5 + depthYds / 20;
        } else if (play.kind === "run") {
          const gap = play.side === "strong" ? 1 : play.side === "weak" ? -1 : 0;
          land = { x: cx + gap * 60, y: y0 - (play.yards ?? 4) * YPX - 6 };
          tgt = { from: { x: cx + 30, y: y0 + 34 }, to: { ...land }, t0: 0.55, t1: 1.4 };
          defFrom = { x: cx - gap * 30, y: y0 - 24 };
          T = 1.6;
        }
        const PRE = 0.45, ZI = 0.5, HOLD = 0.55, ZO = 0.45, total = PRE + ZI + T + HOLD + ZO;
        const camTo = camFor(land ? { x: (qb.x + land.x) / 2, y: (qb.y + land.y) / 2 } : qb, 1.7);
        const CO = play.callout || { text: "", kind: "info" };
        let callG = null, start = null, doneFlag = false;
        const skip = () => { doneFlag = true; };
        svg.classList.add("playing");
        svg.addEventListener("click", skip, { once: true });
        const finish = () => {
          svg.removeEventListener("click", skip);
          svg.classList.remove("playing");
          callG?.remove();
          setCam(FULL());
          resolve(true);
        };
        const lerp = (a, b, u) => a + (b - a) * u;
        const hardStop = setTimeout(() => { doneFlag = true; }, 9000);
        const frame = (now) => {
          try {
            if (start === null) start = now;
            const t = doneFlag ? total : (now - start) / 1000;
            const tt = t - PRE;
            const kIn = EASE(Math.max(0, Math.min(1, tt / ZI)));
            const kOut = EASE(Math.max(0, Math.min(1, (tt - ZI - T - HOLD) / ZO)));
            const f0 = FULL(), k = kIn * (1 - kOut);
            setCam({ x: lerp(f0.x, camTo.x, k), y: lerp(f0.y, camTo.y, k), w: lerp(f0.w, camTo.w, k), h: lerp(f0.h, camTo.h, k) });
            const tp = Math.max(0, Math.min(T, tt));
            if (tgt) {
              const u = Math.max(0, Math.min(1, (tp - tgt.t0) / (tgt.t1 - tgt.t0)));
              const gx = formation.querySelector(`.recv[data-slot="${slot}"]`);
              if (gx) {
                const ease = u < 0.75 ? u / 0.75 : 1;
                gx.setAttribute("transform", `translate(${lerp(tgt.from.x, tgt.to.x, ease).toFixed(1)},${lerp(tgt.from.y, tgt.to.y, ease).toFixed(1)})`);
              }
              const dg = formation.querySelectorAll("g")[formation.querySelectorAll("g").length - 4];
              if (dg && u > 0.3 && land) {
                const du = (u - 0.3) / 0.7;
                dg.setAttribute("transform", `translate(${(lerp(defFrom.x, land.x, du) - cx).toFixed(1)},${(lerp(defFrom.y, land.y, du) - y0).toFixed(1)})`);
              }
            }
            if (play.kind === "pass" && land) {
              const rel = 0.9 + depthYds / 30, airT = 0.55;
              if (tp > rel && tp < rel + airT + 0.6) {
                const u = Math.max(0, Math.min(1, (tp - rel) / airT));
                const z = 4 * u * (1 - u);
                ball.setAttribute("transform", `translate(${lerp(qb.x, land.x, u).toFixed(1)}px, ${lerp(qb.y, land.y, u).toFixed(1)}px) scale(${(1 + 0.5 * z).toFixed(2)})`);
                ball.style.opacity = 1;
              }
            }
            if (CO.text && tt > T - 0.05 && !callG) {
              callG = el("g", { class: `anim-call ${CO.kind}` });
              callG.appendChild(el("rect", { x: cx - 92, y: H / 2 - 26, width: 184, height: 46, rx: 9, fill: "#000d", stroke: "#ffffff44" }));
              callG.appendChild(el("text", { x: cx, y: H / 2 + 5, class: "banner-text", fill: CO.color || "#e8eef3" }, CO.text));
              svg.insertBefore(callG, banner);
            }
            if (t >= total) { clearTimeout(hardStop); finish(); return; }
            requestAnimationFrame(frame);
          } catch (err) { clearTimeout(hardStop); finish(); }
        };
        requestAnimationFrame(frame);
      } catch (err) { resolve(false); }
    });
  }
  return { update, flash, setRoutes, onRecvTap, slotPos: (slot) => recvPos[slot], animatePlay };
}
