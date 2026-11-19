// Trophy rarity forecaster for gta6-trophy-rarity-forecast-01.
//
// It reads one case per file from /input (or MAKEFUN_INPUT_DIR) and writes
// one forecast per case to /output (or MAKEFUN_OUTPUT_DIR). Each forecast
// gives five quantiles of every trophy's earn rate at the case target, in
// percent. Standard library only, no network, deterministic: the same case
// always writes the same bytes.
//
// The model works in counts, not rates. A rate is earners over players
// tracked, so it moves for two separate reasons: players earn the trophy,
// and new players arrive who mostly have not earned it yet. The house
// recorder's launch night shows the second reason plainly. Exophase kept
// 638 players tracked and every rate flat for hours, then refreshed to
// 3,868 players and every rate but the one at 100 percent fell. A forecast
// that only extends the rate curve misses that drop. This program forecasts
// earners and players tracked separately, then divides.
//
// Players tracked. Reads where the count jumps mark a refresh. With at
// least two refreshes in the history, log players is fitted against
// log(1 + hours since release) by least squares and read at the target.
// That curve bends down as the launch spike fades, which a straight line
// in time does not. With fewer than two refreshes the history says
// nothing about the next jump, so a prior takes over: the first refresh on
// launch night multiplied the tracked base about sixfold, and the chance
// a refresh lands inside the horizon grows with the horizon. The two
// outcomes stay separate in the forecast, so the median does not pretend
// a jump that probably has not happened yet.
//
// Earners. Two per-trophy numbers come from the history. The first is
// the share of newly tracked players who already hold the trophy, read
// off past refreshes as the rise in earners over the rise in players
// tracked, minus what the old players earned over the same interval, so
// fast earning does not masquerade as new players holding it. Where no
// refresh has been seen yet, the prior is a quarter of the trophy's
// current rate, except a trophy everyone holds, which new players hold
// too. The second is the hourly hazard: the rate at which players
// without the trophy earn it, read off intervals where the tracked
// count did not move, shrunk toward the median hazard across trophies.
// The hazard fades on its own timescale: a trophy whose holders earn
// fast saturates fast, so the players left without it are the slow ones
// within about 1 / hazard hours.
//
// The last piece is a trend read, mixed in only when the history is
// long enough to support one. A least squares line of logit rate on
// log(1 + hours since release) over the last 24 hours of reads, read at
// the target, with a spread from the fit's residual and the random
// walk's. On a short history that line is wild, so its weight is zero
// under 12 hours of history and grows to half at 60 hours. The final
// quantiles come from the mixture of the count model's scenarios and
// this trend: the count model carries the dilution a rate curve cannot
// see, the trend carries the slow rise the count model's hazard
// overshoots on a long horizon.
//
// The forecast steps forward from the last read to the target in
// half-hour steps. Players tracked glide in log space toward the
// scenario value. Earners grow by the hazard applied to players without
// the trophy, plus the new-player share applied to each rise in players
// tracked. Earners never fall. Each combination of a player-count
// scenario and a hazard scale gives one rate per trophy, and the five
// quantiles are the weighted quantiles of those rates. The weights are
// fixed: 0.25, 0.5, 0.25 on each axis where the count scenarios are
// threefold, and the refresh probability where they are twofold.
//
// Nothing here is tuned to the practice answers. The constants are
// priors stated in the open: the sixfold first refresh, the four hour
// refresh interval, the quarter-rate new-player share. METHODOLOGY.md
// lists them all with the reasons.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The quantile levels the contest scores, in the order each row lists them.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Scenario weights on each axis: low, middle, high.
const AXIS_WEIGHTS = [0.25, 0.5, 0.25];
// Hazard scales across the nine scenarios.
const HAZARD_SCALES = [0.5, 1, 2];
// Release day began at 2026-11-19T00:00:00Z; times are hours after it.
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
// Half-hour forward steps, in hours.
const STEP_HOURS = 0.5;

interface Trophy {
  id: number;
}

interface Read {
  at: string;
  slot: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Hours from release to an ISO timestamp. */
const hoursSinceRelease = (iso: string): number =>
  (Date.parse(iso) - RELEASE_MS) / 3_600_000;

/** Least squares line through points (x, y); returns [intercept, slope]. */
const fitLine = (xs: number[], ys: number[]): [number, number] => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return [my, 0];
  const slope = sxy / sxx;
  return [my - slope * mx, slope];
};

/** Weighted quantile of [value, weight] pairs at level tau. */
const weightedQuantile = (pairs: Array<[number, number]>, tau: number): number => {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  let seen = 0;
  for (const [value, weight] of sorted) {
    seen += weight;
    if (seen >= tau) return value;
  }
  return sorted[sorted.length - 1][0];
};

/**
 * Three player-count scenarios at the target, each with its weight.
 * Returns [count, weight] triples, low to high.
 */
const playerScenarios = (
  reads: Read[],
  tLast: number,
  tTarget: number,
): Array<[number, number]> => {
  const nLast = reads[reads.length - 1].players_tracked;
  const jumps: number[] = [];
  for (let k = 1; k < reads.length; k++) {
    if (reads[k].players_tracked > reads[k - 1].players_tracked) {
      jumps.push(reads[k].players_tracked / reads[k - 1].players_tracked);
    }
  }
  if (jumps.length >= 2) {
    const xs = reads.map((r) => Math.log1p(hoursSinceRelease(r.at)));
    const ys = reads.map((r) => Math.log(Math.max(1, r.players_tracked)));
    const [a, b] = fitLine(xs, ys);
    let mid = Math.exp(a + b * Math.log1p(tTarget));
    mid = clamp(mid, nLast, nLast * 50);
    let ss = 0;
    for (let i = 0; i < xs.length; i++) {
      const d = ys[i] - (a + b * xs[i]);
      ss += d * d;
    }
    const sd = clamp(Math.sqrt(ss / xs.length), 0.1, 0.8);
    return [
      [mid * Math.exp(-sd), AXIS_WEIGHTS[0]],
      [mid, AXIS_WEIGHTS[1]],
      [mid * Math.exp(sd), AXIS_WEIGHTS[2]],
    ];
  }
  // No refresh pattern to learn from yet. The prior says the first
  // refresh multiplies the tracked base about sixfold, and the chance one
  // lands before the target grows with the horizon. The two outcomes stay
  // separate: most of the weight sits on no refresh, so the median
  // forecast does not pretend a jump that probably has not happened yet,
  // while the low quantiles carry the jump.
  const horizonHours = Math.max(0, tTarget - tLast);
  const pRefresh = 1 - Math.exp(-horizonHours / 4);
  return [
    [nLast, 1 - pRefresh],
    [nLast * 6, pRefresh],
  ];
};

/**
 * Per trophy, the share of newly tracked players who already hold it.
 * Read off past refreshes: the rise in earners over the rise in players
 * tracked, minus what the old players earned over the same interval at
 * the trophy's hazard, so fast earning does not masquerade as new
 * players holding the trophy. Falls back to a prior where no refresh
 * was seen.
 */
const newPlayerShares = (
  reads: Read[],
  lastRates: Array<number | null>,
  hz: number[],
): number[] => {
  const nTrophies = lastRates.length;
  const shares: number[] = [];
  const refreshShares: number[][] = Array.from({ length: nTrophies }, () => []);
  for (let k = 1; k < reads.length; k++) {
    const dN = reads[k].players_tracked - reads[k - 1].players_tracked;
    if (dN <= 0) continue;
    const dt = (Date.parse(reads[k].at) - Date.parse(reads[k - 1].at)) / 3_600_000;
    for (let i = 0; i < nTrophies; i++) {
      const rNew = reads[k].rates[i];
      const rOld = reads[k - 1].rates[i];
      if (rNew === null || rOld === null) continue;
      const nOld = reads[k - 1].players_tracked;
      const eOld = (rOld * nOld) / 100;
      const dE = (rNew * reads[k].players_tracked - rOld * nOld) / 100;
      const oldEarning = hz[i] * Math.max(0, nOld - eOld) * Math.max(0, dt);
      refreshShares[i].push(clamp((dE - oldEarning) / dN, 0, 1));
    }
  }
  for (let i = 0; i < nTrophies; i++) {
    const r = lastRates[i] ?? 0;
    const frac = r / 100;
    const prior = frac >= 0.99 ? 1 : frac >= 0.5 ? frac : 0.25 * frac;
    const seen = refreshShares[i].slice().sort((a, b) => a - b);
    if (seen.length === 0) {
      shares.push(prior);
    } else if (seen.length >= 3) {
      shares.push(seen[Math.floor(seen.length / 2)]);
    } else {
      shares.push((seen.reduce((a, b) => a + b, 0) / seen.length + prior) / 2);
    }
  }
  return shares;
};

/**
 * Per trophy, the hourly hazard at which players without the trophy earn
 * it, read off intervals where the tracked count did not move, shrunk
 * toward the median hazard across trophies.
 */
const hazards = (reads: Read[]): number[] => {
  const nTrophies = reads[0].rates.length;
  const gain: number[] = new Array(nTrophies).fill(0);
  const exposure: number[] = new Array(nTrophies).fill(0);
  for (let k = 1; k < reads.length; k++) {
    if (reads[k].players_tracked !== reads[k - 1].players_tracked) continue;
    const dt = (Date.parse(reads[k].at) - Date.parse(reads[k - 1].at)) / 3_600_000;
    if (dt <= 0) continue;
    const n = reads[k].players_tracked;
    for (let i = 0; i < nTrophies; i++) {
      const rNew = reads[k].rates[i];
      const rOld = reads[k - 1].rates[i];
      if (rNew === null || rOld === null) continue;
      const dE = Math.max(0, ((rNew - rOld) * n) / 100);
      const eAvg = (((rNew + rOld) / 2) * n) / 100;
      gain[i] += dE;
      exposure[i] += Math.max(0, n - eAvg) * dt;
    }
  }
  const raw: number[] = gain.map((g, i) => (exposure[i] > 0 ? g / exposure[i] : 0));
  const positives = raw.filter((h) => h > 0).sort((a, b) => a - b);
  const global = positives.length > 0 ? positives[Math.floor(positives.length / 2)] : 0;
  return raw.map((h, i) => clamp((gain[i] + global * 500) / (exposure[i] + 500), 0, 0.05));
};

/** Standard normal CDF, Abramowitz and Stegun 7.1.26. */
const normalCdf = (x: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? cdf : 1 - cdf;
};

/** Logit of a percent rate, clamped the way the scorer clamps. */
const logitPct = (pct: number): number => {
  const c = clamp(pct, 0.01, 99.99);
  return Math.log(c / (100 - c));
};

/** Inverse logit, back to a percent rate. */
const invLogitPct = (x: number): number => 100 / (1 + Math.exp(-x));

/**
 * Per trophy, the trend read: a least squares line of logit rate on
 * log(1 + hours since release) over the last 24 hours of reads, read at
 * the target. Returns [mid logit, spread logit] or null where too few
 * reads carry the trophy.
 */
const trendRead = (
  reads: Read[],
  tLast: number,
  tTarget: number,
  horizonMinutes: number,
): Array<[number, number] | null> => {
  const nTrophies = reads[0].rates.length;
  const out: Array<[number, number] | null> = [];
  const xTarget = Math.log1p(tTarget);
  for (let i = 0; i < nTrophies; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const read of reads) {
      const t = hoursSinceRelease(read.at);
      if (t < tLast - 24) continue;
      const r = read.rates[i];
      if (r === null || r === undefined) continue;
      xs.push(Math.log1p(Math.max(0, t)));
      ys.push(logitPct(r));
    }
    if (xs.length < 3) {
      out.push(null);
      continue;
    }
    const [a, b] = fitLine(xs, ys);
    const mid = clamp(a + b * xTarget, -8, 8);
    let ss = 0;
    for (let k = 0; k < xs.length; k++) {
      const d = ys[k] - (a + b * xs[k]);
      ss += d * d;
    }
    const resid = clamp(Math.sqrt(ss / Math.max(1, xs.length - 2)), 0.15, 1.5);
    const walk = 0.5 * Math.sqrt(horizonMinutes / 1440);
    out.push([mid, Math.sqrt(resid * resid + walk * walk)]);
  }
  return out;
};

/**
 * Quantiles of a mixture: the count model's scenario rates (each with
 * its weight) mixed with a normal trend in logit space (weight w).
 */
const mixtureQuantiles = (
  outcomes: Array<[number, number]>,
  trend: [number, number] | null,
  w: number,
): number[] => {
  if (trend === null || w <= 0) {
    const qs = LEVELS.map((tau) => round4(weightedQuantile(outcomes, tau)));
    for (let j = 1; j < qs.length; j++) {
      if (qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
    }
    return qs;
  }
  const [m, s] = trend;
  const logits = outcomes.map(([rate, weight]) => [logitPct(rate), weight] as [number, number]);
  const qs: number[] = [];
  for (const tau of LEVELS) {
    let found = 9.19;
    for (let x = -9.19; x <= 9.191; x += 0.02) {
      let f = 0;
      for (const [l, weight] of logits) {
        if (l <= x) f += (1 - w) * weight;
      }
      f += w * normalCdf((x - m) / s);
      if (f >= tau) {
        found = x;
        break;
      }
    }
    qs.push(round4(clamp(invLogitPct(found), 0, 100)));
  }
  for (let j = 1; j < qs.length; j++) {
    if (qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
  }
  return qs;
};

/** Forecast one case. Returns the rows for the output file. */
const forecastCase = (c: Case): Array<{ id: number; q: number[] }> => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case ${c.id} asks for levels ${JSON.stringify(c.levels)}`);
  }
  const nTrophies = c.trophies.length;
  const lastRates: Array<number | null> = new Array(nTrophies).fill(null);
  if (c.history.length === 0) {
    return c.trophies.map((t) => ({ id: t.id, q: [0.01, 0.01, 0.01, 0.01, 0.01] }));
  }
  const reads = c.history.slice().sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  // Carry the last known rate forward over nulls.
  for (const read of reads) {
    for (let i = 0; i < nTrophies; i++) {
      if (read.rates[i] !== null && read.rates[i] !== undefined) lastRates[i] = read.rates[i];
    }
  }
  for (let i = 0; i < nTrophies; i++) {
    if (lastRates[i] === null) lastRates[i] = 0.01;
  }
  const last = reads[reads.length - 1];
  const nLast = last.players_tracked;
  const tLast = hoursSinceRelease(last.at);
  const tTarget = hoursSinceRelease(c.target);
  const horizonHours = Math.max(0, tTarget - tLast);
  if (horizonHours === 0) {
    return c.trophies.map((t, i) => {
      const r = round4(clamp(lastRates[i] as number, 0, 100));
      return { id: t.id, q: [r, r, r, r, r] };
    });
  }
  const nScen = playerScenarios(reads, tLast, tTarget);
  const hz = hazards(reads);
  const shares = newPlayerShares(reads, lastRates, hz);
  // The trend read earns weight only on a long history: zero under 12
  // hours of reads, half at 60 hours.
  const spanHours = tLast - hoursSinceRelease(reads[0].at);
  const trendW = clamp((spanHours - 12) / 48, 0, 0.5);
  const trends = trendW > 0 ? trendRead(reads, tLast, tTarget, c.horizon_minutes) : null;
  const eLast = lastRates.map((r) => ((r as number) / 100) * nLast);
  const steps = Math.min(300, Math.max(1, Math.ceil(horizonHours / STEP_HOURS)));
  const dt = horizonHours / steps;

  return c.trophies.map((t, i) => {
    const outcomes: Array<[number, number]> = [];
    for (const [nTarget, wN] of nScen) {
      const logStart = Math.log(Math.max(1, nLast));
      const logEnd = Math.log(Math.max(1, nTarget));
      for (let s = 0; s < HAZARD_SCALES.length; s++) {
        const h0 = hz[i] * HAZARD_SCALES[s];
        let nNow = nLast;
        let eNow = eLast[i];
        for (let step = 1; step <= steps; step++) {
          const frac = step / steps;
          const nNext = Math.exp(logStart + (logEnd - logStart) * frac);
          const tNow = tLast + (step - 1) * dt;
          // The hazard fades on its own timescale: a trophy whose
          // holders earn fast saturates fast, so the players left
          // without it are the slow ones within about 1 / h0 hours.
          const hNow = h0 / (1 + h0 * Math.max(0, tNow - tLast));
          eNow += hNow * Math.max(0, nNow - eNow) * dt;
          eNow += shares[i] * Math.max(0, nNext - nNow);
          eNow = clamp(eNow, eNow, nNext);
          nNow = nNext;
        }
        const rate = clamp((eNow / Math.max(1, nNow)) * 100, 0, 100);
        outcomes.push([rate, wN * AXIS_WEIGHTS[s]]);
      }
    }
    const q = mixtureQuantiles(outcomes, trends === null ? null : trends[i], trendW);
    return { id: t.id, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
