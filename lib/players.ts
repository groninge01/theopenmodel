// Player data: everything from football-data.org — current-season scorers,
// squads keyed by fd.org team id. Player ids are shared across both feeds, so
// joins are exact; fd.org's free tier carries no photos or shirt numbers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Scorer {
  playerId: number;
  name: string;
  age: number | null;
  position: string | null;
  nationality: string | null;
  team: string;
  /** football-data.org team id — the join key squads and club records share. */
  teamId: number | null;
  teamLogo: string | null;
  goals: number;
  assists: number;
  apps: number;
  penalties?: number | null;
}

export interface SquadPlayer {
  id: number;
  name: string;
  position: string;
  dob: string | null;
  nationality: string | null;
}

export interface KeyPlayer extends SquadPlayer {
  age: number | null;
  stats?: { goals: number; assists: number; apps: number };
}

let scorers: {
  updated?: string;
  season?: number;
  leagues: Record<string, Scorer[]>;
} | null = null;
let squads: {
  updated?: string;
  season?: number;
  teams: Record<string, SquadPlayer[]>;
} | null = null;

export function topScorers(leagueSlug: string): Scorer[] {
  if (!scorers)
    scorers = JSON.parse(
      readFileSync(join(process.cwd(), 'data', 'scorers-2026.json'), 'utf8'),
    );
  return scorers!.leagues[leagueSlug] ?? [];
}

export function squadOf(fdId: number | undefined): SquadPlayer[] {
  if (!fdId) return [];
  if (!squads)
    squads = JSON.parse(
      readFileSync(join(process.cwd(), 'data', 'squads-2026.json'), 'utf8'),
    );
  return squads!.teams?.[String(fdId)] ?? [];
}

export function playerAge(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() &&
      now.getUTCDate() < born.getUTCDate())
  )
    age--;
  return age;
}

// club fdId → fd player id → current-season output, for ranking the spine.
function scorerStats(fdId: number | undefined): Map<number, Scorer> {
  const map = new Map<number, Scorer>();
  if (!fdId) return map;
  if (!scorers) topScorers(''); // warm the cache
  for (const league of Object.values(scorers!.leagues)) {
    for (const s of league) {
      if (s.teamId === fdId) map.set(s.playerId, s);
    }
  }
  return map;
}

// A representative 6: lean attack-heavy — the faces people recognize, ranked by
// current-season goals+assists. Players without scorer output fall back to age
// (seniority). Goalkeepers can't rank on scoring and fd.org gives no shirt
// numbers, so the most established (lowest fd id) keeper stands in.
export function keyPlayers(fdId: number | undefined): KeyPlayer[] {
  const sq = squadOf(fdId);
  const stats = scorerStats(fdId);
  const by = (pos: string) => sq.filter((p) => p.position === pos);
  const ranked = (list: SquadPlayer[]) =>
    [...list].sort((a, b) => {
      const sa = stats.get(a.id);
      const sb = stats.get(b.id);
      if (sa && sb)
        return (
          sb.goals + sb.assists - (sa.goals + sa.assists) ||
          sb.goals - sa.goals ||
          sb.apps - sa.apps
        );
      if (sa) return -1;
      if (sb) return 1;
      return (playerAge(b.dob) ?? 0) - (playerAge(a.dob) ?? 0);
    });
  const gk = by('Goalkeeper').sort((a, b) => a.id - b.id)[0];
  const picked = [
    ...ranked(by('Attacker')).slice(0, 3),
    ...ranked(by('Midfielder')).slice(0, 2),
    ...(gk ? [gk] : []),
  ];
  return picked.map((p) => {
    const s = stats.get(p.id);
    return {
      ...p,
      age: playerAge(p.dob),
      ...(s
        ? { stats: { goals: s.goals, assists: s.assists, apps: s.apps } }
        : {}),
    };
  });
}
