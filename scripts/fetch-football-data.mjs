#!/usr/bin/env node
// Refresh all provider data from football-data.org — the primary source now that
// the API-Football key's plan no longer covers the current season. Writes the
// exact files the API-Football path produced, so nothing downstream changes:
//
//   data/fixtures-2026.json      season schedule, updated in place (ids preserved)
//   data/portal.json             rolling results+fixtures snapshot
//   public/data/portal-live.json  browser-facing trim of the portal snapshot
//
// Dormant without a key: no FOOTBALL_DATA_KEY → log + exit 0, existing files stay.
// A failed season-schedule fetch still fails the run outright — shipping a stale
// schedule is worse than not shipping (see fetch-fixtures.mjs's comment).
//
//   FOOTBALL_DATA_KEY=... node scripts/fetch-football-data.mjs
//   DRY_RUN=1 ...                fetch + validate, write nothing
//   PORTAL_LOOKBEHIND_DAYS=30 ...    widen the portal window (e.g. backfill a gap)
//   --force                      ignore the freshness guard
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  COMPETITIONS,
  buildFixtureIndex,
  buildSnapshot,
  buildTeamIdIndex,
  mergeSeasonFixtures,
  publicSnapshot,
  toPortalFixture,
  toStandingTable,
} from './providers/football-data.mjs';

for (const envFile of ['.env.local', '.env']) {
  if (!existsSync(resolve(envFile))) continue;
  try {
    process.loadEnvFile(resolve(envFile));
  } catch (error) {
    console.warn(`Warning: could not load ${envFile}: ${messageFor(error)}`);
  }
}

const KEY = process.env.FOOTBALL_DATA_KEY?.trim();
const SEASON = integerEnv('FIXTURES_SEASON', 2026, 2020, 2100);
const LOOKBEHIND_DAYS = integerEnv('PORTAL_LOOKBEHIND_DAYS', 10, 0, 120);
const LOOKAHEAD_DAYS = integerEnv('PORTAL_LOOKAHEAD_DAYS', 14, 0, 120);
const TIMEOUT_MS = integerEnv(
  'FOOTBALL_DATA_TIMEOUT_MS',
  15_000,
  2_000,
  60_000,
);
const RETRIES = integerEnv('FOOTBALL_DATA_RETRIES', 2, 0, 5);
const FETCH_STANDINGS = process.env.FOOTBALL_DATA_FETCH_STANDINGS !== 'false';
// football-data.org free tier: 10 requests/minute. 6.5s keeps us under it with room.
const MIN_INTERVAL_MS = integerEnv(
  'FOOTBALL_DATA_MIN_INTERVAL_MS',
  6500,
  0,
  60_000,
);
const MIN_AGE_HOURS = integerEnv('FOOTBALL_DATA_MIN_AGE_HOURS', 20, 0, 720);
const DRY = process.env.DRY_RUN === '1';
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const BASE = 'https://api.football-data.org/v4';
const PORTAL_DEST = resolve(
  process.env.PORTAL_DESTINATION?.trim() || 'data/portal.json',
);
const PUBLIC_DEST = resolve(
  process.env.PORTAL_PUBLIC_DESTINATION?.trim() ||
    'public/data/portal-live.json',
);
const FIXTURES_DEST = join(process.cwd(), 'data', 'fixtures-2026.json');
const observedRateLimits = [];
let lastCall = 0;

if (!KEY) {
  console.log(
    'football-data.org: FOOTBALL_DATA_KEY is not set; keeping existing data files untouched.',
  );
  process.exit(0);
}

// The daily workflow runs this once for the schedule and again inside the build's
// prebuild — the guard makes the second run a no-op when the outputs are fresh.
if (!FORCE && !DRY && isFreshEnough(PORTAL_DEST, MIN_AGE_HOURS)) {
  console.log(
    `football-data.org: portal.json is fresher than ${MIN_AGE_HOURS}h — skipping (use --force to refresh).`,
  );
  process.exit(0);
}

const now = new Date();
const dateFrom = isoDay(addUtcDays(now, -LOOKBEHIND_DAYS));
const dateTo = isoDay(addUtcDays(now, LOOKAHEAD_DAYS));
const warnings = [];

try {
  const existingFixtures = JSON.parse(readFileSync(FIXTURES_DEST, 'utf8'));
  const teamsMeta = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'teams-meta.json'), 'utf8'),
  );
  const index = buildFixtureIndex(existingFixtures);
  const teamIds = buildTeamIdIndex(teamsMeta);

  // ── season schedule ──────────────────────────────────────
  // Same validation as fetch-fixtures.mjs: a calendar that comes back all at one
  // placeholder instant must fail loudly rather than ship.
  const seasonMatches = [];
  for (const comp of COMPETITIONS) {
    const body = await api(
      `/competitions/${comp.code}/matches?season=${SEASON}`,
    );
    seasonMatches.push(...(body.matches ?? []));
    console.log(
      `  ${comp.slug.padEnd(16)} ${body.matches?.length ?? 0} fixtures`,
    );
  }
  const merged = mergeSeasonFixtures(existingFixtures, seasonMatches);
  const problems = validateSchedule(merged.rows);
  if (problems.length) {
    console.error('\n✗ schedule failed validation — refusing to write:');
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  if (merged.unmatched.length) {
    warnings.push(
      `${merged.unmatched.length} fd.org fixtures did not resolve onto fixtures-2026 rows`,
    );
    console.warn(
      `  ⚠ ${merged.unmatched.length} season fixtures unmatched (left display-only):`,
    );
    for (const m of merged.unmatched.slice(0, 10)) {
      console.warn(
        `    · ${m.competition?.code} ${m.utcDate} ${m.homeTeam?.name} v ${m.awayTeam?.name}`,
      );
    }
  }

  // ── rolling portal window ────────────────────────────────
  // The API rejects windows wider than 10 days, so the range is chunked. No
  // competition filter: the free tier includes the five covered leagues plus a
  // few more, matching how the API-Football fetch let non-covered leagues flow
  // through for display.
  const seen = new Map();
  for (const [from, to] of dateChunks(dateFrom, dateTo, 9)) {
    const body = await api(`/matches?dateFrom=${from}&dateTo=${to}`);
    for (const m of body.matches ?? []) seen.set(m.id, m);
  }
  const fixtures = [...seen.values()]
    .map((m) => toPortalFixture(m, { index, seasonYear: SEASON }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const standings = [];
  if (FETCH_STANDINGS) {
    for (const comp of COMPETITIONS) {
      try {
        const body = await api(
          `/competitions/${comp.code}/standings?season=${SEASON}`,
        );
        standings.push(toStandingTable(body, comp.code, teamIds, SEASON));
      } catch (error) {
        warnings.push(`Standings ${comp.code}/${SEASON}: ${messageFor(error)}`);
      }
    }
  }

  const snapshot = buildSnapshot({
    fixtures,
    standings,
    dateFrom,
    dateTo,
    warnings,
    rateLimit: rateLimitSummary(),
    now,
  });

  if (DRY) {
    console.log(
      `\n◦ dry run — ${fixtures.length} portal fixtures, ${standings.length} standing tables, ${merged.changed.length} schedule changes, wrote nothing.`,
    );
    process.exit(0);
  }

  if (merged.changed.length) {
    writeJsonAtomic(FIXTURES_DEST, merged.rows);
    console.log(
      `  schedule: ${merged.changed.length} kickoff/round updates applied to fixtures-2026.json`,
    );
  }
  atomicJsonWrites([
    { destination: PORTAL_DEST, value: snapshot },
    { destination: PUBLIC_DEST, value: publicSnapshot(snapshot) },
  ]);
  console.log(
    `\n✓ football-data.org: ${snapshot.fixtures.length} fixtures (${snapshot.coverage.finishedFixtureCount} finished, ${snapshot.coverage.liveFixtureCount} live), ` +
      `${snapshot.coverage.standingTableCount} standing tables, window ${dateFrom}→${dateTo}`,
  );
} catch (error) {
  console.warn(
    `football-data.org refresh skipped: ${messageFor(error)} ${describeExisting()}`,
  );
  process.exitCode = 1;
}

// ── helpers ───────────────────────────────────────────────
async function api(path) {
  const waitMs = MIN_INTERVAL_MS - (Date.now() - lastCall);
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  lastCall = Date.now();
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { 'X-Auth-Token': KEY },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(
        `football-data.org request timed out or failed: ${messageFor(error)}`,
      );
    }
    const remaining = Number(res.headers.get('x-requests-available-minute'));
    if (Number.isFinite(remaining)) observedRateLimits.push(remaining);
    if (res.status === 429 && attempt < RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(retryAfter) ? retryAfter * 1000 : 10_000),
      );
      lastCall = Date.now();
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(body.matches ?? body.standings)) return body;
    const detail =
      body?.message || body?.error || res.statusText || 'request rejected';
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    throw new Error(`football-data.org HTTP ${res.status}: ${detail}`);
  }
  throw new Error('football-data.org request exhausted its retry budget.');
}

function validateSchedule(rows) {
  const problems = [];
  for (const comp of COMPETITIONS) {
    const fixtures = rows[comp.slug] ?? [];
    if (!fixtures.length) {
      problems.push(`${comp.slug}: no fixtures`);
      continue;
    }
    if (fixtures.length < 180)
      problems.push(
        `${comp.slug}: only ${fixtures.length} fixtures (expected 300+)`,
      );
    const slots = new Set(fixtures.map((f) => String(f.date).slice(11, 16)));
    if (slots.size < 4)
      problems.push(
        `${comp.slug}: only ${slots.size} distinct kickoff time(s) — looks like placeholder times`,
      );
  }
  return problems;
}

function isFreshEnough(path, maxAgeHours) {
  if (!existsSync(path)) return false;
  try {
    const snap = JSON.parse(readFileSync(path, 'utf8'));
    const age = Date.now() - new Date(snap.asOf).getTime();
    return Number.isFinite(age) && age < maxAgeHours * 3_600_000;
  } catch {
    return false;
  }
}

function describeExisting() {
  if (!existsSync(PORTAL_DEST))
    return 'No provider snapshot exists; the fixture fallback remains active.';
  try {
    const snap = JSON.parse(readFileSync(PORTAL_DEST, 'utf8'));
    return `Keeping the previous snapshot from ${snap.updatedAt || 'an unknown time'}.`;
  } catch {
    return 'The existing provider file was left untouched.';
  }
}

function writeJsonAtomic(dest, value) {
  atomicJsonWrites([{ destination: dest, value }]);
}

function atomicJsonWrites(entries) {
  const tmp = [];
  try {
    for (const e of entries) {
      mkdirSync(dirname(e.destination), { recursive: true });
      const t = `${e.destination}.${process.pid}.tmp`;
      writeFileSync(t, `${JSON.stringify(e.value, null, 2)}\n`, {
        mode: 0o644,
      });
      tmp.push({ t, d: e.destination });
    }
    for (const f of tmp) renameSync(f.t, f.d);
  } catch (error) {
    for (const f of tmp) {
      try {
        if (existsSync(f.t)) unlinkSync(f.t);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw error;
  }
}

function rateLimitSummary() {
  if (!observedRateLimits.length) return null;
  return {
    resetsInSeconds: null,
    remaining: Math.min(...observedRateLimits),
    requestedEntity: 'football-data.org requests/minute',
  };
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

// The /matches endpoint caps a date window at 10 days; split the range into
// [from, to] pairs of at most `days` days each.
function dateChunks(from, to, days) {
  const chunks = [];
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(
      Math.min(addUtcDays(start, days).getTime(), end.getTime()),
    );
    chunks.push([isoDay(start), isoDay(chunkEnd)]);
    start = addUtcDays(chunkEnd, 1);
  }
  return chunks;
}

function addUtcDays(d, days) {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function messageFor(error) {
  const message = error instanceof Error ? error.message : String(error);
  return KEY ? message.split(KEY).join('[redacted]') : message;
}
