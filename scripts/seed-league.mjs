#!/usr/bin/env node
// Seed the files a new league needs before it can be fetched or simulated.
//
// Nothing else in the pipeline can create a league, only refresh one:
//   · mergeSeasonFixtures updates rows already in fixtures-2026.json — a brand-new
//     competition resolves to nothing and is dropped as "unmatched"
//   · build-teams-meta.mjs reads rosters from apifb-teams.jsonl, which no live
//     script writes any more (the API-Football key's plan no longer covers the
//     current season, so the fetch that once produced it is dormant)
//
// So this writes the three identity files once: the schedule, the roster line and
// the crest/id map. Identities come from football-data.org (which does cover the
// season) joined onto API-Football team ids, because every downstream key —
// fixtures, squads, standings — is built on those ids.
//
//   node scripts/seed-league.mjs --slug=eredivisie --fd=DED --api-league=88
//   --api-seasons=2022,2023,2024   seasons to read team ids from. Team ids are
//                  stable, but a club relegated in the interim drops out of that
//                  season's list, so pooling recent ones keeps every current club
//                  resolvable. Defaults to the three most recent.
//   --fd-season=2026               football-data.org season (the schedule itself)
//   --dry-run                      fetch, validate, print, write nothing
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

for (const envFile of ['.env.local', '.env']) {
  const p = join(process.cwd(), envFile);
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* env already in the process */ }
  }
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY = process.argv.includes('--dry-run');

const SLUG = arg('slug');
const FD_CODE = arg('fd');
const API_LEAGUE = Number(arg('api-league'));
const FD_SEASON = Number(arg('fd-season', process.env.FIXTURES_SEASON ?? '2026'));
const API_SEASONS = String(arg('api-seasons', '2022,2023,2024'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Number.isFinite);

if (!SLUG || !FD_CODE || !Number.isFinite(API_LEAGUE) || !API_SEASONS.length) {
  console.error('✗ needs --slug=<our slug> --fd=<football-data code> --api-league=<API-Football league id>');
  process.exit(1);
}
const FD_KEY = process.env.FOOTBALL_DATA_KEY?.trim();
const API_KEY = process.env.API_FOOTBALL_KEY?.trim();
if (!FD_KEY) { console.error('✗ FOOTBALL_DATA_KEY is not set'); process.exit(1); }
if (!API_KEY) { console.error('✗ API_FOOTBALL_KEY is not set (needed for team ids)'); process.exit(1); }

const fdApi = async (path) => {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FD_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`football-data.org ${path} → ${res.status}: ${body?.message ?? res.statusText}`);
  return body;
};

// API-Football answers 200 with an `errors` payload for plan and quota problems,
// so the HTTP status alone never tells you whether the call worked.
const afApi = async (path) => {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  const errors = body?.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    throw new Error(`API-Football ${path}: ${JSON.stringify(errors)}`);
  }
  if (!Array.isArray(body?.response)) throw new Error(`API-Football ${path}: unexpected response`);
  return body.response;
};

const slugify = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Legal-form and numeric tokens that differ between providers and carry no
// identity ("FC Twente '65" vs "Twente", "Telstar 1963" vs "Telstar").
const DROP = new Set(['fc', 'cf', 'afc', 'sc', 'ssc', 'sbv', 'sv', 'ac', 'as', 'us', 'ogc', 'rc', 'rcd', 'cd', 'ud', 'pec', 'nec', 'ado', 'vfb', 'vfl', 'fsv', 'tsg', 'pvv']);

// Naming differences token-stripping cannot bridge: keyed by the football-data.org
// name, valued by the API-Football name to match instead.
const ALIAS = { NEC: 'NEC Nijmegen' };

const key = (name) => {
  const tokens = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => !DROP.has(t) && !/^(1[7-9]\d\d|20\d\d|\d+)$/.test(t));
  // A name consisting only of legal-form tokens must not collapse to the empty
  // string: an empty key is a subset of every name and would match any club.
  return tokens.length ? tokens.join(' ') : slugify(name);
};

const teamsBody = await fdApi(`/competitions/${FD_CODE}/teams?season=${FD_SEASON}`);
const matchesBody = await fdApi(`/competitions/${FD_CODE}/matches?season=${FD_SEASON}`);
const apiRows = [];
for (const season of API_SEASONS) {
  apiRows.push(...(await afApi(`/teams?league=${API_LEAGUE}&season=${season}`)));
  await new Promise((r) => setTimeout(r, 400));
}

const fdTeams = teamsBody.teams ?? [];
const fdMatches = matchesBody.matches ?? [];
const byApi = [];
for (const row of apiRows) {
  const t = row?.team;
  if (t?.id && !byApi.some((x) => x.id === t.id)) {
    byApi.push({ id: t.id, name: t.name, logo: t.logo, key: key(t.name) });
  }
}
console.log(`  football-data.org: ${fdTeams.length} clubs, ${fdMatches.length} fixtures (season ${FD_SEASON})`);
console.log(`  API-Football league ${API_LEAGUE} seasons ${API_SEASONS.join(',')}: ${byApi.length} distinct clubs`);

// fd.org club → API-Football club: exact key, else a *unique* token-subset match
// ("PSV" ⊂ "PSV Eindhoven"). Unresolved is fatal rather than guessed — a fixture
// written with the wrong id joins to the wrong club and every page inherits it.
const resolveApiId = (fdTeam) => {
  const k = key(ALIAS[fdTeam.name] ?? fdTeam.name);
  const exact = byApi.filter((t) => t.key === k);
  if (exact.length === 1) return exact[0];
  const mine = new Set(k.split(' ').filter(Boolean));
  const overlaps = (other) =>
    [...mine].every((t) => other.has(t)) || [...other].every((t) => mine.has(t));
  const fuzzy = byApi.filter((t) => overlaps(new Set(t.key.split(' '))));
  return fuzzy.length === 1 ? fuzzy[0] : null;
};

const teamIds = new Map();
const unresolvedTeams = [];
for (const t of fdTeams) {
  const hit = resolveApiId(t);
  if (!hit) { unresolvedTeams.push(`${t.id} ${t.name}`); continue; }
  teamIds.set(t.id, hit);
}

// Stored kickoff format is the API-Football one (offset-suffixed, no millis).
const iso = (d) => `${String(d).slice(0, 19)}+00:00`;
const rows = [];
const unresolvedMatches = new Set();
for (const m of fdMatches) {
  const home = teamIds.get(m.homeTeam?.id);
  const away = teamIds.get(m.awayTeam?.id);
  if (!home || !away) { unresolvedMatches.add(m.competition?.code ?? 'match'); continue; }
  rows.push({
    id: m.id,
    date: iso(m.utcDate),
    round: Number.isInteger(m.matchday) ? `Regular Season - ${m.matchday}` : (m.stage ?? null),
    venue: m.venue ?? null,
    city: null,
    homeId: home.id,
    awayId: away.id,
    home: home.name,
    away: away.name,
  });
}
rows.sort((a, b) => a.date.localeCompare(b.date));

// The same guards the refresh scripts apply, run before writing instead of after.
const problems = [];
if (unresolvedTeams.length) problems.push(`${unresolvedTeams.length} clubs had no API-Football id: ${unresolvedTeams.join('; ')}`);
if (rows.length !== fdMatches.length) problems.push(`${fdMatches.length - rows.length} of ${fdMatches.length} fixtures unresolved`);
const expected = fdTeams.length * (fdTeams.length - 1);
if (rows.length < expected) problems.push(`${rows.length} fixtures — a double round-robin of ${fdTeams.length} clubs needs ${expected}`);
const slots = new Set(rows.map((r) => r.date.slice(11, 16)));
if (slots.size < 4) problems.push(`only ${slots.size} distinct kickoff times — looks like placeholder data`);
if (problems.length) {
  console.error('\n✗ refusing to seed:');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

const FIXTURES = join(process.cwd(), 'data', 'fixtures-2026.json');
const APIFB = join(process.cwd(), 'data', 'apifb-teams.jsonl');
const META = join(process.cwd(), 'data', 'teams-meta.json');

const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
if (fixtures[SLUG]?.length) {
  console.error(`\n✗ data/fixtures-2026.json already holds ${fixtures[SLUG].length} rows for "${SLUG}" — seeding would overwrite them. Delete that key first if that is really intended.`);
  process.exit(1);
}
const apiLines = readFileSync(APIFB, 'utf8').trim().split('\n');
const existingLine = apiLines.findIndex((l) => JSON.parse(l).league === API_LEAGUE);
const meta = JSON.parse(readFileSync(META, 'utf8'));
const rosterTeams = [...teamIds.values()];
const newMeta = rosterTeams.filter((t) => !meta[slugify(t.name)]);

console.log(`\n  ${SLUG}: ${rows.length} fixtures, ${rosterTeams.length} clubs`);
for (const t of rosterTeams) console.log(`    ${String(t.id).padStart(5)}  ${t.name}`);

if (DRY) {
  console.log(`\n◦ dry run — validated, wrote nothing. ${newMeta.length} new teams-meta entries, ${existingLine >= 0 ? 'replaces' : 'appends to'} the league-${API_LEAGUE} roster line.`);
  process.exit(0);
}

fixtures[SLUG] = rows;
const tmpFixtures = `${FIXTURES}.tmp`;
writeFileSync(tmpFixtures, JSON.stringify(fixtures, null, 1));
renameSync(tmpFixtures, FIXTURES);

const rosterLine = { league: API_LEAGUE, count: rosterTeams.length, teams: rosterTeams.map((t) => ({ id: t.id, name: t.name, logo: t.logo })) };
if (existingLine >= 0) apiLines[existingLine] = JSON.stringify(rosterLine);
else apiLines.push(JSON.stringify(rosterLine));
writeFileSync(APIFB, apiLines.join('\n') + '\n');

for (const t of newMeta) meta[slugify(t.name)] = { apiId: t.id, apiName: t.name, logo: t.logo };
writeFileSync(META, JSON.stringify(meta, null, 1) + '\n');

console.log(`\n✓ seeded "${SLUG}" — fixtures-2026.json (+${rows.length}), apifb-teams.jsonl (league ${API_LEAGUE}), teams-meta.json (+${newMeta.length})`);
console.log('  next: node scripts/build-teams-meta.mjs   # rebuild data/leagues-2026.json');
