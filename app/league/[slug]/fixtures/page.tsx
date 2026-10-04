import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LEAGUES, leagueBySlug, flagUrl } from '@/lib/data';
import { allFixtures } from '@/lib/fixtures';
import { matchProb } from '@/lib/model';
import { pct } from '@/lib/ui';
import { Crest } from '../../../components/Crest';
import { LeagueTabs } from '../../../components/LeagueTabs';
import { LeagueSubnav } from '../../../components/LeagueSubnav';
import { ScrollToId } from '../../../components/ScrollToId';
import { ToTop } from '../../../components/ToTop';

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
    title: `${league.name} fixtures 2026-27 — full schedule with predictions`,
    description: `Every ${league.name} 2026-27 fixture by matchday, each with the model's home-win, draw and away-win probability. Kick-off times and result forecasts in one schedule.`,
  };
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
// Server-rendered kickoff time (UTC) — keeps this 380-row page free of per-row client
// components; the individual match pages localise the time for the visitor.
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

export default async function LeagueFixturesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const league = leagueBySlug(slug);
  if (!league) notFound();

  const fixtures = allFixtures()
    .filter((f) => f.league.slug === league.slug)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Group by round (matchday). Round strings look like "Regular Season - 1".
  const byRound = new Map<string, typeof fixtures>();
  for (const f of fixtures) {
    const key = f.round || 'Fixtures';
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key)!.push(f);
  }
  const roundNum = (r: string) => {
    const m = r.match(/(\d+)/);
    return m ? +m[1] : 0;
  };
  const rounds = [...byRound.keys()].sort((a, b) => roundNum(a) - roundNum(b));

  // First not-yet-played round, so the page opens near "now".
  const now = Date.now();
  const nextRound =
    rounds.find((r) =>
      byRound.get(r)!.some((f) => new Date(f.date).getTime() > now),
    ) ?? rounds[0];
  const roundId = (r: string) => (roundNum(r) ? `md-${roundNum(r)}` : 'md');

  return (
    <main className="wrap">
      <section>
        <p className="crumbs">
          <Link href="/">Home</Link> › <Link href="/leagues/">Leagues</Link> ›{' '}
          <Link href={`/league/${league.slug}/`}>{league.name}</Link> › Fixtures
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
          {league.name} fixtures 2026-27
        </h1>
        <p className="pagedesc">
          The full {league.name} schedule by matchday, every fixture carrying
          the model&apos;s home-win, draw and away-win estimate.{' '}
          {fixtures.length} matches in total.
        </p>
        <LeagueTabs current={league.slug} />
        <LeagueSubnav slug={league.slug} current="fixtures" />
      </section>

      <nav
        className="round-jump"
        aria-label="Jump to matchday"
        style={{ marginTop: 16 }}
      >
        {rounds.map((r) => (
          <a
            key={r}
            href={`#${roundId(r)}`}
            className={r === nextRound ? 'on' : undefined}
          >
            {roundNum(r) || '•'}
          </a>
        ))}
      </nav>

      {rounds.map((r) => (
        <section
          key={r}
          id={roundId(r)}
          style={{ marginTop: 26, scrollMarginTop: 72 }}
        >
          <div className="lg-head">
            <h2>Matchday {roundNum(r) || ''}</h2>
            <span className="updated">{byRound.get(r)!.length} matches</span>
          </div>
          <div className="fixture-rows" style={{ marginTop: 12 }}>
            {byRound.get(r)!.map((f) => {
              const p = matchProb(f.home.elo, f.away.elo);
              const outcome = f.score
                ? f.score.home > f.score.away
                  ? 'home'
                  : f.score.home === f.score.away
                    ? 'draw'
                    : 'away'
                : null;
              const fav =
                p.home >= p.draw && p.home >= p.away
                  ? 'home'
                  : p.draw >= p.away
                    ? 'draw'
                    : 'away';
              const win = { color: 'var(--win)', fontWeight: 700 };
              const drw = { color: 'var(--ink)', fontWeight: 700 };
              const cell = (base: object | undefined, isOutcome: boolean) => ({
                ...base,
                ...(outcome ? { paddingBlock: 4 } : {}),
                ...(isOutcome
                  ? {
                      boxShadow: 'inset 0 0 0 1px currentColor',
                      borderRadius: 4,
                      marginInline: -3,
                    }
                  : {}),
              });
              return (
                <Link
                  key={f.id}
                  href={`/match/${f.slug}/`}
                  className="fixture-row"
                >
                  <span className="fx-date mono">
                    {dayLabel(f.date)}
                    <br />
                    {timeLabel(f.date)}
                  </span>
                  <span className="fx-team fx-home">
                    <b>{f.home.club}</b>
                    <Crest club={f.home.club} slug={f.home.slug} size="sm" />
                  </span>
                  {f.score ? (
                    <span className="fx-score mono">
                      {f.score.home}–{f.score.away}
                    </span>
                  ) : (
                    <span className="fx-vs mono">v</span>
                  )}
                  <span className="fx-team fx-away">
                    <Crest club={f.away.club} slug={f.away.slug} size="sm" />
                    <b>{f.away.club}</b>
                  </span>
                  <span
                    className="fx-odds mono"
                    aria-label="Model probabilities"
                  >
                    <span
                      className="fx-p"
                      style={cell(
                        fav === 'home' ? win : undefined,
                        outcome === 'home',
                      )}
                    >
                      {pct(p.home, 0)}
                    </span>
                    <span
                      className="fx-p"
                      style={cell(
                        fav === 'draw' ? drw : { color: 'var(--muted)' },
                        outcome === 'draw',
                      )}
                    >
                      {pct(p.draw, 0)}
                    </span>
                    <span
                      className="fx-p"
                      style={cell(
                        fav === 'away' ? win : undefined,
                        outcome === 'away',
                      )}
                    >
                      {pct(p.away, 0)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      <p className="foot-src" style={{ marginTop: 20 }}>
        Kick-off times shown in UTC (each match page shows your local time);
        result probabilities from the model. Data reusable under{' '}
        <Link href="/data/">CC BY 4.0</Link>.
      </p>

      {/* Open at the upcoming round rather than matchday 1 — the nav only
          highlights it. Skipped when the URL already points at a round. */}
      <ScrollToId id={roundId(nextRound)} />
      <ToTop />
    </main>
  );
}
