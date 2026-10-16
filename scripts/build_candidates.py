"""Download nflverse play-by-play data and surface two-minute-drill candidate drives."""
import io
import sys
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

SEASONS = [2023, 2024, 2025, 2026]
URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{s}.parquet"


def fetch(season: int) -> pd.DataFrame:
    f = DATA / f"pbp_{season}.parquet"
    if f.exists():
        return pd.read_parquet(f)
    print(f"downloading {season}...", flush=True)
    import time
    for attempt in range(3):
        try:
            r = requests.get(URL.format(s=season), timeout=300)
            r.raise_for_status()
            f.write_bytes(r.content)
            return pd.read_parquet(f)
        except Exception as e:
            print(f"  attempt {attempt + 1} failed: {e}", flush=True)
            time.sleep(3)
    raise RuntimeError(f"could not download {season}")


def main():
    frames = []
    for s in SEASONS:
        try:
            frames.append(fetch(s))
        except Exception as e:
            print(f"skip {s}: {e}", file=sys.stderr)
    pbp = pd.concat(frames, ignore_index=True)
    print(f"loaded {len(pbp):,} plays, {pbp['game_id'].nunique()} games")

    # Offense trailing or tied by <=8, inside final 2 minutes of a half.
    cond = (
        (pbp["game_seconds_remaining"] <= 120)
        & (pbp["game_seconds_remaining"] > 0)
        & (pbp["score_differential"].between(-8, 0))
        & pbp["posteam"].notna()
        & pbp["wp"].notna()
    )
    cand = pbp[cond]

    # Group into drives, keep drives with real stakes: >=3 plays and wp swings.
    rows = []
    for (gid, drive), g in cand.groupby(["game_id", "drive"], sort=False):
        g = g.sort_values("play_id")
        first = g.iloc[0]
        end_wp = max(float(g.iloc[-1]["wp"]), 0.02)
        swing = float(first["wp"]) - end_wp
        if len(g) < 3 or swing < 0.08:
            continue
        rows.append({
            "game_id": gid,
            "drive": int(first["drive"]),
            "season": first["season"],
            "week": first["week"],
            "game_date": first.get("gameday", first.get("game_date", "")),
            "home": first["home_team"],
            "away": first["away_team"],
            "posteam": first["posteam"],
            "defteam": first["defteam"],
            "start_seconds": int(first["game_seconds_remaining"]),
            "start_score_diff": int(first["score_differential"]),
            "start_yardline": first["yardline_100"],
            "start_down": first["down"],
            "start_distance": int(first["ydstogo"]),
            "plays": len(g),
            "wp_start": round(float(first["wp"]), 3),
            "wp_end": round(float(g.iloc[-1]["wp"]), 3),
            "swing": round(swing, 3),
        })

    out = pd.DataFrame(rows).sort_values("swing", ascending=False)
    out.to_csv(DATA / "candidates.csv", index=False)
    print(f"{len(out)} candidate drives -> data/candidates.csv")
    print(out.head(15)[["game_id", "posteam", "start_seconds", "start_score_diff", "swing"]].to_string(index=False))


if __name__ == "__main__":
    main()
