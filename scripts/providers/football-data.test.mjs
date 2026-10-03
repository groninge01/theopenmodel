// Tests for the football-data.org → stored-shape adapter. Run: node --test scripts/providers/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTeamKey,
  mapStatus,
  buildFixtureIndex,
  toPortalFixture,
  toStandingTable,
  buildTeamIdIndex,
  mergeSeasonFixtures,
  buildSnapshot,
  publicSnapshot,
} from "./football-data.mjs";

const FIXTURES = {
  "premier-league": [
    { id: 1557367, date: "2026-08-21T19:00:00+00:00", round: "Regular Season - 1", venue: "Emirates Stadium", city: "London", homeId: 42, awayId: 1346, home: "Arsenal", away: "Coventry" },
    { id: 1557368, date: "2026-08-22T14:00:00+00:00", round: "Regular Season - 1", venue: "Old Trafford", city: "Manchester", homeId: 33, awayId: 50, home: "Manchester United", away: "Manchester City" },
  ],
  "bundesliga": [
    { id: 1600001, date: "2026-08-22T18:30:00+00:00", round: "Regular Season - 1", venue: "Allianz Arena", city: "Munich", homeId: 157, awayId: 165, home: "Bayern München", away: "Borussia Dortmund" },
  ],
};

const fdMatch = (over = {}) => ({
  id: 536191,
  utcDate: "2026-08-21T19:00:00Z",
  status: "FINISHED",
  matchday: 1,
  stage: "REGULAR_SEASON",
  venue: null,
  competition: { id: 2021, name: "Premier League", code: "PL", emblem: "https://crests.football-data.org/PL.png" },
  season: { id: 2350, startDate: "2026-08-14", endDate: "2027-05-24", currentMatchday: 6 },
  homeTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS", crest: "https://crests.football-data.org/57.png" },
  awayTeam: { id: 1044, name: "Coventry City FC", shortName: "Coventry", tla: "COV", crest: "https://crests.football-data.org/1044.png" },
  score: { winner: "HOME_TEAM", duration: "REGULAR", fullTime: { home: 2, away: 0 }, halfTime: { home: 1, away: 0 } },
  ...over,
});

// ── team-name normalization ───────────────────────────────
test("normalizeTeamKey strips legal-form tokens and diacritics", () => {
  assert.equal(normalizeTeamKey("Arsenal FC"), "arsenal");
  assert.equal(normalizeTeamKey("FC Bayern München"), "bayern munchen");
  assert.equal(normalizeTeamKey("Bayern München"), "bayern munchen");
  assert.equal(normalizeTeamKey("Manchester United FC"), "manchester united");
  assert.equal(normalizeTeamKey("1. FC Köln"), "koln");
  assert.equal(normalizeTeamKey("Parma Calcio 1913"), "parma");
  assert.equal(normalizeTeamKey("SSC Napoli"), "napoli");
});

test("normalizeTeamKey maps known provider naming differences via aliases", () => {
  assert.equal(normalizeTeamKey("FC Internazionale Milano"), "inter");
  assert.equal(normalizeTeamKey("Wolverhampton Wanderers FC"), "wolves");
  assert.equal(normalizeTeamKey("Olympique de Marseille"), "marseille");
  assert.equal(normalizeTeamKey("Tottenham Hotspur FC"), "tottenham");
  assert.equal(normalizeTeamKey("Paris FC"), "paris");
  assert.equal(normalizeTeamKey("Paris Saint-Germain FC"), "paris saint germain");
});

// ── status mapping ────────────────────────────────────────
test("mapStatus preserves live/finished semantics", () => {
  assert.equal(mapStatus("FINISHED").short, "FT");
  assert.equal(mapStatus("TIMED").short, "NS");
  assert.equal(mapStatus("IN_PLAY").short, "LIVE");
  assert.equal(mapStatus("PAUSED").short, "HT");
  assert.equal(mapStatus("POSTPONED").short, "PST");
  assert.equal(mapStatus("SCHEDULED").short, "TBD");
});

// ── canonical id resolution ───────────────────────────────
test("resolveFixture joins fd.org matches onto existing API-Football fixture ids", () => {
  const index = buildFixtureIndex(FIXTURES);
  const resolved = index.resolve(fdMatch());
  assert.equal(resolved?.row.id, 1557367);
});

test("resolveFixture tolerates a one-day UTC date shift", () => {
  const index = buildFixtureIndex(FIXTURES);
  const resolved = index.resolve(fdMatch({ utcDate: "2026-08-22T22:00:00Z" }));
  assert.equal(resolved?.row.id, 1557367);
});

test("resolveFixture returns null for fixtures outside the covered leagues", () => {
  const index = buildFixtureIndex(FIXTURES);
  const resolved = index.resolve(fdMatch({
    competition: { id: 2000, name: "Europa League", code: "EL" },
  }));
  assert.equal(resolved, null);
});

// ── portal fixture translation ────────────────────────────
test("toPortalFixture emits the stored PortalFixture shape with the canonical id", () => {
  const index = buildFixtureIndex(FIXTURES);
  const f = toPortalFixture(fdMatch(), { index });
  assert.equal(f.id, "api-football:1557367");
  assert.equal(f.providerId, 1557367);
  assert.equal(f.name, "Arsenal vs Coventry");
  assert.equal(f.startTime, "2026-08-21T19:00:00.000Z");
  assert.equal(f.status.name, "Match Finished");
  assert.equal(f.status.shortName, "FT");
  assert.equal(f.status.isFinished, true);
  assert.equal(f.status.isLive, false);
  assert.equal(f.resultInfo, "2-0");
  assert.equal(f.league.id, 39);
  assert.equal(f.league.name, "Premier League");
  assert.equal(f.round.name, "Regular Season - 1");
  assert.equal(f.venue.name, "Emirates Stadium");
  assert.equal(f.venue.city, "London");
  assert.deepEqual(f.score, { home: 2, away: 0, halfTimeHome: 1, halfTimeAway: 0 });
  assert.equal(f.participants[0].id, 42);
  assert.equal(f.participants[0].role, "home");
  assert.equal(f.participants[0].winner, true);
  assert.equal(f.participants[1].winner, false);
  assert.equal(f.scores.length, 4);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.lineups, []);
  assert.deepEqual(f.injuries, []);
});

test("toPortalFixture falls back to fd.org ids with a null providerId when unresolved", () => {
  const index = buildFixtureIndex(FIXTURES);
  const f = toPortalFixture(fdMatch({
    competition: { id: 2000, name: "Europa League", code: "EL", emblem: null },
    homeTeam: { id: 500, name: "AS Roma", shortName: "Roma", tla: "ROM", crest: "https://crests.football-data.org/500.png" },
    awayTeam: { id: 501, name: "OGC Nice", shortName: "Nice", tla: "NIC", crest: null },
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    status: "TIMED",
  }), { index });
  assert.equal(f.id, "football-data:536191");
  assert.equal(f.providerId, null);
  assert.equal(f.name, "Roma vs Nice");
  assert.equal(f.status.isFinished, false);
  assert.equal(f.resultInfo, null);
  assert.equal(f.league.id, 2000);
  assert.equal(f.league.name, "Europa League");
  assert.equal(f.participants[0].id, 500);
});

// ── Eredivisie: a league seeded rather than inherited from API-Football ────
// The identity join is what makes a prediction attributable, so these cover the
// naming differences the two providers have for Dutch clubs and the id stamping
// a seeded fixture depends on.
const DED_FIXTURES = {
  eredivisie: [
    { id: 558214, date: "2026-08-07T18:00:00+00:00", round: "Regular Season - 1", venue: null, city: null, homeId: 420, awayId: 196, home: "Cambuur", away: "Excelsior" },
    { id: 558215, date: "2026-08-08T16:45:00+00:00", round: "Regular Season - 1", venue: null, city: null, homeId: 197, awayId: 413, home: "PSV Eindhoven", away: "NEC Nijmegen" },
  ],
};

const dedMatch = (over = {}) => ({
  id: 900001,
  utcDate: "2026-08-07T18:00:00Z",
  status: "FINISHED",
  matchday: 1,
  stage: "REGULAR_SEASON",
  venue: null,
  competition: { id: 2003, name: "Eredivisie", code: "DED", emblem: "https://crests.football-data.org/ED.png" },
  season: { id: 2493, startDate: "2026-08-07", endDate: "2027-05-23", currentMatchday: 8 },
  homeTeam: { id: 1909, name: "SC Cambuur-Leeuwarden", shortName: "Cambuur", tla: "CAM", crest: "https://crests.football-data.org/1909.png" },
  awayTeam: { id: 670, name: "SBV Excelsior", shortName: "Excelsior", tla: "EXC", crest: "https://crests.football-data.org/670.png" },
  score: { winner: "AWAY_TEAM", duration: "REGULAR", fullTime: { home: 0, away: 4 }, halfTime: { home: 0, away: 3 } },
  ...over,
});

test("normalizeTeamKey maps Dutch provider naming differences", () => {
  assert.equal(normalizeTeamKey("SC Cambuur-Leeuwarden"), "cambuur");
  assert.equal(normalizeTeamKey("SBV Excelsior"), "excelsior");
  assert.equal(normalizeTeamKey("PSV Eindhoven"), "psv");
  assert.equal(normalizeTeamKey("AZ Alkmaar"), "az");
  assert.equal(normalizeTeamKey("NEC Nijmegen"), "nec");
  assert.equal(normalizeTeamKey("Willem II Tilburg"), "willem ii");
  assert.equal(normalizeTeamKey("Feyenoord Rotterdam"), "feyenoord");
});

test("resolveFixture joins Eredivisie matches onto seeded fixture ids", () => {
  const index = buildFixtureIndex(DED_FIXTURES);
  assert.equal(index.resolve(dedMatch())?.row.id, 558214);
});

test("toPortalFixture stamps the seeded id and reads the score through", () => {
  const index = buildFixtureIndex(DED_FIXTURES);
  const f = toPortalFixture(dedMatch(), { index });
  assert.equal(f.providerId, 558214);
  assert.equal(f.id, "api-football:558214");
  assert.equal(f.name, "Cambuur vs Excelsior");
  assert.equal(f.league.id, 88);
  assert.equal(f.league.name, "Eredivisie");
  assert.deepEqual(f.score, { home: 0, away: 4, halfTimeHome: 0, halfTimeAway: 3 });
  assert.equal(f.resultInfo, "0-4");
  assert.equal(f.participants[1].winner, true);
});

test("toStandingTable tags Eredivisie rows with the API-Football league id", () => {
  const table = toStandingTable({
    standings: [{
      type: "TOTAL",
      table: [{ position: 1, team: { id: 674, name: "PSV", shortName: "PSV", tla: "PSV", crest: "https://crests.football-data.org/674.png" }, points: 20, playedGames: 8 }],
    }],
  }, "DED", new Map([["psv", 197]]), 2026);
  assert.equal(table.leagueId, 88);
  assert.equal(table.rows[0].participantId, 197);
});

test("mergeSeasonFixtures leaves a seeded Eredivisie schedule untouched", () => {
  const merged = mergeSeasonFixtures(DED_FIXTURES, [dedMatch()]);
  assert.equal(merged.unmatched.length, 0);
  assert.equal(merged.changed.length, 0);
  assert.equal(merged.rows.eredivisie.length, 2);
});


// ── standings translation ─────────────────────────────────
test("toStandingTable maps fd.org tables to the stored PortalStandingTable shape", () => {
  const teamIds = buildTeamIdIndex({
    arsenal: { apiId: 42, apiName: "Arsenal", logo: "x" },
    "man-city": { apiId: 50, apiName: "Manchester City", logo: "x" },
  });
  const response = {
    season: { startDate: "2026-08-14" },
    standings: [{
      stage: "REGULAR_SEASON",
      type: "TOTAL",
      table: [
        { position: 1, team: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS", crest: "c" }, playedGames: 6, won: 5, draw: 1, lost: 0, points: 16, goalsFor: 14, goalsAgainst: 3, goalDifference: 11, form: "W,W,D" },
        { position: 2, team: { id: 65, name: "Manchester City FC", shortName: "Man City", tla: "MCI", crest: "c" }, playedGames: 6, won: 4, draw: 1, lost: 1, points: 13, goalsFor: 12, goalsAgainst: 5, goalDifference: 7, form: null },
      ],
    }],
  };
  const table = toStandingTable(response, "PL", teamIds);
  assert.equal(table.leagueId, 39);
  assert.equal(table.seasonId, 2026);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].participantId, 42);
  assert.equal(table.rows[0].position, 1);
  assert.equal(table.rows[0].points, 16);
  assert.equal(table.rows[0].participant.name, "Arsenal");
  assert.deepEqual(table.rows[0].form, [{ fixtureId: null, form: "W" }, { fixtureId: null, form: "W" }, { fixtureId: null, form: "D" }]);
  assert.deepEqual(table.rows[0].details.map((d) => d.description), ["Played", "Won", "Drawn", "Lost", "Goals for", "Goals against", "Goal difference"]);
});

// ── season schedule merge ─────────────────────────────────
test("mergeSeasonFixtures updates existing rows in place, preserving ids", () => {
  const next = mergeSeasonFixtures(FIXTURES, [
    fdMatch({ utcDate: "2026-08-21T20:15:00Z" }),
    fdMatch({ id: 536192, utcDate: "2026-08-22T14:00:00Z", homeTeam: { id: 61, name: "Manchester United FC", shortName: "Man United", tla: "MUN" }, awayTeam: { id: 65, name: "Manchester City FC", shortName: "Man City", tla: "MCI" } }),
  ]);
  assert.equal(next.rows["premier-league"][0].id, 1557367);
  assert.equal(next.rows["premier-league"][0].date, "2026-08-21T20:15:00+00:00");
  assert.equal(next.rows["premier-league"][0].home, "Arsenal");
  assert.equal(next.rows["premier-league"][0].venue, "Emirates Stadium");
  assert.equal(next.changed.length, 1);
  assert.equal(next.unmatched.length, 0);
});

test("mergeSeasonFixtures reports but does not append unknown fixtures", () => {
  const next = mergeSeasonFixtures(FIXTURES, [
    fdMatch({ id: 999, homeTeam: { id: 900, name: "FC Unknown", shortName: "Unknown", tla: "UNK" }, awayTeam: { id: 901, name: "Elsewhere FC", shortName: "Elsewhere", tla: "ELS" } }),
  ]);
  assert.equal(next.rows["premier-league"].length, 2);
  assert.equal(next.unmatched.length, 1);
});

// ── snapshot assembly ─────────────────────────────────────
test("buildSnapshot mirrors the api-football snapshot envelope", () => {
  const index = buildFixtureIndex(FIXTURES);
  const snap = buildSnapshot({
    fixtures: [toPortalFixture(fdMatch(), { index })],
    standings: [],
    dateFrom: "2026-09-27",
    dateTo: "2026-10-16",
    warnings: [],
    rateLimit: null,
  });
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.provider, "football-data");
  assert.equal(snap.coverage.fixtureCount, 1);
  assert.equal(snap.coverage.finishedFixtureCount, 1);
  assert.equal(snap.coverage.features.standings, false);
  assert.equal(snap.coverage.upstream, "football-data.org");
  assert.ok(typeof snap.asOf === "string" && snap.asOf.endsWith("Z"));
});

test("publicSnapshot strips detail fields like the api-football writer", () => {
  const index = buildFixtureIndex(FIXTURES);
  const snap = buildSnapshot({
    fixtures: [toPortalFixture(fdMatch(), { index })],
    standings: [{ seasonId: 2026, leagueId: 39, rows: [{}] }],
    dateFrom: "2026-09-27",
    dateTo: "2026-10-16",
    warnings: [],
    rateLimit: null,
  });
  const pub = publicSnapshot(snap);
  assert.deepEqual(pub.standings, []);
  assert.deepEqual(pub.fixtures[0].scores, []);
  assert.deepEqual(pub.fixtures[0].events, []);
  assert.equal(pub.fixtures[0].providerId, 1557367);
});
