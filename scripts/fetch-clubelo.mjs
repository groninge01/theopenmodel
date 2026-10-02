#!/usr/bin/env node
// Refresh data/clubelo-latest.csv from api.clubelo.com (free, daily).
// ClubElo drops clubs whose rating period has lapsed (off-season gap between
// "To" and the next period) — so we merge in a fallback snapshot from a few
// weeks back to backfill anyone missing (e.g. Bayern vanished 2026-07-04).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeMissing, parseRanking, rowsToCsv } from "./providers/clubelo-ranking.mjs";

// ClubElo is a free single-maintainer service and goes unresponsive for stretches — it
// answered fine this morning and timed out entirely this afternoon. Without retries a
// single bad minute leaves the ratings unrefreshed for a day, which is how they silently
// fell a month behind in the first place.
async function snapshot(date, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(`http://api.clubelo.com/${date}`, {
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`clubelo ${date} → ${res.status}`);
      const csv = await res.text();
      if (!csv.startsWith("Rank,Club")) throw new Error(`unexpected payload for ${date}`);
      return csv.trim().split("\n");
    } catch (e) {
      lastError = e;
      console.warn(`  clubelo ${date}: attempt ${i + 1}/${attempts} failed (${e.message})`);
    }
  }
  throw lastError;
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const fallbackDate = new Date(today.getTime() - 21 * 86400_000);

const CSV_PATH = new URL("../data/clubelo-latest.csv", import.meta.url);
let current;
try {
  const [now, older] = await Promise.all([snapshot(iso(today)), snapshot(iso(fallbackDate))]);
  const have = new Set(now.slice(1).map((l) => l.split(",")[1]));
  const added = [];
  for (const line of older.slice(1)) {
    const club = line.split(",")[1];
    if (!have.has(club)) { now.push(line); added.push(club); }
  }
  current = now;
  if (added.length) {
    console.log(`  backfilled ${added.length} lapsed clubs from ${iso(fallbackDate)}: ` +
      `${added.slice(0, 8).join(", ")}${added.length > 8 ? "…" : ""}`);
  }
} catch (e) {
  // api.clubelo.com is a single-maintainer free service that 502s for stretches while
  // clubelo.com itself stays up. The /Ranking page is server-rendered and carries the
  // same table — scraped here at integer precision (sub-1 Elo noise is well below what
  // moves a probability) and written in the same csv schema downstream tools expect.
  console.warn(`  clubelo api unavailable (${e.message}) — scraping clubelo.com/Ranking`);
  const res = await fetch("https://clubelo.com/Ranking", { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`clubelo.com/Ranking → ${res.status}`);
  const clubs = parseRanking(await res.text());
  if (clubs.length < 500) throw new Error(`ranking scrape returned only ${clubs.length} clubs`);
  const date = iso(today);
  let rows = clubs.map((c) => ({ ...c, from: date, to: date }));
  if (existsSync(CSV_PATH)) {
    const previous = readFileSync(CSV_PATH, "utf8").trim().split("\n").slice(1);
    const merged = mergeMissing(rows, previous);
    if (merged.length > rows.length) {
      console.log(`  kept ${merged.length - rows.length} lapsed clubs from the previous snapshot`);
    }
    rows = merged;
  }
  current = rowsToCsv(rows).trim().split("\n");
}

writeFileSync(CSV_PATH, current.join("\n") + "\n");
console.log(`✓ clubelo snapshot ${iso(today)}: ${current.length - 1} clubs`);
