// Season Monte Carlo: simulate a full double round-robin league season from current Elo
// (5,000 runs) → title / top-4 / relegation probabilities per club.
// This is the flagship "open model" product page — no fixture list needed pre-season:
// a double round-robin is fully defined by the club list.
import { ClubRow, LEAGUES } from "./data";
import { expectedGoals, HOME_ADV_CLUB } from "./model";

// How many of each finishing place is worth something. Defaults to the big-five
// shape; every league overrides it in lib/data.ts, because the Eredivisie sends
// two clubs straight into the Champions League and drops two automatically, and
// reporting a top-four chance there would describe a race that doesn't exist.
export interface RaceZones {
  cl: number;     // direct Champions League places
  eu: number;     // places that lead anywhere in Europe
  rel: number;    // clubs that go down automatically
}
const DEFAULT_ZONES: RaceZones = { cl: 4, eu: 6, rel: 3 };

// The zones a league is simulated with, for callers that label the numbers.
export function raceZones(leagueSlug: string): RaceZones {
  const l = LEAGUES.find((x) => x.slug === leagueSlug);
  return l ? { cl: l.cl, eu: l.eu, rel: l.rel } : DEFAULT_ZONES;
}

// Wording derived from those zones, so a page never prints "top four" about a
// league whose Champions League places are two.
export function raceLabels(leagueSlug: string): RaceZones & {
  clLabel: string;
  euLabel: string;
  relLabel: string;
  clChance: string;
  relChance: string;
} {
  const z = raceZones(leagueSlug);
  return {
    ...z,
    clLabel: `top ${z.cl}`,
    euLabel: `top ${z.eu}`,
    relLabel: `bottom ${z.rel}`,
    clChance: `chance of finishing in the top ${z.cl} (Champions League)`,
    relChance: `chance of finishing in the bottom ${z.rel} and going down`,
  };
}

// deterministic RNG (mulberry32) so builds are reproducible
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, rng: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

export interface SeasonOdds {
  avgRank?: number;   // mean finishing position (1 = top)
  europe?: number;    // P(finish inside the league's European places)
  ptsLo?: number;     // 10th-percentile points
  ptsHi?: number;     // 90th-percentile points
  slug: string;
  club: string;
  elo: number;
  title: number;     // P(1st)
  // top4/releg are field names kept for compatibility. They mean "the league's
  // Champions League places" and "the clubs that go down"; how many of each is
  // per-league (League.cl / League.rel), not a constant.
  top4: number;
  releg: number;
  avgPts: number;
}

export function simulateSeason(clubs: ClubRow[], sims = 5000, seed = 26, zones: RaceZones = DEFAULT_ZONES): SeasonOdds[] {
  const n = clubs.length;
  // Never count a place that doesn't exist, and never let the relegation band
  // overlap the European one: an 18-club league with 2 automatic drops and 4
  // European places needs both bands clamped to what the competition actually has.
  const cl = Math.max(1, Math.min(zones.cl, n - 1));
  const eu = Math.max(cl, Math.min(zones.eu, n - 1));
  const rel = Math.max(1, Math.min(zones.rel, n - cl));
  const rng = mulberry32(seed);
  const titleCt = new Array(n).fill(0);
  const top4Ct = new Array(n).fill(0);
  const europeCt = new Array(n).fill(0);
  const relegCt = new Array(n).fill(0);
  const ptsSum = new Array(n).fill(0);
  const rankSum = new Array(n).fill(0);
  // per-club points across every sim, for percentile ranges
  const ptsDist: number[][] = Array.from({ length: n }, () => new Array(sims));

  // precompute λ for every ordered pair (home i vs away j)
  const lamH: number[][] = [], lamA: number[][] = [];
  for (let i = 0; i < n; i++) {
    lamH[i] = []; lamA[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) { lamH[i][j] = 0; lamA[i][j] = 0; continue; }
      lamH[i][j] = expectedGoals(clubs[i].elo, clubs[j].elo, HOME_ADV_CLUB);
      lamA[i][j] = expectedGoals(clubs[j].elo, clubs[i].elo, -HOME_ADV_CLUB / 2);
    }
  }

  const pts = new Array(n);
  const order = new Array(n);
  for (let s = 0; s < sims; s++) {
    pts.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const gh = poisson(lamH[i][j], rng);
        const ga = poisson(lamA[i][j], rng);
        if (gh > ga) pts[i] += 3;
        else if (gh < ga) pts[j] += 3;
        else { pts[i] += 1; pts[j] += 1; }
      }
    }
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((x: number, y: number) => pts[y] - pts[x] || rng() - 0.5);
    titleCt[order[0]]++;
    for (let k = 0; k < cl; k++) top4Ct[order[k]]++;
    for (let k = 0; k < eu; k++) europeCt[order[k]]++;
    for (let k = n - rel; k < n; k++) relegCt[order[k]]++;
    for (let k = 0; k < n; k++) rankSum[order[k]] += k + 1;
    for (let i = 0; i < n; i++) { ptsSum[i] += pts[i]; ptsDist[i][s] = pts[i]; }
  }

  const pctile = (arr: number[], q: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };

  return clubs.map((c, i) => ({
    slug: c.slug,
    club: c.club,
    elo: c.elo,
    title: titleCt[i] / sims,
    top4: top4Ct[i] / sims,
    europe: europeCt[i] / sims,
    releg: relegCt[i] / sims,
    avgPts: ptsSum[i] / sims,
    avgRank: rankSum[i] / sims,
    ptsLo: pctile(ptsDist[i], 0.1),
    ptsHi: pctile(ptsDist[i], 0.9),
  })).sort((a, b) => b.avgPts - a.avgPts);
}

// build-time cache so every league × 5k sims runs once per build
const cache = new Map<string, SeasonOdds[]>();
export function seasonOdds(leagueSlug: string, clubs: ClubRow[]): SeasonOdds[] {
  if (!cache.has(leagueSlug)) cache.set(leagueSlug, simulateSeason(clubs, 5000, 26, raceZones(leagueSlug)));
  return cache.get(leagueSlug)!;
}
