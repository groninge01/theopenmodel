import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRanking,
  rankingToCsv,
  mergeMissing,
  canonClub,
} from './clubelo-ranking.mjs';

const SAMPLE = `
<table><tr><th>Rank</th><th>Club</th><th>Elo</th></tr>
<tr><td class="l"><i> Level 1 (20 teams)</i></td><td><i>⌀1839</i></td></tr>
<tr><td class="l"><a href="/ENG"><img alt="ENG" src="f.png"/></a>
  <span class="min481"><small> 2 </small></span>
  <a href="/Arsenal"><span class="NonAst">ARS</span><span class="Ast">Arsenal</span></a></td>
  <td class="r">2040</td></tr>
<tr><td class="l"><a href="/ENG"><img alt="ENG" src="f.png"/></a>
  <a href="/ManCity"><span class="NonAst">MCI</span><span class="Ast">Man City</span></a></td>
  <td class="r">2028</td></tr>
<tr><td class="l"><i> Level 2 (24 teams)</i></td><td><i>⌀1700</i></td></tr>
<tr><td class="l"><a href="/ENG"><img alt="ENG" src="f.png"/></a>
  <a href="/Coventry"><span class="NonAst">COV</span><span class="Ast">Coventry</span></a></td>
  <td class="r">1750</td></tr>
<tr><td class="l"><i> Level 1 (18 teams)</i></td><td><i>⌀1880</i></td></tr>
<tr><td class="l"><a href="/GER"><img alt="GER" src="f.png"/></a>
  <a href="/Koeln"><span class="NonAst">KOE</span><span class="Ast">K&#246;ln</span></a></td>
  <td class="r">1790</td></tr>
<tr><td class="l"><a href="/GER"><img alt="GER" src="f.png"/></a>
  <a href="/Bayern"><span class="NonAst">BMU</span><span class="Ast">Bayern M&#252;nchen</span></a></td>
  <td class="r">2046</td></tr>
<tr><td>no club data here</td></tr>
</table>`;

test('parseRanking extracts country, club, elo and tracks level headers', () => {
  const clubs = parseRanking(SAMPLE);
  assert.equal(clubs.length, 5);
  assert.deepEqual(clubs[0], {
    country: 'ENG',
    club: 'Arsenal',
    elo: 2040,
    level: 1,
  });
  assert.deepEqual(clubs[2], {
    country: 'ENG',
    club: 'Coventry',
    elo: 1750,
    level: 2,
  });
});

test('parseRanking decodes html entities in club names', () => {
  const names = parseRanking(SAMPLE).map((c) => c.club);
  assert.ok(names.includes('Köln'));
  assert.ok(names.includes('Bayern München'));
});

test('rankingToCsv emits the api csv schema sorted by elo desc', () => {
  const csv = rankingToCsv(parseRanking(SAMPLE), '2026-10-02');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'Rank,Club,Country,Level,Elo,From,To');
  assert.equal(lines[1], '1,Bayern München,GER,1,2046,2026-10-02,2026-10-02');
  assert.equal(lines[2], '2,Arsenal,ENG,1,2040,2026-10-02,2026-10-02');
  assert.equal(lines.length, 6);
});

test('canonClub normalizes abbreviations for identity matching', () => {
  assert.equal(canonClub('Bayern München'), canonClub('Bayern'));
  assert.equal(canonClub('1. FC Köln'), canonClub('Koeln'));
  assert.equal(canonClub('Paris SG'), 'parissg');
});

test('mergeMissing adds lapsed clubs without duplicating renamed ones', () => {
  const scraped = [
    {
      country: 'GER',
      club: 'Bayern München',
      elo: 2046,
      level: 1,
      from: '2026-10-02',
      to: '2026-10-02',
    },
  ];
  const previous = [
    '2,Bayern,GER,1,2040.5,2026-08-31,2026-12-31',
    '50,Offenbacher Kickers,GER,3,1500.1,2026-08-31,2026-12-31',
  ];
  const merged = mergeMissing(scraped, previous);
  assert.equal(merged.length, 2);
  const names = merged.map((r) => r.club);
  assert.ok(names.includes('Bayern München'));
  assert.ok(names.includes('Offenbacher Kickers'));
  assert.ok(!names.includes('Bayern')); // same club under the old csv name — not duplicated
});
