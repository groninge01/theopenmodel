import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LEAGUES, leagueBySlug, leagueClubs, flagUrl } from '@/lib/data';
import { seasonOdds } from '@/lib/season';
import { portalSnapshot, portalStandings } from '@/lib/portal';
import { LeagueTabs } from '../../../components/LeagueTabs';
import { LeagueSubnav } from '../../../components/LeagueSubnav';
import { Crest } from '../../../components/Crest';

export function generateStaticParams() {
  return LEAGUES.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const league = leagueBySlug(slug);
  if (!league) return {};
  return {
    title: `${league.name} table 2026-27 — live standings`,
    description: `${league.name} 2026-27 live table: position, points, goal difference and recent form for every club, refreshed daily from football-data.org — with the model's projected finish alongside.`,
  };
}

// Standing-table leagueId is the legacy API-Football league id the portal
// envelope carries (see scripts/providers/football-data.mjs COMPETITIONS).
const LEAGUE_ID: Record<string, number> = {
  'premier-league': 39,
  'la-liga': 140,
  'serie-a': 135,
  bundesliga: 78,
  'ligue-1': 61,
};

const detail = (
  row: {
    details: {
      description: string | null;
      value: string | number | boolean | null;
    }[];
  },
  label: string,
) => row.details.find((d) => d.description === label)?.value ?? null;

export default async function LeagueTablePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const league = leagueBySlug(slug);
  if (!league) notFound();
  const clubs = leagueClubs(league);
  const byFdId = new Map(clubs.map((c) => [c.fdId, c]));

  const table = portalStandings().find((t) => t.leagueId === LEAGUE_ID[slug]);
  const asOf = portalSnapshot().asOf.slice(0, 10);

  // Model projection for the context column: rank by projected points, keyed
  // on fdId to match the standings rows.
  const odds = seasonOdds(league.slug, clubs);
  const fdBySlug = new Map(clubs.map((c) => [c.slug, c.fdId]));
  const projPos = new Map(odds.map((o, i) => [fdBySlug.get(o.slug), i + 1]));

  const n = table?.rows.length ?? 0;
  const zone = (i: number): { cls: string; label: string } | null => {
    if (i < 4) return { cls: 'cl', label: 'Champions League places' };
    if (i < 6) return { cls: 'el', label: 'European places' };
    if (i >= n - 3) return { cls: 'rel', label: 'Relegation zone' };
    return null;
  };

  return (
    <main className="wrap">
      <section>
        <p className="crumbs">
          <Link href="/">Home</Link> › <Link href="/leagues/">Leagues</Link>›{' '}
          <Link href={`/league/${league.slug}/`}>{league.name}</Link> › Table
        </p>
        <h1
          className="pagetitle"
          style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="flag"
            src={flagUrl(league.flagCode, 40)}
            width={28}
            height={21}
            alt=""
          />
          {league.name} table 2026-27
        </h1>
        <p className="pagedesc">
          The live {league.name} standings — actual points, goal difference and
          recent form — alongside where the model expects each club to finish.
          For the full projection see the{' '}
          <Link href={`/league/${league.slug}/`}>forecast</Link>.
        </p>
        <p className="updated" style={{ margin: '6px 0 14px' }}>
          Live standings · football-data.org · updated {asOf}
        </p>
        <LeagueTabs current={league.slug} />
        <LeagueSubnav slug={league.slug} current="table" />
      </section>

      {!table || !table.rows.length ? (
        <p className="pagedesc" style={{ marginTop: 20 }}>
          Live standings for this league aren&apos;t available yet — they appear
          once the first matchday is recorded.
        </p>
      ) : (
        <>
          <div style={{ marginTop: 18, overflowX: 'auto' }}>
            <table className="data leaguetable">
              <thead>
                <tr>
                  <th style={{ width: 34 }} className="c">
                    #
                  </th>
                  <th>Club</th>
                  <th className="c" title="Matches played">
                    P
                  </th>
                  <th className="c hide-m" title="Won">
                    W
                  </th>
                  <th className="c hide-m" title="Drawn">
                    D
                  </th>
                  <th className="c hide-m" title="Lost">
                    L
                  </th>
                  <th className="c hide-m" title="Goals for / against">
                    GF:GA
                  </th>
                  <th className="c" title="Goal difference">
                    GD
                  </th>
                  <th className="c" title="Points">
                    Pts
                  </th>
                  <th className="c hide-m" title="Last five results">
                    Form
                  </th>
                  <th
                    className="c hide-m"
                    title="Model's projected final position"
                  >
                    Proj.
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => {
                  const z = zone(i);
                  const club = byFdId.get(r.participantId ?? undefined);
                  const form = r.form
                    .map((f) => f.form)
                    .filter(Boolean)
                    .slice(-5) as string[];
                  return (
                    <tr
                      key={r.participantId ?? i}
                      className={z ? `zone-${z.cls}` : undefined}
                    >
                      <td className="c num" style={{ position: 'relative' }}>
                        {z && (
                          <span
                            className="zone-bar"
                            title={z.label}
                            aria-label={z.label}
                          />
                        )}
                        {r.position ?? i + 1}
                      </td>
                      <td>
                        {club ? (
                          <Link
                            href={`/team/${club.slug}/`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 9,
                            }}
                          >
                            <Crest
                              club={club.club}
                              slug={club.slug}
                              size="sm"
                            />
                            {club.club}
                          </Link>
                        ) : (
                          r.participant.name
                        )}
                      </td>
                      <td className="c num">{detail(r, 'Played')}</td>
                      <td className="c num hide-m">{detail(r, 'Won')}</td>
                      <td className="c num hide-m">{detail(r, 'Drawn')}</td>
                      <td className="c num hide-m">{detail(r, 'Lost')}</td>
                      <td
                        className="c num hide-m"
                        style={{ color: 'var(--muted)' }}
                      >
                        {detail(r, 'Goals for')}:{detail(r, 'Goals against')}
                      </td>
                      <td className="c num">{detail(r, 'Goal difference')}</td>
                      <td className="c num">
                        <b>{r.points}</b>
                      </td>
                      <td className="c num hide-m">
                        <span style={{ display: 'inline-flex', gap: 3 }}>
                          {form.map((f, j) => (
                            <span
                              key={j}
                              className="mono"
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color:
                                  f === 'W'
                                    ? 'var(--win)'
                                    : f === 'L'
                                      ? 'var(--loss)'
                                      : 'var(--muted)',
                              }}
                            >
                              {f}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td
                        className="c num hide-m"
                        style={{ color: 'var(--muted)' }}
                      >
                        {projPos.get(r.participantId ?? 0) ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="tablekey" style={{ marginTop: 14 }}>
            <span className="k">
              <span className="sw cl" /> Champions League (top 4)
            </span>
            <span className="k">
              <span className="sw el" /> European places (5–6)
            </span>
            <span className="k">
              <span className="sw rel" /> Relegation (bottom 3)
            </span>
          </div>
          <p className="foot-src" style={{ marginTop: 10 }}>
            Standings: football-data.org, refreshed daily. Proj. = the
            model&apos;s projected final position from 5,000 simulated seasons (
            <Link href="/methodology/">method</Link>). Data reusable under{' '}
            <Link href="/data/">CC BY 4.0</Link>.
          </p>
        </>
      )}
    </main>
  );
}
