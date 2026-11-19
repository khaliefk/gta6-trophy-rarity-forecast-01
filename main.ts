// gta6-trophy-rarity-forecast-01: forecast each GTA VI (PS5) trophy's earn rate on
// Exophase at the case's target, as five quantiles a trophy, scored by pinball loss
// on the logit scale.
//
// How it works, in short. A case hands the program the house's recording of
// Exophase's trophy page: every valid read before the checkpoint, each with the
// players tracked and every trophy's earn rate. The program fits, per trophy, a
// trend for logit(rate / ceiling) against log hours since release, where the
// ceiling is the share of tracked players who will ever earn that trophy, so a
// steep launch-week rise bends toward the ceiling instead of running away to
// 99%; plus a second trend that splits the rate into its two moving parts
// (earners, and players tracked) and divides the two forecasts. The two
// medians are blended (0.6 / 0.4) and capped at a 33-fold move in odds from
// the last read, and the story funnel is enforced (chapter 1 >= chapter 2
// >= ... >= final mission >= 100% completion >= platinum; the platinum cannot
// sit above any other trophy). The spread is a random walk in the horizon plus
// the fit's own residual, plus a wide term when the page has gone stale (no
// refresh seen), which is what the practice cases punish: a flat launch-night
// page says nothing about the next refresh, so the band has to be wide enough
// to hold it.
//
// Node 22, standard library only, no network, deterministic: the same case
// file always writes the same bytes. Reads every *.in file in the input
// directory (the grader runs one case at a time) and writes one <id>.out per
// case. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output
// outside the grader's container:
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** logit of a percent, clamped to the scorer's 0.01..99.99 first. */
const logit = (pct: number): number => {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
};
/** Inverse logit, as a percent. */
const logistic = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Standard normal quantile (Acklam's approximation, good to ~1e-9). */
const normalQuantile = (p: number): number => {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285984469534e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

interface Point {
  x: number;
  y: number;
  w: number;
}

interface TrendFit {
  /** Predicted logit at the target. */
  pred: number;
  /** Weighted residual standard deviation, in logit units. */
  resid: number;
  /** Effective sample size (sum of weights). */
  nEff: number;
  /** Prediction-interval widening from extrapolating past the data. */
  leverage: number;
}

/**
 * Weighted straight-line fit of y against x, with the slope shrunk toward a
 * prior. Returns null when the points carry no usable slope (too few, or no
 * spread in x). A quadratic term was tried here and dropped: its two
 * coefficients are near-collinear over a short log-time window, so the fit
 * can come back with a steep negative slope and a steep positive bend that
 * cancel inside the data and explode past it; the ceiling transform already
 * bends the forecast, which is the curvature that matters.
 */
function fitTrend(pts: Point[], slopePrior: number, xTarget: number): TrendFit | null {
  if (pts.length < 3) return null;
  const nEff = pts.reduce((s, p) => s + p.w, 0);
  const xMean = pts.reduce((s, p) => s + p.w * p.x, 0) / nEff;
  const yMean = pts.reduce((s, p) => s + p.w * p.y, 0) / nEff;
  const sxx = pts.reduce((s, p) => s + p.w * (p.x - xMean) ** 2, 0);
  if (sxx < 0.01) return null; // flat in x: no trend to fit
  const sxy = pts.reduce((s, p) => s + p.w * (p.x - xMean) * (p.y - yMean), 0);
  const bRaw = sxy / sxx;
  const b = (nEff * bRaw + 3 * slopePrior) / (nEff + 3);
  const a = yMean - b * xMean;
  const pred = a + b * xTarget;
  const resid2 = pts.reduce((s, p) => s + p.w * (p.y - (a + b * p.x)) ** 2, 0) / nEff;
  const resid = Math.sqrt(Math.max(resid2, 0.02 ** 2));
  const leverage = (xTarget - xMean) ** 2 / Math.max(sxx, 1e-9) + 1 / Math.max(nEff, 1e-9);
  return { pred, resid, nEff, leverage };
}

/** Weighted straight-line fit of y against x. Returns [intercept, slope]. */
function fitLine(pts: Point[]): [number, number] | null {
  if (pts.length < 2) return null;
  const sw = pts.reduce((s, p) => s + p.w, 0);
  const xm = pts.reduce((s, p) => s + p.w * p.x, 0) / sw;
  const ym = pts.reduce((s, p) => s + p.w * p.y, 0) / sw;
  const sxx = pts.reduce((s, p) => s + p.w * (p.x - xm) ** 2, 0);
  if (sxx < 1e-9) return null;
  const sxy = pts.reduce((s, p) => s + p.w * (p.x - xm) * (p.y - ym), 0);
  const b = sxy / sxx;
  return [ym - b * xm, b];
}

/**
 * A prior slope (logit per unit of log hours since release) from what the
 * trophy asks for. Story trophies climb fastest early; grind and collection
 * trophies climb late and slow; the platinum and 100% completion barely move
 * in week one. These are only shrinkage targets: with enough reads the data
 * wins.
 */
function slopePrior(t: Trophy): number {
  const d = t.description.toLowerCase();
  if (t.tier === 'platinum' || d.includes('100% completion')) return 0.3;
  if (/complete chapter \d/.test(d) || d === 'complete the final mission.' || d.startsWith('complete the final mission')) return 1.2;
  if (/complete /.test(d) && t.secret) return 1.0; // story / side missions
  if (/earn \$|spend \$|purchase all|laundering/.test(d)) return 0.6;
  if (/complete \d+|discover \d+|win \d+|at \d+ locations|meditate|explore all/.test(d)) return 0.5;
  return 0.7;
}

/**
 * The ceiling: the share of the tracked players who will ever earn this
 * trophy, in percent. The trend is fitted in the space logit(rate / ceiling),
 * so a steep launch-week rise bends toward the ceiling instead of running
 * away to 99%: a chapter every active player finishes still cannot pass the
 * players who never get that far, and the platinum cannot pass the few who
 * finish everything. The numbers are priors, not forecasts: Phantom Blade
 * Zero, a 30-40 hour game, had its fifth story step at 55.3% of Steam
 * players eleven days after launch and its platinum at 6.9%, while GTA V's
 * final mission sits at 16.8% of PS4 players over its lifetime; GTA VI is
 * longer and broader, so story ceilings sit below the Phantom Blade steps
 * and the platinum far below them. A trophy whose last read already sits
 * above its archetype ceiling (the opener, Gone Fishing, at 99.99%) takes a
 * ceiling just above that read instead.
 */
function ceiling(t: Trophy, lastRate: number): number {
  const d = t.description.toLowerCase();
  let c: number;
  if (/complete chapter 1\b/.test(d)) c = 75;
  else if (/complete chapter 2\b/.test(d)) c = 65;
  else if (/complete chapter 3\b/.test(d)) c = 55;
  else if (/complete chapter 4\b/.test(d)) c = 48;
  else if (d === 'complete the final mission.') c = 35;
  else if (d.includes('100% completion')) c = 3;
  else if (t.tier === 'platinum') c = 2;
  else if (/complete /.test(d) && t.secret) c = 35; // story / side missions
  else if (/earn \$|spend \$|purchase all|laundering/.test(d)) c = 28;
  else if (/complete \d+|discover \d+|win \d+|at \d+ locations|meditate|explore all/.test(d)) c = 20;
  else c = 30;
  return clamp(Math.max(c, lastRate * 1.02), 0.5, 100);
}

/** logit of a fraction in (0, 1). */
const logitFrac = (f: number): number => {
  const p = clamp(f, 0.0001, 0.9999);
  return Math.log(p / (1 - p));
};

interface Snapshot {
  atMs: number;
  players: number;
  rates: Array<number | null>;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  const releaseMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const atMs = Date.parse(c.at);
  const hoursSince = (ms: number): number => Math.max(0, (ms - releaseMs) / 3600000);
  const xOf = (ms: number): number => Math.log1p(hoursSince(ms));
  const xTarget = xOf(Date.parse(c.target));
  const horizonDays = c.horizon_minutes / 1440;

  // Deduplicate the recording: Exophase refreshes in jumps, so long runs of
  // identical reads carry one fact, not one per read.
  const snaps: Snapshot[] = [];
  for (const r of c.history) {
    const s: Snapshot = { atMs: Date.parse(r.at), players: r.players_tracked, rates: r.rates };
    const prev = snaps[snaps.length - 1];
    if (prev && prev.players === s.players && prev.rates.length === s.rates.length &&
      prev.rates.every((v, i) => v === s.rates[i])) continue;
    snaps.push(s);
  }
  const lastSnap = snaps[snaps.length - 1];

  // When the recent recording is rich, the launch-night snapshot (a small
  // early-access population with far higher rates) is a different regime and
  // is left out of the fit. The last day carries the current slope: launch
  // week moves fast, and a slope averaged over two days is already stale.
  const windowStart = atMs - 24 * 3600000;
  const recent = snaps.filter((s) => s.atMs >= windowStart);
  const fitSnaps = recent.length >= 8 ? recent : snaps;

  // Time of the last change in the page, for the staleness term.
  let lastChangeMs = snaps.length > 0 ? snaps[0].atMs : atMs;
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1];
    const b = snaps[i];
    if (a.players !== b.players || a.rates.some((v, j) => v !== b.rates[j])) lastChangeMs = b.atMs;
  }
  const hoursSinceChange = (atMs - lastChangeMs) / 3600000;
  const staleSpread = snaps.length <= 2 ? 1.2 : hoursSinceChange > 6 ? 0.5 : 0;

  // Players-tracked trend, for the earners-over-players split.
  const nPts: Point[] = fitSnaps
    .filter((s) => s.players > 0)
    .map((s) => ({ x: xOf(s.atMs), y: Math.log(s.players), w: 1 }));
  const nFit = fitLine(nPts);
  const logNPred = nFit ? nFit[0] + nFit[1] * xTarget : Math.log(Math.max(lastSnap?.players ?? 1, 1));

  const medians: number[] = [];
  const spreads: number[] = [];

  c.trophies.forEach((t, i) => {
    const lastRate = lastSnap?.rates[i] ?? null;
    const yLast = lastRate === null ? logit(0.5) : logit(lastRate);
    const prior = slopePrior(t);
    const ceil = ceiling(t, lastRate ?? 0.5);

    // Direct trend: logit(rate / ceiling) against log hours since release,
    // so the rise bends toward the ceiling instead of running to 99%.
    const pts: Point[] = fitSnaps
      .filter((s) => s.rates[i] !== null && s.rates[i] !== undefined)
      .map((s) => ({
        x: xOf(s.atMs),
        y: logitFrac((s.rates[i] as number) / ceil),
        w: 1,
      }));
    const trend = fitTrend(pts, prior, xTarget);
    const yTrend = trend === null ? null : logit(clamp(ceil * (1 / (1 + Math.exp(-trend.pred))), 0.01, 99.99));

    // Split trend: earners and players tracked, forecast separately, divide,
    // capped at the ceiling: earners cannot pass the share of players who
    // will ever earn the trophy.
    let yDec: number | null = null;
    if (nFit) {
      const ePts: Point[] = fitSnaps
        .filter((s) => s.rates[i] !== null && s.rates[i] !== undefined && s.players > 0)
        .map((s) => ({
          x: xOf(s.atMs),
          y: Math.log(Math.max(((s.rates[i] as number) / 100) * s.players, 0.5)),
          w: 1,
        }));
      const eFit = fitLine(ePts);
      if (eFit) {
        // Earners grow at least with the player base; shrink the earners'
        // slope toward the prior slope plus the players' slope.
        const nEffE = ePts.reduce((s, p) => s + p.w, 0);
        const bE = (nEffE * eFit[1] + 3 * (prior + nFit[1])) / (nEffE + 3);
        const aE = ePts.reduce((s, p) => s + p.w * (p.y - bE * p.x), 0) / Math.max(nEffE, 1e-9);
        const logEPred = aE + bE * xTarget;
        const rDec = clamp(100 * Math.exp(logEPred - logNPred), 0.01, ceil);
        yDec = logit(rDec);
      }
    }

    let yMed: number;
    let sFit = 0.35;
    if (trend === null && yDec === null) {
      yMed = yLast;
    } else {
      const models: Array<{ v: number; w: number }> = [];
      if (yTrend !== null && Number.isFinite(yTrend)) models.push({ v: yTrend, w: 0.6 });
      if (yDec !== null && Number.isFinite(yDec)) models.push({ v: yDec, w: 0.4 });
      const yModel = models.reduce((s, m) => s + m.v * m.w, 0) / models.reduce((s, m) => s + m.w, 0);
      // The cap is the guard against an absurd extrapolation: the forecast
      // may move a rate up to about 33-fold in odds from the last read, never
      // more. A heavier discount was tried and dropped: launch-week trophy
      // curves rise several-fold in a week (Phantom Blade Zero's fifth story
      // step went 8.3% at day 2 to 55.3% at day 11 on Steam), and discounting
      // the trend just re-predicts the last read.
      yMed = clamp(yModel, yLast - 3.5, yLast + 3.5);
      if (trend) sFit = clamp(trend.resid * Math.sqrt(1 + trend.leverage), 0.15, 1.0);
    }

    // A trophy nobody has earned yet in the last read still has a floor:
    // never forecast below the smallest rate the page can print.
    yMed = clamp(yMed, logit(0.01), logit(99.99));
    medians.push(yMed);

    const sRw = 0.45 * Math.sqrt(horizonDays);
    const s = clamp(Math.sqrt(sRw * sRw + sFit * sFit + staleSpread * staleSpread), 0.5, 2.2);
    spreads.push(s);
  });

  // The story funnel: chapter order is sequential, so the medians along it
  // cannot rise; the platinum cannot sit above any trophy it requires.
  // Pool-adjacent-violators on the logit medians of the chain.
  const chainIdx: number[] = [];
  const findBy = (re: RegExp): number => c.trophies.findIndex((t) => re.test(t.description));
  for (let ch = 1; ch <= 4; ch++) {
    const idx = findBy(new RegExp(`complete chapter ${ch}\\b`, 'i'));
    if (idx >= 0) chainIdx.push(idx);
  }
  const fin = c.trophies.findIndex((t) => /^complete the final mission\.?$/i.test(t.description));
  if (fin >= 0) chainIdx.push(fin);
  const comp = findBy(/100% completion/i);
  if (comp >= 0) chainIdx.push(comp);
  const plat = c.trophies.findIndex((t) => t.tier === 'platinum');
  if (plat >= 0) chainIdx.push(plat);
  if (chainIdx.length >= 2) {
    // PAVA for a non-increasing sequence.
    const vals = chainIdx.map((i) => medians[i]);
    const blocks: Array<{ sum: number; n: number }> = [];
    for (const v of vals) {
      blocks.push({ sum: v, n: 1 });
      while (blocks.length >= 2) {
        const b2 = blocks[blocks.length - 1];
        const b1 = blocks[blocks.length - 2];
        if (b1.sum / b1.n >= b2.sum / b2.n) break;
        blocks.splice(blocks.length - 2, 2, { sum: b1.sum + b2.sum, n: b1.n + b2.n });
      }
    }
    let k = 0;
    for (const b of blocks) {
      const avg = b.sum / b.n;
      for (let j = 0; j < b.n; j++) medians[chainIdx[k++]] = avg;
    }
  }
  if (plat >= 0) {
    const minOther = Math.min(...medians.filter((_, i) => i !== plat));
    medians[plat] = Math.min(medians[plat], minOther);
  }

  const z = c.levels.length === LEVELS.length && c.levels.every((t, j) => t === LEVELS[j])
    ? Z
    : c.levels.map((t) => normalQuantile(clamp(t, 0.001, 0.999)));
  const trophies = c.trophies.map((t, i) => ({
    id: t.id,
    q: z.map((zv) => round4(clamp(logistic(medians[i] + zv * spreads[i]), 0.01, 99.99))),
  }));
  return { trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!c.history || c.history.length === 0) throw new Error(`${file} has no history`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
}
