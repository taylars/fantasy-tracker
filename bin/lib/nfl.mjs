/* The two free sources behind the lineup bundle, and nothing else.
 *
 * Node only. The page never reaches either of these — that is the whole point
 * of the bundle: one static file a browser downloads instead of nine weeks of
 * stats and a schedule it would have to join itself.
 *
 *   Sleeper, api.sleeper.app/stats/nfl/<season>/<week>
 *     One request per week, about three quarters of a megabyte, and it
 *     carries everything the model needs: the player, the position, the team
 *     he played for *that week*, who he played, and a stat line with snaps,
 *     targets, red-zone looks and the team's own snap count on it. This is a
 *     different endpoint from the `/v1/stats/...` one in the docs, which
 *     answers with a bare map keyed by player id and no team on it — the
 *     team per week is the field that makes a traded player and a defensive
 *     matchup both work, so it is worth the undocumented url.
 *
 *   nflverse, raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
 *     The schedule with spreads and totals, including for games that have not
 *     been played. Sleeper publishes neither, and the implied team total is
 *     the single most useful input on the page. Two megabytes covering every
 *     season since 1999, which is why it is cached rather than trimmed.
 *
 * Both are public and need no key. Everything is cached under data/cache, so
 * rebuilding a bundle twice in an evening costs one set of requests.
 */

import { FileCache } from "../../js/cache-fs.js";
import { PROJECTED } from "../../js/project.js";

const SLEEPER_STATS = "https://api.sleeper.app/stats/nfl";
const SLEEPER_PROJECTIONS = "https://api.sleeper.app/projections/nfl";
const NFLVERSE_GAMES = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

// A finished week never changes, so it is cached for a week; the schedule's
// lines move daily, so it is cached for six hours.
const WEEK_TTL = 7 * 24 * 60 * 60 * 1000;
const LIVE_TTL = 6 * 60 * 60 * 1000;
const SCHEDULE_TTL = 6 * 60 * 60 * 1000;

/* nflverse calls the Rams LA and Sleeper calls them LAR. That is the only
 * disagreement between the two across all 32 teams, which is worth knowing
 * before writing a general mapping table that would hide the next one.
 */
const TEAM_ALIAS = { LA: "LAR" };

export const team = (code) => (code ? TEAM_ALIAS[code] ?? code : null);

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.text();
}

/* A CSV reader that respects quotes, because a stadium name has a comma in it
 * often enough to matter and a split on commas would silently shift every
 * column after it.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((key, i) => [key, r[i]])));
}

const number = (value) => {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/* One season's schedule: who plays whom, what the line is, and the score if
 * it has been played.
 *
 * `spread` is nflverse's own convention — positive means the home team is
 * favoured by that many — and it is left that way rather than flipped,
 * because the one place it is read (js/project.js) splits it between the two
 * teams and is clearer for having the raw number.
 */
export async function schedule(season, { cache = new FileCache() } = {}) {
  const key = `nflverse:games`;
  let text = await cache.get(key);
  if (text === undefined) {
    text = await getText(NFLVERSE_GAMES);
    await cache.set(key, text, SCHEDULE_TTL);
  }

  return parseCsv(text)
    .filter((row) => row.season === String(season) && row.game_type === "REG")
    .map((row) => ({
      season: String(season),
      week: Number(row.week),
      home: team(row.home_team),
      away: team(row.away_team),
      homeScore: number(row.home_score),
      awayScore: number(row.away_score),
      spread: number(row.spread_line),
      total: number(row.total_line),
      kickoff: row.gameday ? `${row.gameday}${row.gametime ? `T${row.gametime}` : ""}` : null,
    }))
    .filter((game) => game.home && game.away && Number.isFinite(game.week));
}

/* One week of player stats, flattened to the shape js/project.js reads.
 *
 * `played` decides the cache: a week whose games are over is frozen for a
 * week, a week in progress for six hours. The caller says which, because only
 * it knows what week the season is on.
 */
export async function weekStats(season, week, { cache = new FileCache(), played = true } = {}) {
  const url = new URL(`${SLEEPER_STATS}/${season}/${week}`);
  url.searchParams.set("season_type", "regular");
  url.searchParams.set("order_by", "pts_half_ppr");
  for (const position of PROJECTED) url.searchParams.append("position[]", position);
  // FB is projected as RB, so it has to be asked for.
  url.searchParams.append("position[]", "FB");

  const key = `sleeper-week:${season}:${week}`;
  let rows = await cache.get(key);
  if (rows === undefined) {
    rows = await getJson(url.toString());
    await cache.set(key, rows, played ? WEEK_TTL : LIVE_TTL);
  }

  return {
    week: Number(week),
    rows: (rows ?? [])
      .filter((row) => row.player_id && row.player && row.stats)
      .map((row) => ({
        player_id: String(row.player_id),
        name: `${row.player?.first_name ?? ""} ${row.player?.last_name ?? ""}`.trim()
          || row.player?.last_name || String(row.player_id),
        position: row.player?.position ?? null,
        team: team(row.team),
        opponent: team(row.opponent),
        home: row.is_away_team === false ? true : row.is_away_team === true ? false : null,
        injury_status: row.player?.injury_status ?? null,
        stats: row.stats,
      })),
  };
}

/* Sleeper's own projection for one week, as the benchmark the backtest scores
 * against. Not an input to anything — the model never reads a provider's
 * projection — but "is this better than what Sleeper already shows you" is
 * the only question that makes the error figures mean anything.
 */
export async function weekProjections(season, week, { cache = new FileCache() } = {}) {
  const url = new URL(`${SLEEPER_PROJECTIONS}/${season}/${week}`);
  url.searchParams.set("season_type", "regular");
  url.searchParams.set("order_by", "pts_half_ppr");
  for (const position of PROJECTED) url.searchParams.append("position[]", position);

  const key = `sleeper-week-proj:${season}:${week}`;
  let rows = await cache.get(key);
  if (rows === undefined) {
    rows = await getJson(url.toString());
    await cache.set(key, rows, WEEK_TTL);
  }
  const out = new Map();
  for (const row of rows ?? []) {
    if (row.player_id && row.stats) out.set(String(row.player_id), row.stats);
  }
  return out;
}

/* The week a lineup is being set for: the earliest one most of which is still
 * to be played.
 *
 * Decided from the schedule's own scores rather than from `state.week`, which
 * flips over on Tuesday while Monday night is still being counted into the
 * week before. "Most of" rather than "any of" is the part that matters: by
 * Monday afternoon fourteen of a week's fifteen games are final, and a page
 * still offering to set that week's lineup is a page a day behind the person
 * reading it. A Thursday night game being over, on the other hand, does not
 * make the week behind you — one game of fourteen is nowhere near half.
 */
export function nextWeek(games) {
  const weeks = new Map();
  for (const game of games) {
    if (!weeks.has(game.week)) weeks.set(game.week, { total: 0, final: 0 });
    const week = weeks.get(game.week);
    week.total += 1;
    if (Number.isFinite(game.homeScore) && Number.isFinite(game.awayScore)) week.final += 1;
  }
  const open = [...weeks.entries()]
    .filter(([, { total, final }]) => final * 2 < total)
    .map(([week]) => week);
  return open.length ? Math.min(...open) : null;
}

/* Every week before `week` that Sleeper has stats for, oldest first.
 *
 * A week with nobody in it is skipped rather than ending the loop: the bye
 * structure means no week is empty, but a season being backfilled might be,
 * and a gap is not a reason to throw away the weeks after it.
 */
export async function weeksBefore(season, week, { cache = new FileCache(), onWeek = null } = {}) {
  const weeks = [];
  for (let w = 1; w < week; w++) {
    const fetched = await weekStats(season, w, { cache });
    const played = fetched.rows.filter((row) => (row.stats?.gp ?? 0) > 0).length;
    onWeek?.({ week: w, players: fetched.rows.length, played });
    if (played) weeks.push(fetched);
  }
  return weeks;
}
