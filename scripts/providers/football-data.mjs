// football-data.org adapter: translates the v4 API's payloads into the exact
// shapes the site already stores — the portal snapshot (lib/portal.ts's
// PortalFixture/PortalStandingTable) and the fixtures-2026.json rows.
//
// The translation that matters is identity, not field names: predictions and
// results are joined on the API-Football fixture id recorded in
// data/fixtures-2026.json, so every fd.org match is resolved back onto that
// schedule (league + normalized team names + kickoff date) and re-stamped with
// the existing ids. Unmatched fixtures stay display-only (providerId null) —
// they can never write a result under another fixture's identity.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// fd.org competition ids ↔ API-Football league ids ↔ our slugs.
export const COMPETITIONS = [
  {
    code: 'PL',
    fdId: 2021,
    slug: 'premier-league',
    apiLeagueId: 39,
    name: 'Premier League',
  },
  {
    code: 'PD',
    fdId: 2014,
    slug: 'la-liga',
    apiLeagueId: 140,
    name: 'La Liga',
  },
  {
    code: 'SA',
    fdId: 2019,
    slug: 'serie-a',
    apiLeagueId: 135,
    name: 'Serie A',
  },
  {
    code: 'BL1',
    fdId: 2002,
    slug: 'bundesliga',
    apiLeagueId: 78,
    name: 'Bundesliga',
  },
  {
    code: 'FL1',
    fdId: 2015,
    slug: 'ligue-1',
    apiLeagueId: 61,
    name: 'Ligue 1',
  },
];
const byFdId = new Map(COMPETITIONS.map((c) => [c.fdId, c]));
const byCode = new Map(COMPETITIONS.map((c) => [c.code, c]));

// Legal-form tokens that differ between providers and carry no identity.
const DROP_TOKENS = new Set([
  'fc',
  'cf',
  'afc',
  'cfc',
  'sc',
  'ssc',
  'sv',
  'ac',
  'as',
  'bc',
  'bk',
  'fk',
  'sk',
  'ud',
  'cd',
  'rc',
  'rcd',
  'ssd',
  'us',
  'vfb',
  'vfl',
  'tsg',
  'tsv',
  'fsv',
  'bvb',
  'bv',
  'ss',
  'acf',
  'aj',
  'estac',
  'ogc',
  'sco',
  'ca',
  'calcio',
  'sd',
  'rcd',
]);

// Provider naming differences that survive token stripping. Keys and values are
// already-normalized forms; applied to both sides, so it is safe to list a
// pair even when only one provider uses the longer name.
const TEAM_ALIASES = new Map([
  ['internazionale milano', 'inter'],
  ['wolverhampton wanderers', 'wolves'],
  ['olympique de marseille', 'marseille'],
  ['olympique lyonnais', 'lyon'],
  ['tottenham hotspur', 'tottenham'],
  ['west ham united', 'west ham'],
  ['brighton hove albion', 'brighton'],
  ['leeds united', 'leeds'],
  ['newcastle united', 'newcastle'],
  ['leicester city', 'leicester'],
  ['club atletico de madrid', 'atletico madrid'],
  ['atletico de madrid', 'atletico madrid'],
  ['real betis balompie', 'real betis'],
  ['real sociedad de futbol', 'real sociedad'],
  ['espanyol de barcelona', 'espanyol'],
  ['deportivo alaves', 'alaves'],
  ['losc lille', 'lille'],
  ['stade rennais 1901', 'rennes'],
  ['stade rennais', 'rennes'],
  ['strasbourg alsace', 'strasbourg'],
  ['sport club freiburg', 'freiburg'],
  ['bayer 04 leverkusen', 'bayer leverkusen'],
  ['coventry city', 'coventry'],
  ['ipswich town', 'ipswich'],
]);

export function normalizeTeamKey(name) {
  if (typeof name !== 'string') return '';
  let key = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let tokens = key.split(' ').filter(Boolean);
  if (tokens[0] === '1') tokens = tokens.slice(1);
  tokens = tokens.filter(
    (t) => !DROP_TOKENS.has(t) && !/^(1[7-9]\d\d|20\d\d)$/.test(t),
  );
  key = tokens.join(' ');
  return TEAM_ALIASES.get(key) ?? key;
}

// fd.org status → API-Football-style {long, short}. The short codes drive
// isLive/isFinished in the stored shape, so the live set must stay aligned with
// lib/portal.ts consumers ("LIVE" and "HT" are already in the live list).
const STATUS_MAP = {
  SCHEDULED: ['Time to be defined', 'TBD'],
  TIMED: ['Not Started', 'NS'],
  IN_PLAY: ['In Play', 'LIVE'],
  PAUSED: ['Halftime', 'HT'],
  EXTRA_TIME: ['Extra Time', 'ET'],
  PENALTY_SHOOTOUT: ['Penalty In Progress', 'P'],
  FINISHED: ['Match Finished', 'FT'],
  SUSPENDED: ['Match Suspended', 'SUSP'],
  POSTPONED: ['Match Postponed', 'PST'],
  CANCELLED: ['Match Cancelled', 'CANC'],
  AWARDED: ['Match Awarded', 'AWD'],
};

export function mapStatus(status) {
  const mapped = STATUS_MAP[status];
  if (mapped) return { long: mapped[0], short: mapped[1] };
  return { long: status || 'Unknown', short: status || 'NS' };
}

function competitionForMatch(match) {
  const fdId = numberOrNull(match?.competition?.id);
  if (fdId !== null && byFdId.has(fdId)) return byFdId.get(fdId);
  const code = match?.competition?.code;
  return typeof code === 'string' ? (byCode.get(code) ?? null) : null;
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Index over the existing fixtures-2026.json rows so an fd.org match can be
// resolved back to its API-Football fixture id. Kickoff dates can disagree by a
// day across providers (timezone edges, schedule revisions), so resolution
// accepts ±2 days and prefers the closest date.
export function buildFixtureIndex(fixturesJson) {
  const byKey = new Map();
  const rowsByLeague = new Map();
  for (const [slug, list] of Object.entries(fixturesJson ?? {})) {
    for (const row of list ?? []) {
      const hk = normalizeTeamKey(row.home);
      const ak = normalizeTeamKey(row.away);
      const date = String(row.date ?? '').slice(0, 10);
      if (!hk || !ak || !date) continue;
      const entry = { slug, row, hk, ak, date };
      byKey.set(`${slug}|${hk}|${ak}|${date}`, entry);
      if (!rowsByLeague.has(slug)) rowsByLeague.set(slug, []);
      rowsByLeague.get(slug).push(entry);
    }
  }
  function resolve(match) {
    const comp = competitionForMatch(match);
    if (!comp) return null;
    const hk = normalizeTeamKey(
      match?.homeTeam?.name ?? match?.homeTeam?.shortName,
    );
    const ak = normalizeTeamKey(
      match?.awayTeam?.name ?? match?.awayTeam?.shortName,
    );
    const date = String(match?.utcDate ?? '').slice(0, 10);
    if (!hk || !ak || !date) return null;
    for (const delta of [0, -1, 1, -2, 2]) {
      const hit = byKey.get(
        `${comp.slug}|${hk}|${ak}|${shiftDate(date, delta)}`,
      );
      if (hit) return hit;
    }
    // Second pass: providers disagree on name suffixes in ways no alias table
    // covers exhaustively ("Rayo Vallecano de Madrid" vs "Rayo Vallecano").
    // Same league, same day(±2), one name's tokens contained in the other's —
    // accepted only when the candidate is unique, so a fuzzy hit can never pick
    // the wrong fixture.
    const candidates = (rowsByLeague.get(comp.slug) ?? []).filter(
      (entry) =>
        Math.abs(daysBetween(entry.date, date)) <= 2 &&
        nameSubset(entry.hk, hk) &&
        nameSubset(entry.ak, ak),
    );
    return candidates.length === 1 ? candidates[0] : null;
  }
  return { resolve };
}

function nameSubset(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return false;
  const contained = (x, y) => [...x].every((t) => y.has(t));
  return contained(sa, sb) || contained(sb, sa);
}

function daysBetween(a, b) {
  return (
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
    86_400_000
  );
}

// slug → {apiId, apiName} from data/teams-meta.json, indexed by normalized name
// so fd.org team names resolve to API-Football team ids (used for standings).
export function buildTeamIdIndex(teamsMeta) {
  const byName = new Map();
  for (const meta of Object.values(teamsMeta ?? {})) {
    const key = normalizeTeamKey(meta?.apiName);
    if (key && meta.apiId != null) byName.set(key, meta.apiId);
  }
  return byName;
}

const LIVE_SHORT = new Set([
  '1H',
  'HT',
  '2H',
  'ET',
  'BT',
  'P',
  'SUSP',
  'INT',
  'LIVE',
]);
const FINISHED_SHORT = new Set(['FT', 'AET', 'PEN']);

function roundName(match, comp) {
  if (comp && Number.isInteger(match?.matchday))
    return `Regular Season - ${match.matchday}`;
  const stage =
    typeof match?.stage === 'string'
      ? match.stage
          .toLowerCase()
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      : null;
  return Number.isInteger(match?.matchday)
    ? `${stage ?? 'Regular Season'} - ${match.matchday}`
    : stage;
}

// fd.org match → PortalFixture (the shape scripts/fetch-api-football.mjs writes
// into data/portal.json). Identity fields come from the resolved schedule row;
// everything else from the fd.org payload.
export function toPortalFixture(match, { index, seasonYear = 2026 } = {}) {
  const hit = index?.resolve(match) ?? null;
  const row = hit?.row ?? null;
  const comp = competitionForMatch(match);
  const status = mapStatus(match?.status);
  const ft = match?.score?.fullTime ?? {};
  const ht = match?.score?.halfTime ?? {};
  const home = numOrNull(ft.home);
  const away = numOrNull(ft.away);
  const halfHome = numOrNull(ht.home);
  const halfAway = numOrNull(ht.away);
  const winner = match?.score?.winner ?? null;
  const homeId = row?.homeId ?? numberOrNull(match?.homeTeam?.id);
  const awayId = row?.awayId ?? numberOrNull(match?.awayTeam?.id);
  const homeName =
    row?.home ??
    match?.homeTeam?.shortName ??
    match?.homeTeam?.name ??
    'Unknown team';
  const awayName =
    row?.away ??
    match?.awayTeam?.shortName ??
    match?.awayTeam?.name ??
    'Unknown team';
  const providerId = row ? numberOrNull(row.id) : null;
  const finished = FINISHED_SHORT.has(status.short);

  const scores = [
    scoreEntry(homeId, 'home', 'CURRENT', home),
    scoreEntry(awayId, 'away', 'CURRENT', away),
    scoreEntry(homeId, 'home', '1ST_HALF', halfHome),
    scoreEntry(awayId, 'away', '1ST_HALF', halfAway),
  ].filter((entry) => entry.goals !== null);

  return {
    id:
      providerId !== null
        ? `api-football:${providerId}`
        : `football-data:${match?.id}`,
    providerId,
    name: `${homeName} vs ${awayName}`,
    startTime: new Date(match?.utcDate).toISOString(),
    resultInfo:
      finished && home !== null && away !== null ? `${home}-${away}` : null,
    seasonId: seasonYearOf(match) ?? seasonYear,
    stageId: null,
    roundId: null,
    hasOdds: false,
    lastProcessedAt: null,
    status: {
      id: null,
      name: status.long,
      shortName: status.short,
      developerName: status.short,
      isLive: LIVE_SHORT.has(status.short),
      isFinished: finished,
    },
    league: {
      id: comp?.apiLeagueId ?? numberOrNull(match?.competition?.id),
      name: comp?.name ?? match?.competition?.name ?? null,
      shortCode: null,
      imageUrl: safeHttpUrl(match?.competition?.emblem),
    },
    round: {
      id: null,
      name: roundName(match, comp),
      shortCode: null,
      imageUrl: null,
    },
    venue: {
      id: null,
      name: row?.venue ?? stringOrNull(match?.venue),
      city: row?.city ?? null,
      capacity: null,
      imageUrl: null,
    },
    participants: [
      participant(
        homeId,
        homeName,
        match?.homeTeam,
        'home',
        winner === 'HOME_TEAM' ? true : winner ? false : null,
      ),
      participant(
        awayId,
        awayName,
        match?.awayTeam,
        'away',
        winner === 'AWAY_TEAM' ? true : winner ? false : null,
      ),
    ],
    score: { home, away, halfTimeHome: halfHome, halfTimeAway: halfAway },
    scores,
    events: [],
    lineups: [],
    injuries: [],
  };
}

function participant(id, name, team, role, winner) {
  return {
    id,
    name,
    shortCode: stringOrNull(team?.tla),
    imageUrl: safeHttpUrl(team?.crest),
    role,
    position: null,
    winner,
  };
}

function scoreEntry(participantId, participantRole, description, goals) {
  return {
    id: null,
    typeId: null,
    participantId,
    description,
    participant: participantRole,
    goals,
  };
}

function seasonYearOf(match) {
  const start = match?.season?.startDate;
  if (typeof start === 'string' && start.length >= 4) {
    const year = Number(start.slice(0, 4));
    if (Number.isFinite(year)) return year;
  }
  return null;
}

// fd.org standings response → PortalStandingTable (the shape normalizeStandingTables
// produced from API-Football data).
export function toStandingTable(response, code, teamIds, seasonYear = 2026) {
  const comp = byCode.get(code);
  const seasonId = seasonYearOf(response) ?? seasonYear;
  const groups = Array.isArray(response?.standings) ? response.standings : [];
  const table = groups.find((g) => g?.type === 'TOTAL') ?? groups[0];
  const rows = (Array.isArray(table?.table) ? table.table : [])
    .map((row) => {
      const team = row?.team ?? {};
      const key = normalizeTeamKey(team.name ?? team.shortName);
      const apiId = (key && teamIds?.get(key)) ?? null;
      const form =
        typeof row?.form === 'string'
          ? row.form.split(',').filter(Boolean)
          : [];
      return {
        id: null,
        participantId: apiId ?? numberOrNull(team.id),
        position: numberOrNull(row?.position),
        points: numberOrNull(row?.points),
        result: null,
        leagueId: comp?.apiLeagueId ?? null,
        seasonId,
        stageId: null,
        groupId: null,
        roundId: null,
        participant: {
          id: apiId ?? numberOrNull(team.id),
          name:
            stringOrNull(team.shortName) ??
            stringOrNull(team.name) ??
            'Unknown team',
          shortCode: stringOrNull(team.tla),
          imageUrl: safeHttpUrl(team.crest),
          role: null,
          position: numberOrNull(row?.position),
          winner: null,
        },
        details: [
          {
            typeId: null,
            value: numberOrNull(row?.playedGames),
            description: 'Played',
          },
          { typeId: null, value: numberOrNull(row?.won), description: 'Won' },
          {
            typeId: null,
            value: numberOrNull(row?.draw),
            description: 'Drawn',
          },
          { typeId: null, value: numberOrNull(row?.lost), description: 'Lost' },
          {
            typeId: null,
            value: numberOrNull(row?.goalsFor),
            description: 'Goals for',
          },
          {
            typeId: null,
            value: numberOrNull(row?.goalsAgainst),
            description: 'Goals against',
          },
          {
            typeId: null,
            value: numberOrNull(row?.goalDifference),
            description: 'Goal difference',
          },
        ].filter((d) => d.value !== null),
        form: form.map((value) => ({ fixtureId: null, form: value })),
      };
    })
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  return { seasonId, leagueId: comp?.apiLeagueId ?? null, rows };
}

// Refresh fixtures-2026.json in place: rescheduled kickoffs, round labels and
// venues update, but ids and club names are preserved so every downstream join
// (snapshots, results, team-meta) keeps working. fd.org fixtures that don't map
// onto an existing row are reported, not appended — an fd.org id written into
// the schedule would never resolve to a club and would only collide.
export function mergeSeasonFixtures(existing, fdMatches) {
  const rows = JSON.parse(JSON.stringify(existing ?? {}));
  const index = buildFixtureIndex(rows);
  const changed = [];
  const unmatched = [];
  for (const match of fdMatches ?? []) {
    const comp = competitionForMatch(match);
    if (!comp) continue;
    const hit = index.resolve(match);
    if (!hit) {
      unmatched.push(match);
      continue;
    }
    const row = hit.row;
    const next = { ...row };
    const iso = new Date(match.utcDate)
      .toISOString()
      .replace(/\.\d{3}Z$/, '+00:00');
    if (iso !== row.date) next.date = iso;
    const round = roundName(match, comp);
    if (round && round !== row.round) next.round = round;
    const venue = stringOrNull(match.venue);
    if (venue && !row.venue) next.venue = venue;
    if (JSON.stringify(next) !== JSON.stringify(row)) {
      const list = rows[comp.slug];
      const at = list.indexOf(row);
      if (at >= 0) list[at] = next;
      changed.push({ id: row.id, from: row.date, to: next.date });
    }
  }
  for (const list of Object.values(rows)) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }
  return { rows, changed, unmatched };
}

// Same envelope scripts/fetch-api-football.mjs writes; provider is honest about
// the upstream and coverage.upstream records the real source.
export function buildSnapshot({
  fixtures,
  standings,
  dateFrom,
  dateTo,
  warnings = [],
  rateLimit = null,
  now = new Date(),
}) {
  const updatedAt = now.toISOString();
  return {
    schemaVersion: 1,
    provider: 'football-data',
    asOf: updatedAt,
    updatedAt,
    coverage: {
      dateFrom,
      dateTo,
      fixtureCount: fixtures.length,
      liveFixtureCount: fixtures.filter((f) => f.status.isLive).length,
      finishedFixtureCount: fixtures.filter((f) => f.status.isFinished).length,
      leagueCount: new Set(fixtures.map((f) => f.league.id)).size,
      standingTableCount: standings.filter((t) => t.rows.length > 0).length,
      requestedIncludes: ['fixtures', 'standings'],
      upstream: 'football-data.org',
      features: {
        fixtures: true,
        scores: true,
        statuses: true,
        events: false,
        lineups: false,
        injuries: false,
        standings: standings.some((t) => t.rows.length > 0),
      },
      rateLimit,
      warnings,
    },
    fixtures,
    standings,
  };
}

// Same public-trim rule as fetch-api-football.mjs's publicSnapshot().
export function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    standings: [],
    fixtures: snapshot.fixtures.map((fixture) => ({
      ...fixture,
      scores: [],
      events: [],
      lineups: [],
      injuries: [],
    })),
  };
}

export function loadFixturesFile(root = process.cwd()) {
  return JSON.parse(
    readFileSync(join(root, 'data', 'fixtures-2026.json'), 'utf8'),
  );
}

export function loadTeamsMeta(root = process.cwd()) {
  return JSON.parse(
    readFileSync(join(root, 'data', 'teams-meta.json'), 'utf8'),
  );
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numOrNull(value) {
  return numberOrNull(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
