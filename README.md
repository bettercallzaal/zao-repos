# zao-repos

Live dashboard over every **public** repository on the ZAO GitHub accounts.

**Page:** https://bettercallzaal.github.io/zao-repos

Rebuilt hourly by GitHub Actions. Five views:

| Tab | Answers |
|---|---|
| Overview | How much am I shipping, in what, where |
| Activity | Which repos are actually moving, which are archive candidates |
| Deploys | Are the advertised URLs alive, which are still on a default `*.vercel.app` |
| Hygiene | Missing description / topics / README / license / CI, worst first |
| Portfolio | Everything grouped by product line, for sharing |
| All repos | Full sortable, filterable table |

## Accounts covered

- `bettercallzaal`
- `ZAODEVZ`
- `ZAO-DEVZ`

Edit the `ACCOUNTS` array in `scripts/fetch.mjs` to add more.

## Privacy

The GraphQL query is pinned to `privacy:PUBLIC`, and the workflow runs with the
default `GITHUB_TOKEN`, which has no read access to private repositories on other
accounts. Private repos are therefore never fetched and can never appear on the
published page, even by accident.

If you ever want private repos on a dashboard, that page must not be public -
build it as a separate private surface, not here.

## Metrics collected per repo

Stars, forks, watchers, open issues, open PRs, disk size, created / pushed /
updated timestamps, default branch, last commit message, commit counts for
30d / 90d / 1y / all-time, contributor count, full language breakdown with
percentages, topics, license, latest release and release count, presence of
README / LICENSE / .gitignore / .env.example / CLAUDE.md, CI workflow filenames,
last workflow run conclusion, `package.json` dependency counts and detected
framework, an HTTP liveness probe of the homepage URL, and a derived product-line
label and hygiene score.

Account level: the trailing-12-month contribution calendar (public contributions
only), plus a per-month rollup of repos pushed and created.

## Local run

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/fetch.mjs
cd docs && python -m http.server 8080
```

Then open http://localhost:8080

## Product lines

`scripts/fetch.mjs` maps repo names to product lines (WaveWarZ, ZAO OS, ZAO Stock,
COC Concertz, FISHBOWLZ, ZABAL, ZOL, Fractal, Cowork, SongJam / Music,
BetterCallZaal, Agents & Bots, Dev Infra, ZAO Core, Other) via the `BRANDS` table.
First match wins, so order matters. Add patterns there as new lines appear.
