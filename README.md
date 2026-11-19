[![GTA VI trophy rarity forecast 01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/khaliefk/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard)
[![Reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/khaliefk/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

# GTA VI trophy rarity forecast

A program that forecasts every Grand Theft Auto VI trophy's earn rate on Exophase one week after launch. It reads a case file, the house's recording of the trophy page up to the checkpoint, and writes five quantiles per trophy for the target. The score is pinball loss on the logit scale. This entry was built for the make.fun bounty [Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## How it works

A trophy's earn rate is earners over players tracked. The rate moves for two separate reasons. Players earn the trophy, and new players arrive who mostly have not earned it yet. Launch night shows the second reason plainly. Exophase held 638 players tracked with every rate flat for hours, then refreshed to 3,868 players and every rate but the one at 100 percent fell. A forecast that only extends the rate curve misses that drop.

So this program forecasts earners and players tracked separately, then divides.

Players tracked come from the refreshes in the history. With at least two refreshes, log players is fitted against log(1 + hours since release) and read at the target. With fewer, a prior takes over: the first refresh on launch night multiplied the tracked base about sixfold, and the chance one lands inside the horizon grows with the horizon. The two outcomes stay separate, so the median does not pretend a jump that probably has not happened yet.

Earners come from two per-trophy numbers. The new-player share is read off past refreshes, minus what the old players earned over the same interval. The hazard is the hourly rate at which players without the trophy earn it, read off intervals where the tracked count did not move. The forecast steps forward in half-hour steps. Earners grow by the hazard, plus the new-player share on each rise in players tracked. Earners never fall.

A trend read joins in only on a long history. A least squares line of logit rate on log(1 + hours since release) over the last 24 hours of reads, read at the target. Its weight is zero under 12 hours of history and grows to half at 60 hours. The final quantiles come from the mixture of the count model's scenarios and this trend.

METHODOLOGY.md has the full model, every constant, and the validation numbers.

## Run it

Node 22, standard library only, no network.

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads every `<id>.in` in the input directory and writes `<id>.out` beside it in the output directory. Two runs on the same case write the same bytes. A case runs in well under a second.

## Check it

```sh
node tools/check.mjs
```

It runs the program on the kit practice cases, checks the output format, checks two runs write the same bytes, and scores the model against the persistence baseline and a log-time curve baseline on synthetic worlds with known answers. On this build it passes everything: mean pinball loss 0.5051 against 0.5635 for persistence and 1.4247 for the curve baseline across twelve synthetic worlds.

## Files

- `main.ts` is the entrypoint. It runs alone under the grader.
- `data/trophies.json` is the game's trophy table, 55 trophies. `data/gen_trophies.mjs` rebuilds it from the table typed in this session. Run it from the repo root to verify the file still matches byte for byte.
- `tools/check.mjs` is the local validation script. It is a dev tool, not part of the graded program.
- `METHODOLOGY.md` documents the model and the validation.

## License

MIT. See LICENSE.
