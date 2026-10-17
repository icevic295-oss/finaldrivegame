"""Generate static /puzzle/{slug}/ landing pages + sitemap for every puzzle."""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"

CAT_LABEL = {"pass": "Pass", "run": "Run", "spike": "Spike", "kneel": "Kneel",
             "field_goal": "Field goal", "punt": "Punt"}
RESULT_LABEL = {"Touchdown": "Touchdown", "Field goal": "Field goal", "Turnover": "Turnover",
                "Turnover on downs": "Turnover on downs", "Punt": "Punt",
                "Missed field goal": "Missed FG", "End of game": "End of game"}

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Final Drive">
<meta property="og:image" content="/assets/og.png">
<link rel="canonical" href="/puzzle/{slug}/">
<script type="application/ld+json">{jsonld}</script>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="site">
  <a class="logo" href="/">Final<b>Drive</b></a>
  <nav>
    <a href="/">Today's drive</a>
    <a href="/how-to-play.html">How to play</a>
    <a href="/what-is-a-two-minute-drill.html">The tactics</a>
  </nav>
</header>
<article class="prose">"""

TAIL = """</article>
<footer class="site">
  <p>Built on public nflverse play-by-play data. Not affiliated with the NFL.</p>
</footer>
</body>
</html>"""


def esc(t):
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_clock(s):
    return f"{s // 60}:{s % 60:02d}"


def main():
    puzzles = json.loads((SITE / "data" / "puzzles.json").read_text(encoding="utf-8"))
    stories = json.loads((SITE / "data" / "stories.json").read_text(encoding="utf-8"))

    out_dir = SITE / "puzzle"
    urls = []
    for p in puzzles:
        slug = p["slug"]
        g, s = p["game"], p["start"]
        q = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "OT"}.get(s["qtr"], "")
        title = f"{g['away']} @ {g['home']} ({g['season']} Week {g['week']}) — the final drive, playable"
        desc = (f"Replay and play the real final drive of {g['away']} @ {g['home']} "
                f"({g['season']} week {g['week']}): {g['posteam']} trail by {abs(s['score_diff'])} "
                f"with {fmt_clock(s['seconds'])} left. Call every snap and beat the real coach.")
        jsonld = json.dumps({
            "@context": "https://schema.org", "@type": "SportsEvent",
            "name": f"{g['away']} @ {g['home']} — {g['season']} week {g['week']} final drive",
            "description": desc,
            "sport": "American Football",
            "competitor": [{"@type": "SportsTeam", "name": g["away"]}, {"@type": "SportsTeam", "name": g["home"]}],
            "startDate": g.get("date") or f"{g['season']}",
            "url": f"/puzzle/{slug}/",
        })
        story = stories.get(slug, "")
        parts = [HEAD.format(title=esc(title), desc=esc(desc), slug=slug, jsonld=jsonld)]
        parts.append(f"""
<h1>{g['away']} @ {g['home']}: the final drive</h1>
<p class="lede">{g['season']} season, week {g['week']}{(' — ' + g['date']) if g.get('date') else ''}.
{g['posteam']} have the ball, trailing by {abs(s['score_diff'])}, with {fmt_clock(s['seconds'])} left in the {q} quarter.
You call every snap.</p>

<h2>The situation</h2>
<table>
<tr><th>Score</th><td>{g['defteam']} {s['defteam_score']} — {g['posteam']} {s['posteam_score']}</td></tr>
<tr><th>Clock</th><td>{fmt_clock(s['seconds'])} ({q} quarter)</td></tr>
<tr><th>Down</th><td>{s['down']} &amp; {s['distance']}</td></tr>
<tr><th>Ball on</th><td>own {100 - s['yardline']}</td></tr>
<tr><th>Timeouts</th><td>{s.get('timeouts', 3)}</td></tr>
</table>""")
        if story:
            parts.append(f"<h2>The story</h2><p>{esc(story)}</p>")
        parts.append(f"""
<p><a class="btn primary" href="/?slug={slug}">▶ Play this drive</a>
&nbsp; <a class="btn" href="/?mode=unlimited">Or a random one</a></p>

<h2>The real drive, snap by snap</h2>
<table>
<tr><th>Clock</th><th>Call</th><th>Play</th></tr>""")
        for pl in p["plays"]:
            parts.append(f"<tr><td>{fmt_clock(pl['seconds'])}</td><td>{CAT_LABEL.get(pl['cat'], pl['cat'])}</td>"
                         f"<td>{esc(pl['desc'])}</td></tr>")
        result = RESULT_LABEL.get(p["result"], p["result"])
        parts.append(f"""
</table>
<p><b>Real result: {result}</b>{' — ' + g['posteam'] + ' completed the comeback.' if p.get('real_final_score_diff', -1) >= 0 else ''}</p>

<h2>What is a two-minute drill?</h2>
<p>The hurry-up offense a team runs when it needs points before the clock dies. Learn the
<a href="/what-is-a-two-minute-drill.html">rules and tactics of the two-minute drill</a>, or jump straight into
<a href="/">today's drive</a>.</p>""")
        parts.append(TAIL)
        d = out_dir / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text("".join(parts), encoding="utf-8")
        urls.append(f"/puzzle/{slug}/")

    # sitemap
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = ["", "/how-to-play.html", "/what-is-a-two-minute-drill.html"] + urls
    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in items:
        sm.append(f"<url><loc>https://finaldrivegame.com{u}</loc><lastmod>{now}</lastmod></url>")
    sm.append("</urlset>")
    (SITE / "sitemap.xml").write_text("\n".join(sm), encoding="utf-8")
    print(f"{len(urls)} puzzle pages + sitemap.xml ({len(items)} urls)")


if __name__ == "__main__":
    main()
