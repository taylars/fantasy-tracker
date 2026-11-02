/* The luck metric, on a league small enough to check by hand.
 *
 * Four teams and two weeks, with the scores picked so every number below can
 * be worked out on paper: the all-play records are thirds, the league averages
 * are whole numbers, and the two luck components disagree about one team — so
 * a change that quietly collapsed them into one would fail here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { luckTable, playedWeeks } from "../js/luck.js";

// Rosters 1-4 are A, B, C, D.
const ROSTERS = [1, 2, 3, 4].map((roster_id) => ({ roster_id, owner_id: `u${roster_id}` }));
const USERS = ["A", "B", "C", "D"].map((name, i) => ({
  user_id: `u${i + 1}`, display_name: `mgr${name}`, metadata: { team_name: `Team ${name}` },
}));

/* Week 1: A 100 beats B 90, C 80 beats D 70. League average 85.
 * Week 2: C 70 beats A 60, B 50 beats D 40. League average 55.
 *
 * So A outscored the whole league in week 1 and lost in week 2 to the one team
 * that outscored it, while B won a week it was third-worst in.
 */
const MATCHUPS = {
  1: [
    { roster_id: 1, matchup_id: 1, points: 100 },
    { roster_id: 2, matchup_id: 1, points: 90 },
    { roster_id: 3, matchup_id: 2, points: 80 },
    { roster_id: 4, matchup_id: 2, points: 70 },
  ],
  2: [
    { roster_id: 1, matchup_id: 1, points: 60 },
    { roster_id: 3, matchup_id: 1, points: 70 },
    { roster_id: 2, matchup_id: 2, points: 50 },
    { roster_id: 4, matchup_id: 2, points: 40 },
  ],
  // Fixtures Sleeper serves for weeks nobody has played yet.
  3: [
    { roster_id: 1, matchup_id: 1, points: 0 },
    { roster_id: 2, matchup_id: 1, points: 0 },
    { roster_id: 3, matchup_id: 2, points: 0 },
    { roster_id: 4, matchup_id: 2, points: 0 },
  ],
};

const LEAGUE = { settings: { playoff_week_start: 15 } };
const table = () => luckTable({ matchups: MATCHUPS, rosters: ROSTERS, users: USERS, league: LEAGUE });
const row = (team) => table().rows.find((r) => r.team === team);

test("only the weeks everyone has a score for are counted", () => {
  assert.deepEqual(playedWeeks(MATCHUPS).map((w) => w.week), [1, 2]);
  assert.equal(table().throughWeek, 2);
  assert.equal(table().games, 2);

  // A week in progress is half a result, and half a result is not one: week 2
  // drops out entirely rather than being scored as it stands.
  const midweek = { ...MATCHUPS, 2: MATCHUPS[2].map((r, i) => (i ? { ...r, points: 0 } : r)) };
  assert.deepEqual(playedWeeks(midweek).map((w) => w.week), [1]);

  // Playoff weeks never count, however complete they look: only some of the
  // league is in the bracket, so an all-play record across one is meaningless.
  assert.deepEqual(
    playedWeeks(MATCHUPS, { playoffWeekStart: 2 }).map((w) => w.week), [1]);
});

test("a week in progress is not a week, however many scores it has", () => {
  // The trap this guards. An hour into Sunday afternoon every roster has
  // somebody on the field, so every score is above zero and the week looks
  // finished on the numbers alone — while most of the games haven't kicked
  // off. Only the calendar knows, so the calendar decides.
  const live = {
    ...MATCHUPS,
    2: MATCHUPS[2].map((r) => ({ ...r, points: r.points / 4 })),
  };
  assert.deepEqual(playedWeeks(live).map((w) => w.week), [1, 2]);
  assert.deepEqual(
    playedWeeks(live, { completedThrough: 1 }).map((w) => w.week), [1]);

  // And the table built that way is a one-week table: the half-played week
  // leaves no mark on anyone's record.
  const t = luckTable({ matchups: live, rosters: ROSTERS, users: USERS,
                        league: LEAGUE, completedThrough: 1 });
  assert.equal(t.throughWeek, 1);
  assert.deepEqual(t.rows.map((r) => r.wins + r.losses), [1, 1, 1, 1]);
});

test("expected wins are the all-play record", () => {
  // A: beat all three in week 1, two of three in week 2.
  assert.equal(row("Team A").expectedWins, 1.67);
  assert.equal(row("Team B").expectedWins, 1);
  assert.equal(row("Team C").expectedWins, 1.33);
  assert.equal(row("Team D").expectedWins, 0);

  // Which is the record minus the draw: A won one of the two it earned 1.67 of.
  assert.equal(row("Team A").wins, 1);
  assert.equal(row("Team A").recordLuck, -0.67);
  assert.equal(row("Team C").recordLuck, 0.67);
  assert.equal(row("Team B").recordLuck, 0);
});

test("schedule luck is what the opponents you drew scored against the league", () => {
  // A drew the week's top scorer twice over: 90 against an 85 average, then 70
  // against a 55 one.
  assert.equal(row("Team A").scheduleLuckPoints, -20);
  assert.equal(row("Team A").scheduleLuckPerWeek, -10);
  // B's two draws cancelled: the league's best, then its worst.
  assert.equal(row("Team B").scheduleLuckPoints, 0);
  assert.equal(row("Team D").scheduleLuckPoints, 10);
});

test("the two components are both in the score, and disagree about D", () => {
  // D's record is exactly what it earned — it lost both and deserved to — so
  // record luck alone would call it average. But it drew the two softest
  // opponents available, which is luck it failed to use, and the score says so.
  assert.equal(row("Team D").recordLuck, 0);
  assert.equal(row("Team D").luck, 20);
  assert.equal(row("Team B").luck, 0); // average on both counts

  // A is the unluckiest team in the league on both counts; C the luckiest.
  assert.equal(row("Team A").luck, -76);
  assert.equal(row("Team C").luck, 56);
});

test("place is the standings, expected place is the all-play standings", () => {
  assert.deepEqual(table().rows.map((r) => r.team), ["Team C", "Team A", "Team B", "Team D"]);
  assert.deepEqual(table().rows.map((r) => r.place), [1, 2, 3, 4]);

  // A outscored everyone over the two weeks and sits second.
  assert.equal(row("Team A").expectedPlace, 1);
  assert.equal(row("Team A").placeSwing, -1);
  assert.equal(row("Team C").expectedPlace, 2);
  assert.equal(row("Team C").placeSwing, 1);

  // A tied record is settled on points, the way Sleeper settles it: A and B
  // are both 1-1, and A scored more.
  assert.equal(row("Team A").pointsFor, 160);
  assert.equal(row("Team B").pointsFor, 140);
});

test("the weeks that went the wrong way are marked", () => {
  const a = row("Team A").weeks.find((w) => w.week === 2);
  assert.equal(a.stolen, true);   // beat two of three and lost
  assert.equal(a.opponent, "Team C");
  assert.equal(a.oppPoints, 70);
  assert.equal(a.leagueAvg, 55);

  const b = row("Team B").weeks.find((w) => w.week === 2);
  assert.equal(b.gifted, true);   // beat one of three and won
  assert.equal(row("Team A").weeks.find((w) => w.week === 1).stolen, false);
});

test("a league with no spread is all average rather than a divide by zero", () => {
  const flat = {
    1: [
      { roster_id: 1, matchup_id: 1, points: 100 },
      { roster_id: 2, matchup_id: 1, points: 100 },
      { roster_id: 3, matchup_id: 2, points: 100 },
      { roster_id: 4, matchup_id: 2, points: 100 },
    ],
  };
  const rows = luckTable({ matchups: flat, rosters: ROSTERS, users: USERS, league: LEAGUE }).rows;
  assert.deepEqual(rows.map((r) => r.luck), [0, 0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.ties), [1, 1, 1, 1]);
});

test("a season nobody has played yet is empty rather than broken", () => {
  const t = luckTable({ matchups: { 1: MATCHUPS[3] }, rosters: ROSTERS, users: USERS, league: LEAGUE });
  assert.equal(t.throughWeek, 0);
  assert.deepEqual(t.rows.map((r) => r.luck), [0, 0, 0, 0]);
  assert.deepEqual(t.rows.map((r) => r.gamesPlayed), [0, 0, 0, 0]);
});

test("a manager with no team name falls back to their handle, then the roster", () => {
  const users = [{ user_id: "u1", display_name: "mgrA", metadata: {} }];
  const rows = luckTable({ matchups: MATCHUPS, rosters: ROSTERS, users, league: LEAGUE }).rows;
  assert.equal(rows.find((r) => r.rosterId === 1).team, "mgrA");
  assert.equal(rows.find((r) => r.rosterId === 2).team, "Roster 2");
});
