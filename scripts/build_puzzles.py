"""Build puzzle JSON (drive replays) + call-grading baselines from pbp data."""
import json
import math
from collections import defaultdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"
SITE_DATA.mkdir(parents=True, exist_ok=True)

CATS = ["run", "pass", "spike", "kneel", "field_goal", "punt"]
TOP_N = 40


def load_pbp() -> pd.DataFrame:
    return pd.concat(
        [pd.read_parquet(DATA / f"pbp_{s}.parquet") for s in (2023, 2024, 2025, 2026)],
        ignore_index=True,
    )


def cat_of(row) -> str | None:
    pt = row.get("play_type")
    if pt == "run":
        return "run"
    if pt == "pass":
        return "pass"
    if pt in ("qb_spike",):
        return "spike"
    if pt in ("qb_kneel",):
        return "kneel"
    if pt == "field_goal":
        return "field_goal"
    if pt == "punt":
        return "punt"
    return None


def bucket_down(d):
    return int(d) if d in (1, 2, 3, 4) else 0


def bucket_dist(d):
    d = int(d)
    return "short" if d <= 3 else "mid" if d <= 7 else "long"


def bucket_diff(d):
    d = int(d)
    return "close" if d >= -3 else "td" if d >= -8 else "far"


def bucket_time(s):
    s = int(s)
    return "le30" if s <= 30 else "le60" if s <= 60 else "le120"


def key(down, dist, diff, secs):
    return f"{down}|{dist}|{diff}|{secs}"


SLOTS = ["WR1", "WR2", "TE", "RB"]


def slot_for_name(name: str) -> str:
    import hashlib
    if not name:
        return "WR1"
    return SLOTS[int(hashlib.md5(name.encode()).hexdigest(), 16) % len(SLOTS)]


def call_descriptor(p) -> dict | None:
    """Map a pbp play to (family, base, side, target_slot, depth)."""
    import re
    if p["play_type"] == "run":
        loc = p.get("run_location")
        side = {"left": "strong", "right": "weak", "middle": "middle"}.get(loc, "middle")
        return {"family": "run", "base": "Run", "side": side}
    if p["play_type"] == "pass":
        desc = str(p["desc"])
        m = re.search(r"pass (?:short|deep) (\w+)(?: to ([A-Z][A-Za-z.\-' ]+?))?[ (.]", desc + " (")
        loc = p.get("pass_location")
        side = {"left": "strong", "right": "weak", "middle": "middle"}.get(loc, "middle")
        pl_len = p.get("pass_length")
        depth = None if pd.isna(pl_len) else pl_len
        depth = depth if depth in ("short", "deep") else "short"
        rec = (m.group(2).strip() if m and m.group(2) else None) or None
        return {"family": "pass", "base": "Deep pass" if depth == "deep" else "Quick pass",
                "side": side, "target": slot_for_name(rec), "depth": depth}
    return None


def main():
    pbp = load_pbp()
    cand = pd.read_csv(DATA / "candidates.csv")

    # one drive per game, top swings
    picked, seen = [], set()
    for _, r in cand.iterrows():
        if r["game_id"] in seen:
            continue
        seen.add(r["game_id"])
        picked.append(r)
        if len(picked) >= TOP_N:
            break

    # ---- baselines: mean wp delta by call category per situation bucket ----
    pbp["wp_before"] = pbp.groupby("game_id")["wp"].shift(1)
    late = pbp[
        pbp["game_seconds_remaining"].between(1, 180)
        & pbp["wp"].notna()
        & pbp["wp_before"].notna()
    ].copy()
    late["cat"] = late.apply(cat_of, axis=1)
    late = late[late["cat"].notna() & late["down"].notna()]
    late["delta"] = late["wp"] - late["wp_before"]

    agg = defaultdict(list)
    usage = defaultdict(lambda: defaultdict(int))
    for _, r in late.iterrows():
        k = key(bucket_down(r["down"]), bucket_dist(r["ydstogo"]),
                bucket_diff(r["score_differential"]), bucket_time(r["game_seconds_remaining"]))
        agg[(k, r["cat"])].append(r["delta"])
        usage[k][r["cat"]] += 1
    baselines = defaultdict(dict)
    for (k, cat), vals in agg.items():
        if len(vals) >= 8:
            baselines[k][cat] = round(sum(vals) / len(vals), 4)
    usage_table = {}
    for k, cats in usage.items():
        tot = sum(cats.values())
        if tot >= 20:
            usage_table[k] = {c: round(n / tot, 3) for c, n in sorted(cats.items(), key=lambda x: -x[1])}

    # FG success rate by 5-yard bucket of kick distance (yardline_100 + 17)
    fgs = pbp[(pbp["play_type"] == "field_goal") & pbp["field_goal_result"].notna()]
    fg_rate = {}
    for _, r in fgs.iterrows():
        b = min(60, int((int(r["yardline_100"]) + 17) // 5) * 5)
        made, tot = fg_rate.get(b, (0, 0))
        fg_rate[b] = (made + (1 if r["field_goal_result"] == "made" else 0), tot + 1)
    fg_table = {b: round(m / t, 3) for b, (m, t) in sorted(fg_rate.items()) if t >= 10}

    # ---- puzzles ----
    puzzles = []
    for r in picked:
        g = pbp[(pbp["game_id"] == r["game_id"])
                & (pbp["game_seconds_remaining"] <= r["start_seconds"] + 5)
                & (pbp["drive"] == r["drive"])].sort_values("play_id")
        all_rows = pbp[pbp["game_id"] == r["game_id"]].sort_values("play_id")
        last_game_row = all_rows.iloc[-1]
        start_diff = None
        plays = []
        last_wp = None
        cum_pts = 0
        for _, p in g.iterrows():
            if p["play_type"] in ("no_play", "timeout") or p["desc"] is None:
                continue
            c = cat_of(p)
            if c is None:
                continue
            if start_diff is None:
                start_diff = int(p["score_differential"])
            # points scored on this play (score_differential is pre-play);
            # a TD's try is split out as a separate player decision, not folded in
            pts = 0
            ended = False
            try_info = None
            if p.get("touchdown") == 1:
                pts += 6
                ended = True
                idx0 = g.index.get_loc(p.name if p.name in g.index else g.index[-1])
                for _, q in g.iloc[idx0 + 1: idx0 + 4].iterrows():
                    if q.get("extra_point_result"):
                        try_info = {"type": "xp", "good": q["extra_point_result"] == "good"}
                        break
                    if str(q.get("two_point_conv_result", "")) in ("success", "fail"):
                        try_info = {"type": "two", "good": q["two_point_conv_result"] == "success"}
                        break
                    if q.get("play_type") != "no_play":
                        break
            elif c == "field_goal":
                ended = True
                if p["field_goal_result"] == "made":
                    pts += 3
            cum_pts += pts
            entry = {
                "cat": c,
                "desc": str(p["desc"]).strip(),
                "qtr": int(p["qtr"]),
                "seconds": int(p["game_seconds_remaining"]),
                "down": None if pd.isna(p["down"]) else int(p["down"]),
                "distance": None if pd.isna(p["ydstogo"]) else int(p["ydstogo"]),
                "yardline": None if pd.isna(p["yardline_100"]) else int(p["yardline_100"]),
                "score_diff": start_diff + cum_pts,
                "wp": None if pd.isna(p["wp"]) else round(float(p["wp"]), 3),
                "wp_before": None if pd.isna(p["wp_before"]) else round(float(p["wp_before"]), 3),
                "clock_before": int(p["game_seconds_remaining"]) + int(p.get("clock_time", 0) or 0),
            }
            cd = call_descriptor(p)
            if cd:
                entry["call"] = cd
            if try_info:
                entry["try"] = try_info
            plays.append(entry)
            if plays[-1]["wp"] is not None:
                last_wp = plays[-1]["wp"]
            if ended:
                break
        if len(plays) < 3:
            continue
        first = plays[0]
        g0 = g[g["play_type"] != "timeout"].iloc[0]
        to = g0.get("posteam_timeouts_remaining")
        slug = f"{r['season']}-w{int(r['week'])}-{str(r['posteam']).lower()}-{str(r['defteam']).lower()}-{first['seconds']}".replace(" ", "")
        result = g.iloc[-1].get("fixed_drive_result", "")
        puzzles.append({
            "slug": slug,
            "game": {
                "season": int(r["season"]), "week": int(r["week"]),
                "date": str(r.get("game_date", "")),
                "home": r["home"], "away": r["away"],
                "posteam": r["posteam"], "defteam": r["defteam"],
            },
            "start": {
                "qtr": first["qtr"], "seconds": first["seconds"],
                "down": first["down"], "distance": first["distance"],
                "yardline": first["yardline"], "score_diff": first["score_diff"],
                "posteam_score": int(g0["posteam_score"]),
                "defteam_score": int(g0["defteam_score"]),
                "timeouts": None if pd.isna(to) else int(to),
            },
            "plays": plays,
            "result": str(result),
            "final_wp": last_wp,
            "real_final_score_diff": start_diff + cum_pts,
        })

    (SITE_DATA / "puzzles.json").write_text(json.dumps(puzzles, indent=1), encoding="utf-8")
    (SITE_DATA / "baselines.json").write_text(json.dumps({
        "wp_delta": dict(baselines), "fg_rate": fg_table, "usage": usage_table,
    }, indent=1), encoding="utf-8")
    print(f"{len(puzzles)} puzzles, {len(baselines)} baseline buckets, {len(fg_table)} fg buckets")
    for p in puzzles[:5]:
        print(p["slug"], p["start"], p["result"])


if __name__ == "__main__":
    main()
