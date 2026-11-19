// Local checks for this entry. Run from the repo root:
//   node tools/check.mjs
// It runs main.ts on the kit practice cases, checks the output format,
// checks two runs write the same bytes, and scores the model against the
// persistence baseline and a log-time curve baseline on synthetic worlds
// with known answers. It prints PASS or FAIL per check and exits 1 on
// any failure. Nothing here ships to the grader; main.ts runs alone.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const KIT = '/home/hatch/workspace/makefun/gta6-trophy-rarity-forecast-01-kit';
const TROPHIES = JSON.parse(readFileSync(join(ROOT, 'data', 'trophies.json'), 'utf8'));
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
  if (!ok) failures++;
};

// Small deterministic RNG so the synthetic worlds are repeatable.
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (pct) => Math.log(clamp(pct, 0.01, 99.99) / (100 - clamp(pct, 0.01, 99.99)));
const invLogit = (x) => 100 / (1 + Math.exp(-x));
const round4 = (x) => Math.round(x * 10000) / 10000;
const round2 = (x) => Math.round(x * 100) / 100;

/** Pinball loss on the logit scale, per the bounty spec. */
const pinball = (forecast, actual) => {
  let total = 0;
  let n = 0;
  for (const row of forecast.trophies) {
    const y = actual[row.id];
    for (let j = 0; j < LEVELS.length; j++) {
      const d = logit(y) - logit(row.q[j]);
      total += 2 * Math.max(LEVELS[j] * d, (LEVELS[j] - 1) * d);
      n++;
    }
  }
  return total / n;
};

/** Persistence baseline, the house starter, reimplemented from the spec. */
const persistence = (c) => {
  const last = c.history[c.history.length - 1];
  const spread = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return {
    trophies: c.trophies.map((t, i) => ({
      id: t.id,
      q: Z.map((z) => round4(invLogit(logit(last.rates[i] ?? 0) + z * spread))),
    })),
  };
};

/** Log-time curve baseline: least squares of logit rate on ln(1+hours). */
const curve = (c) => {
  const release = Date.parse('2026-11-19T00:00:00Z');
  const t = (iso) => (Date.parse(iso) - release) / 3600000;
  const tTarget = t(c.target);
  return {
    trophies: c.trophies.map((trophy, i) => {
      const xs = [];
      const ys = [];
      for (const r of c.history) {
        if (r.rates[i] === null) continue;
        xs.push(Math.log1p(t(r.at)));
        ys.push(logit(r.rates[i]));
      }
      let a = ys.length ? ys[ys.length - 1] : logit(0.01);
      let b = 0;
      if (xs.length >= 2) {
        const mx = xs.reduce((x, y) => x + y, 0) / xs.length;
        const my = ys.reduce((x, y) => x + y, 0) / ys.length;
        let sxx = 0;
        let sxy = 0;
        for (let k = 0; k < xs.length; k++) {
          sxx += (xs[k] - mx) ** 2;
          sxy += (xs[k] - mx) * (ys[k] - my);
        }
        if (sxx > 0) {
          b = sxy / sxx;
          a = my - b * mx;
        }
      }
      const mid = a + b * Math.log1p(tTarget);
      const spread = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
      return { id: trophy.id, q: Z.map((z) => round4(invLogit(mid + z * spread))) };
    }),
  };
};

const runMain = (inputDir, outDir) => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync('node', ['main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir },
    stdio: 'pipe',
  });
};

/** Validate one output file against the known trophy table. */
const validateOut = (path, label) => {
  const raw = readFileSync(path, 'utf8');
  check(`${label}: under 65536 bytes`, raw.length <= 65536, `(${raw.length})`);
  const out = JSON.parse(raw);
  check(`${label}: top key only`, Object.keys(out).length === 1 && Array.isArray(out.trophies));
  check(`${label}: 55 rows`, out.trophies.length === 55, `(${out.trophies.length})`);
  const ids = out.trophies.map((r) => r.id).sort((a, b) => a - b);
  const want = TROPHIES.map((t) => t.id).sort((a, b) => a - b);
  check(`${label}: ids match trophy table`, JSON.stringify(ids) === JSON.stringify(want));
  let ok = true;
  for (const row of out.trophies) {
    if (Object.keys(row).length !== 2 || row.q.length !== 5) ok = false;
    for (let j = 0; j < 5; j++) {
      if (!Number.isFinite(row.q[j]) || row.q[j] < 0 || row.q[j] > 100) ok = false;
      if (j > 0 && row.q[j] < row.q[j - 1]) ok = false;
    }
  }
  check(`${label}: quantiles finite, 0..100, non-decreasing`, ok);
  return out;
};

// 1. Practice cases.
const practiceIn = join(KIT, 'input');
const outA = join(ROOT, '.check-out-a');
const outB = join(ROOT, '.check-out-b');
const started = Date.now();
runMain(practiceIn, outA);
const ms = Date.now() - started;
check('practice run under 8s per case', ms < 16000, `(${ms}ms for 2 cases)`);
const p00 = validateOut(join(outA, 'p00.out'), 'p00');
const p01 = validateOut(join(outA, 'p01.out'), 'p01');
runMain(practiceIn, outB);
const same =
  readFileSync(join(outA, 'p00.out'), 'utf8') === readFileSync(join(outB, 'p00.out'), 'utf8') &&
  readFileSync(join(outA, 'p01.out'), 'utf8') === readFileSync(join(outB, 'p01.out'), 'utf8');
check('practice runs byte-identical', same);
// Direction: the low quantiles carry the refresh drop (most q05 sit
// below the last rate), while the median stays near the last rate, since
// no refresh is the likelier outcome inside 90 minutes; the 100 percent
// trophy stays at 100.
const kitP00 = JSON.parse(readFileSync(join(practiceIn, 'p00.in'), 'utf8'));
const lastRates = kitP00.history[kitP00.history.length - 1].rates;
let below05 = 0;
let medianNear = 0;
let at100 = 0;
for (const row of p00.trophies) {
  const i = row.id - 1;
  if (lastRates[i] === 100 && row.q[2] === 100) at100++;
  if (row.q[0] < lastRates[i]) below05++;
  if (Math.abs(row.q[2] - lastRates[i]) < 0.05) medianNear++;
}
check('p00: most q05 below last rate', below05 >= 40, `(${below05}/55)`);
check('p00: median near last rate', medianNear >= 50, `(${medianNear}/55)`);
check('p00: 100 percent trophy stays 100', at100 === 1);
console.log(`  p00 median for trophy 3 (Paradise Lost): last ${lastRates[2]} -> q50 ${p00.trophies[2].q[2]}, q05 ${p00.trophies[2].q[0]}`);
console.log(`  p01 median for trophy 3: q50 ${p01.trophies[2].q[2]}, q05 ${p01.trophies[2].q[0]}`);

// 2. Synthetic worlds with known answers.
const RELEASE = Date.parse('2026-11-19T00:00:00Z');
const iso = (hours) => new Date(RELEASE + hours * 3600000).toISOString().replace('.000Z', 'Z');

/**
 * Simulate one world. Cohorts arrive at refreshes; each cohort earns
 * trophy i toward ceiling c_i at hazard h_i. Returns {case, answer}.
 */
const simulateWorld = (seed, kind) => {
  const r = rng(seed);
  // Per-trophy ceiling and hazard: a mix of early, mid and grindy.
  const params = TROPHIES.map((t) => {
    const u = r();
    if (t.id === 2) return { c: 1, h: 3 };
    if (u < 0.25) return { c: 0.5 + r() * 0.45, h: 0.25 + r() * 0.5 };
    if (u < 0.6) return { c: 0.15 + r() * 0.35, h: 0.05 + r() * 0.15 };
    return { c: 0.01 + r() * 0.14, h: 0.005 + r() * 0.05 };
  });
  // Refresh schedule: [hour, players added].
  let refreshes;
  let atHour;
  let horizonHours;
  if (kind === 'shock') {
    refreshes = [[0, 638]];
    atHour = 3;
    horizonHours = 1.5;
  } else if (kind === 'steady') {
    refreshes = [[0, 600]];
    let n = 600;
    // Cohorts keep arriving past the checkpoint, right up to the target,
    // the way launch week keeps bringing new players, but each wave is
    // smaller than the last: the launch spike fades instead of compounding
    // forever.
    for (let h = 6; h <= 168; h += 6) {
      const add = Math.round(n * 0.5 * Math.exp(-h / 48));
      refreshes.push([h, add]);
      n += add;
    }
    atHour = 60;
    horizonHours = 108;
  } else if (kind === 'saturate') {
    refreshes = [[0, 600]];
    let n = 600;
    for (let h = 6; h <= 60; h += 6) {
      const add = Math.round(n * 0.5 * Math.exp(-h / 48));
      refreshes.push([h, add]);
      n += add;
    }
    // No new players after the checkpoint: rates move by earning alone.
    atHour = 60;
    horizonHours = 108;
  } else {
    refreshes = [[0, 638]];
    atHour = 3;
    horizonHours = 1.5;
  }
  const cohorts = refreshes.map(([h, n]) => ({ at: h, n }));
  const holding = (i, t) => {
    let e = 0;
    let n = 0;
    for (const co of cohorts) {
      if (co.at > t) continue;
      const age = t - co.at;
      e += co.n * params[i].c * (1 - Math.exp(-params[i].h * age));
      n += co.n;
    }
    return { e, n };
  };
  const readAt = (h) => {
    const rates = TROPHIES.map((_, i) => {
      const { e, n } = holding(i, h);
      return round2((e / n) * 100);
    });
    const { n } = holding(0, h);
    return { slot: iso(h), at: iso(h), players_tracked: n, trophies_earned: 0, rates };
  };
  const history = [];
  if (kind === 'shock' || kind === 'flat') {
    for (let h = -0.17; h <= atHour; h += 0.5) {
      const read = readAt(Math.max(0, h));
      if (history.length === 0 || read.slot !== history[history.length - 1].slot) history.push(read);
    }
    if (kind === 'shock') {
      // The jump lands between the checkpoint and the target.
      cohorts.push({ at: atHour + 1, n: 3230 });
    }
  } else {
    for (let h = 0; h <= atHour; h += 0.5) history.push(readAt(h));
  }
  const targetHour = atHour + horizonHours;
  const answer = {};
  for (let i = 0; i < TROPHIES.length; i++) {
    const { e, n } = holding(i, targetHour);
    answer[TROPHIES[i].id] = round2((e / n) * 100);
  }
  const c = {
    schema: 'makefun/gta6-trophies-case/v1',
    id: `syn-${kind}-${seed}`,
    at: iso(atHour),
    horizon_minutes: Math.round(horizonHours * 60),
    target: iso(targetHour),
    levels: LEVELS,
    game: { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: '' },
    trophies: TROPHIES.map((t) => ({ id: t.id, name: t.name, description: t.description, tier: t.tier, points: t.points, secret: t.secret })),
    history,
    notes: 'synthetic',
  };
  return { c, answer };
};

const synDir = join(ROOT, '.check-syn');
const synOut = join(ROOT, '.check-syn-out');
rmSync(synDir, { recursive: true, force: true });
mkdirSync(synDir, { recursive: true });
const worlds = [];
for (const kind of ['shock', 'steady', 'flat', 'saturate']) {
  for (let seed = 1; seed <= 3; seed++) {
    const w = simulateWorld(seed * 17 + kind.length, kind);
    writeFileSync(join(synDir, `${w.c.id}.in`), JSON.stringify(w.c));
    worlds.push(w);
  }
}
runMain(synDir, synOut);
let myLoss = 0;
let perLoss = 0;
let curveLoss = 0;
for (const w of worlds) {
  const mine = JSON.parse(readFileSync(join(synOut, `${w.c.id}.out`), 'utf8'));
  const pl = pinball(mine, w.answer);
  const bl = pinball(persistence(w.c), w.answer);
  const cl = pinball(curve(w.c), w.answer);
  myLoss += pl;
  perLoss += bl;
  curveLoss += cl;
  console.log(`  ${w.c.id}: mine ${pl.toFixed(4)} persistence ${bl.toFixed(4)} curve ${cl.toFixed(4)}`);
  if (process.env.DEBUG_SYN && (w.c.id.startsWith('syn-steady') || w.c.id.startsWith('syn-saturate'))) {
    const last = w.c.history[w.c.history.length - 1];
    console.log(`  DEBUG ${w.c.id}: N last ${last.players_tracked}, horizon ${w.c.horizon_minutes}min`);
    for (const id of [1, 3, 15, 20, 32, 40]) {
      const row = mine.trophies.find((r) => r.id === id);
      console.log(`    trophy ${id}: last ${last.rates[id - 1]} answer ${w.answer[id]} mine q50 ${row.q[2]} q05 ${row.q[0]} q95 ${row.q[4]}`);
    }
  }
}
myLoss /= worlds.length;
perLoss /= worlds.length;
curveLoss /= worlds.length;
console.log(`  mean: mine ${myLoss.toFixed(4)} persistence ${perLoss.toFixed(4)} curve ${curveLoss.toFixed(4)}`);
check('synthetic mean loss beats persistence', myLoss < perLoss);
check('synthetic mean loss beats curve baseline', myLoss < curveLoss);

// Cleanup scratch dirs.
rmSync(outA, { recursive: true, force: true });
rmSync(outB, { recursive: true, force: true });
rmSync(synDir, { recursive: true, force: true });
rmSync(synOut, { recursive: true, force: true });

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
