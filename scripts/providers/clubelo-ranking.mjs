// Scrape fallback for api.clubelo.com: the /Ranking page is server-rendered and
// carries the same full rating table the CSV API serves. Used when the API
// subdomain is down (it 502s while the site itself stays up). Emits rows in the
// exact Rank,Club,Country,Level,Elo,From,To schema of clubelo-latest.csv so
// build-teams-meta.mjs consumes it unchanged.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  uuml: "ü", ouml: "ö", auml: "ä", Uuml: "Ü", Ouml: "Ö", Auml: "Ä",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", szlig: "ß", ntilde: "ñ",
};

const decodeEntities = (s) =>
  s.replace(/&#(\d+);|&([a-zA-Z]+);/g, (_, dec, named) =>
    dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[named] ?? `&${named};`));

// Canonical club identity for dedup: same spirit as build-teams-meta's canon(),
// then with separators removed so "Man City" === "ManCity".
export const canonClub = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/\b(fc|cf|afc|ac|as|ss|ssc|sc|us|ogc|rc|rcd|cd|ud|sv|vfb|vfl|fsv|1899|07|04|05|1)\b/g, "")
    .replace(/manchester/g, "man").replace(/saint/g, "st")
    .replace(/munchen|munich/g, "").replace(/koln|cologne/g, "koeln")
    .replace(/-/g, "");

const ROW = /alt="([A-Z]{3})"[\s\S]*?class="Ast">([\s\S]*?)<\/span>[\s\S]*?class="r">(\d+)/;
const LEVEL = /Level (\d) \(\d+ teams\)/;

// Rows appear grouped federation → level; a "<i> Level N (x teams)</i>" header
// row carries the level for every club row that follows it.
export function parseRanking(html) {
  const clubs = [];
  let level = null;
  for (const tr of html.split("<tr")) {
    const lv = tr.match(LEVEL);
    if (lv) level = Number(lv[1]);
    const row = tr.match(ROW);
    if (row) {
      clubs.push({
        country: row[1],
        club: decodeEntities(row[2].trim()),
        elo: Number(row[3]),
        level,
      });
    }
  }
  return clubs;
}

// The API's Rank column is a global ordering; the page is grouped by country,
// so rank is re-derived by sorting on Elo.
export function rankingToCsv(clubs, date) {
  const sorted = [...clubs].sort((a, b) => b.elo - a.elo);
  return [
    "Rank,Club,Country,Level,Elo,From,To",
    ...sorted.map((c, i) => `${i + 1},${c.club},${c.country},${c.level},${c.elo},${date},${date}`),
  ].join("\n") + "\n";
}

// ClubElo drops clubs whose rating period has lapsed; when scraping, the prior
// generated csv is the only place they survive. Adds previous rows whose club
// is absent from the scrape — matching on canonClub so a renamed row (CSV's
// "Bayern" vs site's "Bayern München") isn't duplicated.
export function mergeMissing(scraped, previousLines) {
  const have = scraped.map((c) => canonClub(c.club));
  const taken = (name) => {
    const n = canonClub(name);
    return have.some((h) => h === n || h.includes(n) || n.includes(h));
  };
  const merged = [...scraped];
  for (const line of previousLines) {
    const cols = line.split(",");
    if (cols.length < 6 || taken(cols[1])) continue;
    merged.push({
      country: cols[2], club: cols[1], elo: Number(cols[4]),
      level: Number(cols[3]) || null, from: cols[5], to: cols[6] ?? cols[5],
    });
  }
  return merged;
}

// Same csv as rankingToCsv but honours a kept row's own From/To.
export function rowsToCsv(rows) {
  const sorted = [...rows].sort((a, b) => b.elo - a.elo);
  return [
    "Rank,Club,Country,Level,Elo,From,To",
    ...sorted.map((c, i) =>
      `${i + 1},${c.club},${c.country},${c.level ?? ""},${c.elo},${c.from},${c.to}`),
  ].join("\n") + "\n";
}
