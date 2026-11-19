# Methodology

## The problem

Grand Theft Auto VI came out on 19 November 2026 on PlayStation 5. Exophase tracks every player who syncs a profile and prints each trophy's rarity: the percent of the players it tracks who have earned it. The bounty asks for a program that reads the house's recording of that page up to the deadline and forecasts each trophy's rate at 2026-11-26T00:00:00Z, a week after launch, as five quantiles per trophy. The score is pinball loss on the logit scale, so a forecast whose five quantiles are equal scores exactly its mean miss in logit terms. A prize needs a loss strictly below the best house entry.

## The model

The model works in counts. A rate is earners over players tracked, and the two move for different reasons. The forecast predicts each side on its own, then divides.

### Players tracked

Reads where the count jumps mark a refresh. Exophase refreshes a game's counts on its own schedule, hours apart, not continuously. Between refreshes the count sits flat.

With at least two refreshes in the history, log players is fitted by least squares against log(1 + hours since release) and read at the target. The log curve bends down as the launch spike fades. Three scenarios carry the uncertainty: the fitted value, and the fitted value times exp(+sd) and exp(-sd), where sd is the residual standard deviation of the fit, floored at 0.10 and capped at 0.80. The weights are 0.25, 0.5, 0.25.

With fewer than two refreshes the history says nothing about the next jump, so a prior takes over. The first refresh on launch night multiplied the tracked base about sixfold, from 638 to 3,868 players. The chance a refresh lands inside the horizon is 1 - exp(-h / 4), with h the horizon in hours and 4 hours the prior refresh interval. The two outcomes stay separate: no refresh with weight 1 - p, a sixfold jump with weight p. The median forecast then does not pretend a jump that probably has not happened yet, while the low quantiles carry the drop.

### Earners

Two per-trophy numbers come from the history.

The new-player share is the share of newly tracked players who already hold the trophy. At each past refresh it is the rise in earners over the rise in players tracked, minus what the old players earned over the same interval at the trophy's hazard. That subtraction matters: without it, fast earning by old players masquerades as new players holding the trophy. With three or more refreshes the median is used. With one or two, the average of the data and the prior is used. With none, the prior is a quarter of the trophy's current rate, except a trophy everyone holds, which new players hold too, and a trophy over half the players hold, where the prior is the rate itself.

The hazard is the hourly rate at which players without the trophy earn it. It is read off intervals where the tracked count did not move: total earner growth over total player-hours without the trophy. It is shrunk toward the median hazard across trophies with a 500 player-hour pseudo-count, and capped at 0.05 per hour. The hazard fades on its own timescale in the forward run: h(t) = h0 / (1 + h0 * elapsed). A trophy whose holders earn fast saturates fast.

The forecast steps forward from the last read to the target in half-hour steps. Players tracked glide in log space toward the scenario value. Earners grow by the hazard applied to players without the trophy, plus the new-player share applied to each rise in players tracked. Earners never fall. The hazard scales 0.5, 1 and 2 cross the player scenarios with weights 0.25, 0.5, 0.25, so each trophy gets six or nine scenario rates.

### The trend read

A least squares line of logit rate on log(1 + hours since release) over the last 24 hours of reads, read at the target, with a spread from the fit's residual and the random walk's. Its weight is zero under 12 hours of history and grows to half at 60 hours. On a short history that line is wild, so it stays out. On a long history it carries the slow rise the count model's hazard overshoots. The final quantiles come from the mixture of the count model's scenarios and this trend, inverted numerically on a logit grid.

## Constants

Every number that is not fitted is a prior stated here.

- Sixfold first refresh, from the launch night recording in the bounty text: 638 to 3,868 players.
- Four hour refresh interval, the prior for the chance a refresh lands inside the horizon.
- Quarter-rate new-player share, the prior where no refresh has been seen.
- 500 player-hour pseudo-count for hazard shrinkage.
- 0.05 per hour hazard cap.
- Half-hour forward steps, capped at 300 steps.
- Trend weight zero under 12 hours of history, half at 60 hours.

Nothing here is tuned to the practice answers. The practice cases carry no answer in the kit, and no constant was fitted to them.

## Validation

`tools/check.mjs` runs the checks. The practice cases p00 and p01 run in 320 ms for the pair, write valid output, and run byte-identical twice. On p00 the median sits at the last rate for all 55 trophies, the low quantiles carry the refresh drop (54 of 55 q05 values sit below the last rate), and the trophy at 100 percent stays at 100.

The synthetic check builds twelve worlds with known answers. Each world simulates cohorts arriving at refreshes and earning toward per-trophy ceilings at per-trophy hazards. Four shapes: a launch shock (flat history, then a sixfold refresh inside the horizon), steady fading growth, flat tracked count, and a saturating count. Mean pinball loss on the logit scale:

- This model: 0.5051
- Persistence baseline: 0.5635
- Log-time curve baseline: 1.4247

The model beats persistence on the shock and flat worlds and beats both baselines on the steady and saturating worlds, where the trend mixture does the work. The curve baseline wins nowhere on average: it explodes on short histories, where the log-time line extrapolates a steep early rise.

## Limits

The model trusts the history's shape. A refresh pattern that changes after the checkpoint, a trophy whose earning suddenly speeds up, or a tracked count that stops growing will all move the truth away from the forecast. The quantiles carry that: the spread widens with the horizon and with the refresh probability, so the honest answer on a short history is a wide low tail, not a confident point.
