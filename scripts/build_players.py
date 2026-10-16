"""Build player profiles (roster facts + season stats) and per-puzzle participants."""
import io
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"
SLOTS = ["WR1", "WR2", "TE", "RB"]
ROSTER_URL = "https://github.com/nflverse/nfldata/raw/master/data/rosters.csv"


def slot_for_name(name: str) -> str:
    import hashlib
    if not name:
        return "WR1"
    return SLOTS[int(hashlib.md5(name.encode()).hexdigest(), 16) % len(SLOTS)]


def fetch_rosters() -> pd.DataFrame:
    """Season rosters from nflverse-data releases (position, jersey no, college)."""
    f = DATA / "rosters_all.parquet"
    if f.exists():
        return pd.read_parquet(f)
    frames = []
    for season in (2023, 2024, 2025, 2026):
        u = f"https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.parquet"
        r = requests.get(u, timeout=180)
        if r.status_code != 200:
            print(f"  roster {season}: HTTP {r.status_code}")
            continue
        frames.append(pd.read_parquet(io.BytesIO(r.content)))
    df = pd.concat(frames, ignore_index=True)
    df.to_parquet(f)
    return df


def main():
    pbp = pd.concat([pd.read_parquet(DATA / f"pbp_{s}.parquet") for s in (2023, 2024, 2025, 2026)], ignore_index=True)
    puzzles = json.loads((SITE_DATA / "puzzles.json").read_text(encoding="utf-8"))
    try:
        roster = fetch_rosters()
    except Exception as e:
        print("roster fetch failed, positions/colleges will be blank:", e)
        roster = pd.DataFrame()

    # roster lookup: exact (team, season, last name, first initial) with graceful fallback
    ridx, ridxf = {}, {}
    if len(roster):
        for _, r in roster.iterrows():
            if pd.isna(r.get("last_name")) or pd.isna(r.get("first_name")):
                continue
            last = str(r["last_name"]).lower()
            ini = str(r["first_name"])[0].upper()
            season = int(r["season"])
            team = None if pd.isna(r.get("team")) else str(r["team"])
            rec = {
                "pos": None if pd.isna(r.get("position")) else str(r["position"]),
                "college": None if pd.isna(r.get("college")) else str(r["college"]),
                "no": None if pd.isna(r.get("jersey_number")) else int(r["jersey_number"]),
            }
            inis = {ini}
            fn = r.get("football_name")
            if not pd.isna(fn) and str(fn):
                inis.add(str(fn)[0].upper())
            for ii in inis:
                if team:
                    ridx.setdefault((team, season, last, ii), rec)
            cur = ridxf.get((season, last, ini))
            if cur is None:
                ridxf[(season, last, ini)] = rec

    def lookup(name: str, season: int, team: str | None):
        if "." not in name:
            return {}
        ini, last = name.split(".", 1)
        last = last.lower()
        if team:
            hit = ridx.get((team, season, last, ini))
            if hit:
                return hit
        hit = ridxf.get((season, last, ini))
        if hit:
            return hit
        # traded mid-season: nearest earlier season under any team
        cands = [(ss, rec) for (ss, ll, ii), rec in ridxf.items() if ll == last and ii == ini and ss <= season]
        if cands:
            return max(cands, key=lambda x: x[0])[1]
        return {}

    # season stats per player (receiving / rushing), keyed (name, season)
    recv = pbp[pbp["receiver_player_name"].notna()]
    stats = defaultdict(lambda: {"rec": 0, "rec_yds": 0, "rec_td": 0, "rush": 0, "rush_yds": 0, "rush_td": 0})
    for (name, season), g in recv.groupby(["receiver_player_name", "season"]):
        s = stats[(str(name), int(season))]
        s["rec"] = int(g["complete_pass"].sum())
        s["rec_yds"] = int(g["receiving_yards"].sum())
        s["rec_td"] = int(g["touchdown"].sum())
    rush = pbp[pbp["rusher_player_name"].notna() & (pbp["play_type"] == "run")]
    for (name, season), g in rush.groupby(["rusher_player_name", "season"]):
        s = stats[(str(name), int(season))]
        s["rush"] = len(g)
        s["rush_yds"] = int(g["rushing_yards"].sum())
        s["rush_td"] = int(g["touchdown"].sum())

    def profile(name: str, season: int | None = None, team: str | None = None) -> dict:
        n = str(name).strip()
        s = stats.get((n, season), {}) if season else {}
        hit = lookup(n, season, team) if season else {}
        return {
            "name": n,
            "pos": hit.get("pos"),
            "college": hit.get("college"),
            "rec": s.get("rec", 0), "rec_yds": s.get("rec_yds", 0), "rec_td": s.get("rec_td", 0),
            "rush": s.get("rush", 0), "rush_yds": s.get("rush_yds", 0), "rush_td": s.get("rush_td", 0),
        }

    def blurb(p: dict) -> str:
        parts = []
        if p.get("pos"):
            parts.append(p["pos"])
        if p.get("college"):
            parts.append(f"out of {p['college']}")
        head = " ".join(parts)
        stat_bits = []
        if p["rec"]:
            stat_bits.append(f"{p['rec']} catches, {p['rec_yds']} yards" + (f", {p['rec_td']} TDs" if p["rec_td"] else ""))
        if p["rush"]:
            stat_bits.append(f"{p['rush']} carries, {p['rush_yds']} yards" + (f", {p['rush_td']} TDs" if p["rush_td"] else ""))
        tail = "; " + ", ".join(stat_bits) + " this season." if stat_bits else "."
        return (head + tail) if head else tail.lstrip("; ")

    profiles = {}
    for p in puzzles:
        gmeta = p["game"]
        season = gmeta["season"]
        # QB = most common passer in the puzzle descs
        names = " ".join(pl["desc"] for pl in p["plays"])
        passers = re.findall(r"\d+-([A-Z][A-Za-z.\-' ]+?) pass", names)
        qb_nos = re.findall(r"\)\s*(\d+)-[A-Z][A-Za-z.\-' ]+? pass", names)
        qb = Counter(passers).most_common(1)
        participants = {"QB": {"no": int(qb_nos[0]) if qb_nos else None, **profile(qb[0][0], season, gmeta['posteam'])} if qb else None}
        # slots from pass targets: desc pattern "... pass short right to 83-J.Johnson ..."
        for pl in p["plays"]:
            if not pl.get("call") or pl["call"]["family"] != "pass":
                continue
            m = re.search(r"pass (?:short|deep) \w+ to (\d+)-([A-Z][A-Za-z.\-' ]+?)[ .(]", pl["desc"] + " ")
            if m and m.group(2):
                slot = pl["call"]["target"]
                if slot not in participants:
                    participants[slot] = {"no": int(m.group(1)), **profile(m.group(2).strip(), season, gmeta['posteam'])}
        # fallback: fill missing slots from the team's top pass catchers that season
        if participants.get("QB") is None:
            participants.pop("QB", None)
        for slot in SLOTS:
            if slot in participants:
                continue
            team_recs = recv[(recv["posteam"] == gmeta["posteam"]) & (recv["season"] == season)]
            if len(team_recs):
                top = team_recs.groupby("receiver_player_name")["receiving_yards"].sum().sort_values(ascending=False)
                for name in top.index:
                    prof = profile(name, season, gmeta['posteam'])
                    if all(participants.get(s2, {}).get("name") != prof["name"] for s2 in SLOTS if isinstance(participants.get(s2), dict)):
                        participants[slot] = {"no": None, **prof}
                        break
                if slot not in participants:
                    participants[slot] = {"no": None, **profile("Unknown")}
            else:
                participants[slot] = {"no": None, **profile("Unknown")}
        p["participants"] = participants
        for slot, prof in participants.items():
            if isinstance(prof, dict) and prof.get("name"):
                key = f"{prof['name']}"
                if key not in profiles:
                    pr = dict(prof)
                    pr["blurb"] = blurb(pr)
                    profiles[key] = pr

    (SITE_DATA / "players.json").write_text(json.dumps(profiles, indent=1), encoding="utf-8")
    (SITE_DATA / "puzzles.json").write_text(json.dumps(puzzles, indent=1), encoding="utf-8")
    print(f"{len(profiles)} player profiles; sample:")
    k = list(profiles)[0]
    print(k, "->", profiles[k]["blurb"])
    print("sample participants:", json.dumps(puzzles[0]["participants"], indent=1)[:600])


if __name__ == "__main__":
    main()
