#!/usr/bin/env node
// Build data/leagues-2026.json: authoritative 2026-27 league rosters from
// football-data.org (data/fd-teams.jsonl, dumped by fetch-football-data.mjs)
// joined with ClubElo ratings (any level — promoted clubs sit at level 2 in
// ClubElo until their flags update). ClubElo's level-1 flags lag promotion/
// relegation, so fd.org owns membership; ClubElo owns strength.
//
// Also writes data/teams-meta.json (slug → {fdId, apiId, name, crest}) — the
// lookup fetch-football-data.mjs uses to resolve provider entities — and
// re-keys data/fixtures-2026.json homeId/awayId from the legacy API-Football
// team ids onto fd.org ids (idempotent; fixture ids themselves never move —
// the public record joins on them).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LG = {
  2021: 'premier-league',
  2014: 'la-liga',
  2019: 'serie-a',
  2002: 'bundesliga',
  2015: 'ligue-1',
};
const LG_COUNTRY = {
  2021: 'ENG',
  2014: 'ESP',
  2019: 'ITA',
  2002: 'GER',
  2015: 'FRA',
};
const slugify = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// football-data.org team name → ClubElo club name, where canon() can't bridge.
const ALIAS = {
  'Athletic Club': 'Bilbao',
  'Paris Saint-Germain FC': 'Paris SG',
  'Stade Brestois 29': 'Brest',
  'Stade Rennais FC 1901': 'Rennes',
  'ES Troyes AC': 'Troyes',
  'RC Deportivo La Coruña': 'La Coruna',
  'RCD Espanyol de Barcelona': 'Espanyol',
  'Real Racing Club de Santander': 'Racing',
  'Real Racing Club': 'Racing',
  'AC Milan': 'Milan',
  'AS Roma': 'Roma',
  'FC Internazionale Milano': 'Inter',
  'Manchester United FC': 'Man United',
  'Manchester City FC': 'Man City',
  'Newcastle United FC': 'Newcastle',
  'Nottingham Forest FC': 'Forest',
  'Wolverhampton Wanderers FC': 'Wolves',
  'Club Atlético de Madrid': 'Atletico',
  'Real Betis Balompié': 'Betis',
  'Real Sociedad de Fútbol': 'Sociedad',
  'RC Celta de Vigo': 'Celta',
  'Deportivo Alavés': 'Alaves',
  'FC Bayern München': 'Bayern',
  'TSG 1899 Hoffenheim': 'Hoffenheim',
  'Borussia Mönchengladbach': 'Gladbach',
  '1. FC Köln': 'Koeln',
  'Hamburger SV': 'Hamburg',
  '1. FSV Mainz 05': 'Mainz',
  'VfB Stuttgart': 'Stuttgart',
  'SC Freiburg': 'Freiburg',
  'FC Augsburg': 'Augsburg',
  'Borussia Dortmund': 'Dortmund',
  'Bayer 04 Leverkusen': 'Leverkusen',
  'Eintracht Frankfurt': 'Frankfurt',
  'SV Werder Bremen': 'Werder',
  'SC Paderborn 07': 'Paderborn',
  'SV Elversberg': 'Elversberg',
  'FC Schalke 04': 'Schalke',
  '1. FC Union Berlin': 'Union Berlin',
  'Hellas Verona FC': 'Verona',
};

const canon = (s) =>
  slugify(s)
    .replace(
      /\b(fc|cf|afc|ac|as|ss|ssc|sc|us|ogc|rc|rcd|cd|ud|sv|vfb|vfl|fsv|1899|07|04|05|1|de|balompie|futbol)\b/g,
      '',
    )
    .replace(/manchester/g, 'man')
    .replace(/internazionale/g, 'inter')
    .replace(/saint/g, 'st')
    .replace(/munchen|munich/g, '')
    .replace(/koln|cologne/g, 'koeln')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const csv = readFileSync(
  new URL('../data/clubelo-latest.csv', import.meta.url),
  'utf8',
);
const clubelo = csv
  .trim()
  .split('\n')
  .slice(1)
  .map((l) => l.split(','))
  .map((r) => ({
    club: r[1],
    country: r[2],
    level: Number(r[3]),
    elo: Math.round(Number(r[4]) * 10) / 10,
  }));

const dumps = readFileSync(
  new URL('../data/fd-teams.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

// Legacy apiIds, preserved into teams-meta.json so historical team-keyed rows
// (fixtures-2026.json homeId/awayId) can still be re-keyed onto fd.org ids.
const oldRosters = existsSync(
  new URL('../data/leagues-2026.json', import.meta.url),
)
  ? JSON.parse(
      readFileSync(
        new URL('../data/leagues-2026.json', import.meta.url),
        'utf8',
      ),
    )
  : {};
const oldApiIdBySlug = {};
for (const rows of Object.values(oldRosters)) {
  for (const r of rows) if (r.apiId != null) oldApiIdBySlug[r.slug] = r.apiId;
}

const out = {};
const meta = {};
const misses = [];
for (const lg of dumps) {
  const slug0 = LG[lg.league];
  const country = LG_COUNTRY[lg.league];
  if (!slug0 || !country) continue;
  const pool = clubelo.filter((c) => c.country === country);
  const rows = [];
  for (const t of lg.teams) {
    const target = ALIAS[t.name];
    let ce = target ? pool.find((c) => c.club === target) : undefined;
    if (!ce) ce = pool.find((c) => canon(c.club) === canon(t.name));
    if (!ce) {
      // Substring fallback — "RCD Espanyol de Barcelona" contains both
      // "espanyol" and "barcelona", so prefer the hit earliest in the name
      // (club name leads, city/legal suffix trails).
      const tn = canon(t.name);
      ce = pool
        .filter(
          (c) =>
            canon(c.club) &&
            (tn.includes(canon(c.club)) || canon(c.club).includes(tn)),
        )
        .sort(
          (a, b) =>
            tn.indexOf(canon(a.club)) - tn.indexOf(canon(b.club)) ||
            canon(b.club).length - canon(a.club).length,
        )[0];
    }
    if (!ce) {
      misses.push(`${country} ${t.name}`);
      continue;
    }
    const slug = slugify(ce.club);
    rows.push({
      slug,
      club: ce.club,
      country,
      elo: ce.elo,
      fdId: t.id,
      apiId: oldApiIdBySlug[slug] ?? null,
      logo: t.logo,
    });
    meta[slug] = {
      fdId: t.id,
      apiId: oldApiIdBySlug[slug] ?? null,
      name: t.name,
      crest: t.logo,
    };
  }
  rows.sort((a, b) => b.elo - a.elo);
  out[slug0] = rows;
}

writeFileSync(
  new URL('../data/leagues-2026.json', import.meta.url),
  JSON.stringify(out, null, 1),
);
writeFileSync(
  new URL('../data/teams-meta.json', import.meta.url),
  JSON.stringify(meta, null, 1),
);

// Re-key fixtures-2026.json team ids: apiId → fdId (fixture ids untouched).
// Idempotent and name-verified: apiId and fdId spaces overlap numerically, so a
// value only moves when the fixture's club name confirms the mapped club, and a
// value already holding the right fdId is left alone.
const apiToFd = {};
const fdClub = {};
for (const rows of Object.values(out)) {
  for (const r of rows) {
    const old = oldApiIdBySlug[r.slug];
    if (old != null && r.fdId != null) apiToFd[old] = r.fdId;
    // Fixture names are API-Football style, which may match either the ClubElo
    // club name ("Leverkusen") or the fd.org name ("Bayer 04 Leverkusen").
    if (r.fdId != null)
      fdClub[r.fdId] = [canon(r.club), canon(meta[r.slug].name)];
  }
}
const tokens = (s) => new Set(canon(s).split('-').filter(Boolean));
const nameOk = (fixtureName, clubCanons) => {
  const a = tokens(fixtureName);
  if (!a.size || !clubCanons) return false;
  const sub = (x, y) => [...x].every((t) => y.has(t));
  return clubCanons.some((canonName) => {
    const b = new Set(canonName.split('-').filter(Boolean));
    return b.size && (sub(a, b) || sub(b, a));
  });
};
let rekeyed = 0,
  unmappable = 0;
const fdIds = new Set(Object.keys(fdClub).map(Number));
const fixPath = new URL('../data/fixtures-2026.json', import.meta.url);
if (existsSync(fixPath) && fdIds.size) {
  const fixtures = JSON.parse(readFileSync(fixPath, 'utf8'));
  for (const list of Object.values(fixtures)) {
    for (const f of list) {
      for (const [k, nk] of [
        ['homeId', 'home'],
        ['awayId', 'away'],
      ]) {
        if (f[k] == null) continue;
        const mapped = apiToFd[f[k]];
        if (mapped != null && nameOk(f[nk], fdClub[mapped])) {
          if (f[k] !== mapped) {
            f[k] = mapped;
            rekeyed++;
          }
        } else if (!(fdIds.has(f[k]) && nameOk(f[nk], fdClub[f[k]]))) {
          unmappable++;
        }
      }
    }
  }
  if (rekeyed) writeFileSync(fixPath, JSON.stringify(fixtures, null, 1));
}

const total = Object.values(out).reduce((n, r) => n + r.length, 0);
console.log(
  `✓ leagues-2026.json: ${Object.entries(out)
    .map(([k, v]) => `${k} ${v.length}`)
    .join(', ')} (${total} clubs)`,
);
console.log(
  `✓ teams-meta.json: ${Object.keys(meta).length} clubs · fixtures re-keyed ${rekeyed}${unmappable ? ` (${unmappable} ids unmapped)` : ''}`,
);
if (misses.length)
  console.log('✗ unmatched fd.org teams:\n  ' + misses.join('\n  '));
