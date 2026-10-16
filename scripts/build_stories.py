"""Generate factual game-context stories for every puzzle from nflverse data."""
import json
from collections import defaultdict
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"

# hand-written overrides for well-known games (verified name scenes only)
OVERRIDES = {
    # slug keyword: extra sentence(s) appended to the factual story
    "2023-w11-min-den": "Joshua Dobbs had arrived in Minnesota via trade only ten days earlier — and had just stunned the league. Denver, meanwhile, had turned its season around after an 0-3 start under a new coaching setup.",
    "2024-w18-pit-cin": "Week 18, the last week of the regular season — playoff seeding and momentum on the line in a division rivalry.",
}


def fetch_games() -> pd.DataFrame:
    f = DATA / "games.csv"
    if not f.exists():
        r = requests.get("https://github.com/nflverse/nfldata/raw/master/data/games.csv", timeout=120)
        r.raise_for_status()
        f.write_bytes(r.content)
    return pd.read_csv(f, low_memory=False)


def records_before(games: pd.DataFrame, season: int, week: int) -> dict:
    reg = games[(games["season"] == season) & (games["week"] < week) & (games["game_type"] == "REG")]
    rec = defaultdict(lambda: [0, 0, 0])  # w, l, t
    for _, g in reg.iterrows():
        hr, ar = rec[g["home_team"]], rec[g["away_team"]]
        if g["home_score"] > g["away_score"]:
            hr[0] += 1; ar[1] += 1
        elif g["home_score"] < g["away_score"]:
            ar[0] += 1; hr[1] += 1
        else:
            hr[2] += 1; ar[2] += 1
    return rec


def fmt(rec):
    w, l, t = rec
    return f"{w}-{l}" + (f"-{t}" if t else "")


def ordinal_w(w):
    return f"Week {week}" if (week := None) else None


ROUND = {"WC": "the Wild Card round", "DIV": "the Divisional round", "CONF": "the Conference Championship", "SB": "the Super Bowl"}


def story_for(p, games, rec):
    g = p["game"]
    post, deff = g["posteam"], g["defteam"]
    s = p["start"]
    pos_rec = rec.get(post, [0, 0, 0])
    def_rec = rec.get(deff, [0, 0, 0])

    q = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "overtime"}.get(s["qtr"], "")
    secs = s["seconds"]
    clock = f"{secs // 60}:{secs % 60:02d}"

    # round label for playoff weeks
    grow = games[(games["season"] == g["season"]) & (games["week"] == g["week"])
                 & (games["home_team"] == g["home"]) & (games["away_team"] == g["away"])]
    stage = None
    if len(grow) and grow.iloc[0].get("game_type") in ROUND:
        stage = ROUND[grow.iloc[0]["game_type"]]
    weektxt = f"{stage} of the {g['season']} playoffs" if stage else f"Week {g['week']} of the {g['season']} season"

    bits = []
    bits.append(f"{post} ({fmt(pos_rec)}) {'host' if deff == g['home'] else 'visit'} {deff} ({fmt(def_rec)}) in {weektxt}.")
    bits.append(f"They trail {s['defteam_score']}-{s['posteam_score']} with {clock} left in {'overtime' if s['qtr'] >= 5 else f'the {q} quarter'}, "
                f"ball at the {100 - s['yardline']}-yard line, {s['down']} & {s['distance']}, {s['timeouts']} timeout"
                f"{'s' if s['timeouts'] != 1 else ''} in hand.")
    pts = s["posteam_score"] + s["defteam_score"]
    if pts >= 45:
        bits.append("It has been a shootout; every possession has mattered.")
    elif pts <= 20:
        bits.append("Points have been scarce all night; one score may decide it.")
    real_final = p.get("real_final_score_diff")
    if real_final is not None:
        if real_final > 0:
            bits.append(f"In reality, {post} completed the comeback and won.")
        elif real_final == 0:
            bits.append("In reality, the drive ended level — a tie.")
        else:
            bits.append(f"In reality, the drive fell short and {deff} held on.")
    story = " ".join(bits)
    for key, extra in OVERRIDES.items():
        if p["slug"].startswith(key):
            story += " " + extra
    return story


def main():
    games = fetch_games()
    puzzles = json.loads((SITE_DATA / "puzzles.json").read_text(encoding="utf-8"))
    rec_cache = {}
    stories = {}
    for p in puzzles:
        g = p["game"]
        k = (g["season"], g["week"])
        if k not in rec_cache:
            rec_cache[k] = records_before(games, g["season"], g["week"])
        txt = story_for(p, games, rec_cache[k])
        stories[p["slug"]] = txt
    (SITE_DATA / "stories.json").write_text(json.dumps(stories, indent=1), encoding="utf-8")
    print(f"{len(stories)} stories written\n")
    for slug in list(stories)[:3]:
        print(slug, "->", stories[slug][:220], "\n")


if __name__ == "__main__":
    main()
