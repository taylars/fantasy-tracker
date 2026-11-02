/* How much of a team's record is the schedule rather than the team.
 *
 * A fantasy week is two numbers: what you scored, and what the one person you
 * were drawn against scored. The first is yours. The second is a coin somebody
 * else flipped, and over seven weeks it can be worth two or three games in the
 * standings. This module separates the two.
 *
 * Two things are measured, because "lucky" means both of them and they do come
 * apart:
 *
 *   Record luck — your actual wins against the wins you'd have if you played
 *   the whole league every week (the all-play record). Scoring 140 and losing
 *   is the week this catches.
 *
 *   Schedule luck — what the opponents you were handed scored, against what
 *   the league scored that week. Facing the one manager who went off is the
 *   week this catches, and it is the mechanism behind most record luck.
 *
 * They are standardised within the league and averaged into one score from
 * -100 to +100, because luck is zero-sum: somebody's soft schedule is somebody
 * else's hard one, so the only honest frame of reference is the other eleven
 * teams. 0 is exactly average, above it means the season has gone your way,
 * and the scale is two standard deviations wide in each direction — so -100
 * and +100 are real extremes rather than wherever the worst-off team happens
 * to land.
 *
 * Nothing here fetches or draws. It takes what Sleeper already sent and
 * returns rows, so the arithmetic can be tested without a browser or a season.
 */

// Where the score lands on the -100 to +100 scale: 0 is the league average,
// and a team two standard deviations clear of it hits the end. Luck in a
// 12-team league rarely gets past 1.8σ, so the ends stay unclaimed in a normal
// season, which is the point of a fixed scale rather than one stretched to the
// field.
const SPREAD = 50; // points of score per standard deviation

const round2 = (n) => Math.round(n * 100) / 100;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/* Standardise, and treat a league with no spread as all-average rather than
 * dividing by zero. A season where everyone's luck is identical has no luckier
 * half, and 0 across the board says exactly that.
 */
function zScores(values) {
  const m = mean(values);
  const s = stdev(values);
  return values.map((v) => (s > 0 ? (v - m) / s : 0));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* The weeks that are actually over.
 *
 * Two rules, and the first one is the one that matters. `completedThrough` is
 * the last week the NFL has finished — state.week - 1, since Sleeper's
 * state.week is the week being played. Nothing past it counts.
 *
 * It would be tempting to decide this from the scores alone, and that is a
 * trap worth naming: Sleeper serves a row for every week from the day the
 * league is created, at 0.0 points, so "every team has a score" looks like a
 * finished week. It isn't. An hour into Sunday afternoon every roster has
 * somebody on the field and every score is above zero, and a week read then is
 * a snapshot of the 1pm games — half a result, scored as a whole one. Reading
 * it that way put a 6-2 next to a league whose own standings said 5-2.
 *
 * The scores are still checked, as the second rule: it catches a week inside
 * the finished range that was never played at all — a cancelled week, or a
 * league that joined the season late.
 *
 * Playoff weeks are left out whatever their state. Only some teams play, the
 * rest are in a consolation bracket, and an all-play record across a week like
 * that is comparing a seed to a bye.
 */
export function playedWeeks(matchups, { playoffWeekStart = 15, completedThrough = Infinity } = {}) {
  const weeks = [];
  for (const [week, rows] of Object.entries(matchups)) {
    const n = Number(week);
    if (!Number.isFinite(n) || n < 1 || n >= playoffWeekStart) continue;
    if (n > completedThrough) continue;
    if (!rows?.length) continue;
    if (!rows.every((r) => Number(r.points) > 0)) continue;
    weeks.push({ week: n, rows });
  }
  return weeks.sort((a, b) => a.week - b.week);
}

/* What one team's week was: their score, their opponent's, and the league's.
 *
 * `matchup_id` is how Sleeper pairs two rows. A row without one is a team with
 * no fixture that week, which has no opponent to be unlucky against.
 */
function weekFacts(rows) {
  const byMatchup = new Map();
  for (const r of rows) {
    if (r.matchup_id == null) continue;
    const list = byMatchup.get(r.matchup_id) || [];
    list.push(r);
    byMatchup.set(r.matchup_id, list);
  }

  const scores = rows.map((r) => Number(r.points));
  const leagueAvg = mean(scores);
  const facts = new Map();

  for (const [, pair] of byMatchup) {
    for (const row of pair) {
      const foe = pair.find((p) => p !== row);
      if (!foe) continue; // an odd fixture; nobody to measure against
      const mine = Number(row.points);
      const theirs = Number(foe.points);

      // All-play: this score against every other score in the league that
      // week, which is the week's result with the draw taken out of it.
      const others = rows.filter((r) => r.roster_id !== row.roster_id).map((r) => Number(r.points));
      const beaten = others.filter((o) => mine > o).length;
      const level = others.filter((o) => mine === o).length;

      facts.set(row.roster_id, {
        points: mine,
        oppRosterId: foe.roster_id,
        oppPoints: theirs,
        leagueAvg,
        // 1 for a win, 0.5 for a tie — the same currency as the real record,
        // so the two are subtractable.
        result: mine > theirs ? 1 : mine === theirs ? 0.5 : 0,
        allPlay: others.length ? (beaten + level / 2) / others.length : 0,
      });
    }
  }

  return facts;
}

/* Rank by a key, highest first, with points scored breaking ties — which is
 * how Sleeper settles a tied record, so the current place this returns is the
 * place the league is actually showing.
 */
function placeBy(rows, key) {
  const order = [...rows].sort((a, b) => (b[key] - a[key]) || (b.pointsFor - a.pointsFor));
  const places = new Map();
  order.forEach((r, i) => places.set(r.rosterId, i + 1));
  return places;
}

/* One row per team, placed, with the luck score and everything it was built
 * from. Ordered by current place, which is the order the table wants.
 *
 * `rosters`, `users` and `matchups` are Sleeper's own shapes: the roster list,
 * the league's managers, and {week: rows} for as many weeks as were fetched.
 * `completedThrough` is the last week the NFL has finished — see playedWeeks,
 * which will happily read a Sunday afternoon as a season without it.
 */
export function luckTable({ matchups, rosters = [], users = [], league = null,
                            completedThrough = Infinity } = {}) {
  const weeks = playedWeeks(matchups, {
    playoffWeekStart: league?.settings?.playoff_week_start ?? 15,
    completedThrough,
  });

  const userById = new Map(users.map((u) => [u.user_id, u]));
  const teams = rosters.map((r) => {
    const owner = userById.get(r.owner_id);
    return {
      rosterId: r.roster_id,
      // A team name if the manager set one, their handle if they didn't, and
      // the roster id if the seat is empty — a co-owned or orphaned team still
      // has a record worth placing.
      team: owner?.metadata?.team_name?.trim() || owner?.display_name || `Roster ${r.roster_id}`,
      manager: owner?.display_name || "—",
      weeks: [],
      wins: 0, losses: 0, ties: 0,
      pointsFor: 0, pointsAgainst: 0,
      expectedWins: 0, scheduleLuckPoints: 0,
    };
  });
  const byRoster = new Map(teams.map((t) => [t.rosterId, t]));

  for (const { week, rows } of weeks) {
    const facts = weekFacts(rows);
    for (const [rosterId, f] of facts) {
      const team = byRoster.get(rosterId);
      if (!team) continue; // a roster in the fixtures that isn't in the league

      if (f.result === 1) team.wins++;
      else if (f.result === 0) team.losses++;
      else team.ties++;

      team.pointsFor += f.points;
      team.pointsAgainst += f.oppPoints;
      team.expectedWins += f.allPlay;
      // Positive means the opponent you drew came in under what the league
      // managed that week: a soft draw, in points.
      team.scheduleLuckPoints += f.leagueAvg - f.oppPoints;

      team.weeks.push({
        week,
        points: round2(f.points),
        oppRosterId: f.oppRosterId,
        oppPoints: round2(f.oppPoints),
        leagueAvg: round2(f.leagueAvg),
        won: f.result === 1,
        tied: f.result === 0.5,
        allPlay: f.allPlay,
        // The week this team should have won and didn't, or the other way
        // round: beat most of the league and lost, or beat almost nobody and
        // won anyway. The weeks the whole metric is made of.
        stolen: f.result === 0 && f.allPlay >= 0.5,
        gifted: f.result === 1 && f.allPlay < 0.5,
      });
    }
  }

  const played = (t) => t.wins + t.losses + t.ties;
  const games = Math.max(...teams.map(played), 0);

  // Both components in the same direction — up is luckier — and then onto one
  // scale, so a team that won games it shouldn't have and a team that was
  // handed cold opponents are measured against the same middle.
  const recordLuck = teams.map((t) => t.wins + t.ties / 2 - t.expectedWins);
  const scheduleLuck = teams.map((t) => t.scheduleLuckPoints);
  const zRecord = zScores(recordLuck);
  const zSchedule = zScores(scheduleLuck);

  const rows = teams.map((t, i) => ({
    ...t,
    gamesPlayed: played(t),
    pointsFor: round2(t.pointsFor),
    pointsAgainst: round2(t.pointsAgainst),
    expectedWins: Math.round(t.expectedWins * 100) / 100,
    // The record the all-play says they earned, in the same W-L shape as the
    // real one so the two can be read side by side.
    expectedLosses: Math.round((played(t) - t.expectedWins) * 100) / 100,
    recordLuck: Math.round(recordLuck[i] * 100) / 100,
    scheduleLuckPoints: round2(t.scheduleLuckPoints),
    // Per week, which is the number that means something to a manager: "my
    // opponents have been nine points light every week".
    scheduleLuckPerWeek: played(t) ? round2(t.scheduleLuckPoints / played(t)) : 0,
    // + 0 because Math.round(-0.3) is -0, which prints and compares as a
    // different number from the 0 it means.
    luck: Math.round(clamp(SPREAD * mean([zRecord[i], zSchedule[i]]), -100, 100)) + 0,
  }));

  const current = placeBy(rows.map((r) => ({ ...r, record: r.wins + r.ties / 2 })), "record");
  const expected = placeBy(rows, "expectedWins");
  for (const r of rows) {
    r.place = current.get(r.rosterId);
    r.expectedPlace = expected.get(r.rosterId);
    // Up the standings is positive: places the schedule has given you.
    r.placeSwing = r.expectedPlace - r.place;
  }

  // The opponent names only exist once every row has one, so the week detail
  // is backfilled rather than built in place.
  const names = new Map(rows.map((r) => [r.rosterId, r.team]));
  for (const r of rows) for (const w of r.weeks) w.opponent = names.get(w.oppRosterId) || "—";

  rows.sort((a, b) => a.place - b.place);
  return {
    rows,
    weeksPlayed: weeks.map((w) => w.week),
    throughWeek: weeks.length ? weeks[weeks.length - 1].week : 0,
    games,
  };
}
