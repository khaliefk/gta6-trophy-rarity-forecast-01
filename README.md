[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/khaliefk/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/khaliefk/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI trophy rarity forecast

Forecast, for every Grand Theft Auto VI trophy on PlayStation 5, its earn
rate on Exophase at 2026-11-26T00:00:00Z, a week after launch, as five
quantiles a trophy. Built for the make.fun bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## The program

`main.ts` is the entry. Node 22, standard library only, no network, no
randomness. It reads every case file in the input directory and writes one
forecast per case.

```
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Outside the grader, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`. A run takes about 0.25 seconds a case.

## How it forecasts

Two trends per trophy, blended 0.6 / 0.4:

1. A trend for `logit(rate / ceiling)` against log hours since release,
   fitted over the last 24 hours of reads. The ceiling is the share of
   tracked players who will ever earn that trophy (chapter 1: 75%, the
   platinum: 2%), so a steep launch-week rise bends toward a reachable
   level instead of running to 99%.
2. A split trend: log earners and log players tracked forecast separately,
   then divided, which handles dilution when new buyers flood in faster
   than anyone earns trophies.

The story funnel is enforced (chapter 1 >= chapter 2 >= chapter 3 >=
chapter 4 >= final mission >= 100% completion >= platinum), and the spread
is a random walk in the horizon plus the fit's residual, plus a wide term
when the page has gone stale with no refresh. See [METHODOLOGY.md](METHODOLOGY.md)
for the full write-up, the validation, and the numbers behind the ceilings.

## Files

- `main.ts` — the forecaster, the only file the grader runs.
- `METHODOLOGY.md` — method, validation, and how to reproduce it.
- `data/trophies.json` — the 55 trophies with the launch-night rates and
  the Exophase page rates at 2026-11-19T13:59:00Z, with sources. Research
  record only; the program forecasts from the case file alone.

## License

MIT. See [LICENSE](LICENSE).
