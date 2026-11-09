/* The projection model, against claims that have to survive it being tuned.
 *
 * Same rule as the board's suite next door: nothing here pins a current
 * number down, because every number moves the first time a constant is
 * changed and a suite that failed on every tuning would be deleted inside a
 * week. What is pinned is the arithmetic that has to hold whatever the
 * constants are — a rate regressed at its own sample size is half its
 * position's, a team's touchdowns add up to the touchdowns it is expected to
 * score, and a role that changed four weeks ago counts for more than one that
 * changed in September.
 *
 * The one exception is the defensive stat keys, which are pinned exactly.
 * Reading `td` on a defensive row as a defensive touchdown — it is
 * touchdowns *allowed* — put fourteen points a week on every defence in the
 * league, and it is the sort of mistake that looks like a plausible number
 * all the way to the lineup it ruins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBundle, finalizeWeek, form, tagByAttendance, formWeights, leagueRates, normalizeTouchdowns,
  pointsAllowedBuckets, readSeason, shrink, teamVolume, yardsAllowedBand,
} from "../js/project.js";

/* ---------- a season small enough to work out on paper ---------- */

/* Two teams, three weeks, five players. Every number below is chosen so the
 * expected answer can be computed by hand, which is what makes a failure
 * here say what broke rather than that something did.
 */
const TEAMS = ["AAA", "BBB"];

// nflverse's convention: a positive spread means the HOME team is favoured
// by that many, so AAA is a three-point favourite in every game here.
function game(week, home, away, { homeScore = 24, awayScore = 20, spread = 3, total = 44 } = {}) {
  return { season: "2099", week, home, away, homeScore, awayScore, spread, total, kickoff: null };
}

function row(player_id, name, position, team, opponent, stats) {
  return { player_id, name, position, team, opponent, home: true, injury_status: null, stats };
}

/* A whole team's week: a quarterback, two receivers, a back, and the defence
 * that played them, with the team snap count on every row the way Sleeper
 * sends it.
 */
function teamWeek(week, team, opponent, { snaps = 60, passAtt = 34, rushAtt = 24,
                                          topShare = 0.3, injury = null } = {}) {
  const tm = { tm_off_snp: snaps, gp: 1 };
  const targets = Math.round(passAtt * 0.95);
  const top = Math.round(targets * topShare);
  const other = targets - top - 4;
  return [
    row(`${team}-qb`, `${team} QB`, "QB", team, opponent, {
      ...tm, off_snp: snaps, pass_att: passAtt, pass_cmp: Math.round(passAtt * 0.65),
      pass_yd: Math.round(passAtt * 7.2), pass_td: 2, pass_int: 1, pass_fd: 12,
      rush_att: 3, rush_yd: 15, rush_td: 0,
    }),
    { ...row(`${team}-wr1`, `${team} WR1`, "WR", team, opponent, {
      ...tm, off_snp: Math.round(snaps * 0.9), rec_tgt: top, rec: Math.round(top * 0.65),
      rec_yd: top * 9, rec_td: 1, rec_rz_tgt: 2, rec_fd: 3,
    }), injury_status: injury },
    row(`${team}-wr2`, `${team} WR2`, "WR", team, opponent, {
      ...tm, off_snp: Math.round(snaps * 0.7), rec_tgt: other, rec: Math.round(other * 0.6),
      rec_yd: other * 8, rec_td: 0, rec_rz_tgt: 1, rec_fd: 2,
    }),
    row(`${team}-rb`, `${team} RB`, "RB", team, opponent, {
      ...tm, off_snp: Math.round(snaps * 0.6), rush_att: rushAtt - 3,
      rush_yd: (rushAtt - 3) * 4.3, rush_td: 1, rush_rz_att: 3, rush_fd: 4,
      rec_tgt: 4, rec: 3, rec_yd: 22, rec_td: 0,
    }),
    row(`${opponent}-def`, `${opponent} D`, "DEF", opponent, team, {
      gp: 1, sack: 2, int: 1, fum_rec: 1, ff: 2, def_td: 0, def_st_td: 0,
      // The trap: `td` on a defensive row is touchdowns ALLOWED.
      td: 3, pts_allow: 24, yds_allow: 350,
    }),
  ];
}

function season({ weeks = 3, injury = null, lastWeek = {} } = {}) {
  const rows = [];
  const games = [];
  for (let week = 1; week <= weeks; week++) {
    const options = week === weeks ? { injury, ...lastWeek } : {};
    rows.push({
      week,
      rows: [
        ...teamWeek(week, "AAA", "BBB", options),
        ...teamWeek(week, "BBB", "AAA", {}),
      ],
    });
    games.push(game(week, "AAA", "BBB"));
  }
  // The week being projected, with no score on it yet.
  games.push({ ...game(weeks + 1, "AAA", "BBB"), homeScore: null, awayScore: null });
  return { weeks: rows, games, week: weeks + 1 };
}

const bundleOf = (options = {}) => {
  const { weeks, games, week } = season(options);
  return finalizeWeek(buildBundle({ season: "2099", week, weeks, games, generatedAt: "2099-01-01T00:00:00Z" }));
};
const rawOf = (options = {}) => {
  const { weeks, games, week } = season(options);
  return buildBundle({ season: "2099", week, weeks, games, generatedAt: "2099-01-01T00:00:00Z" });
};

const find = (bundle, id) => bundle.players.find((p) => p.id === id);

/* ---------- regression ---------- */

test("a rate at its own sample size is half its position's", () => {
  // Twenty of forty caught against a prior of 0.6 at k=40: (20 + 24) / 80.
  assert.equal(shrink(20, 40, 0.6, 40), 0.55);
  // With nothing seen at all, the prior is the answer.
  assert.equal(shrink(0, 0, 0.6, 40), 0.6);
  // With far more evidence than the prior weighs, the player wins.
  assert.ok(shrink(400, 400, 0.6, 40) > 0.95);
});

test("recency weights count the sample honestly", () => {
  const weights = formWeights(6, 3);
  // Rescaled to sum to the number of games, so a weighted numerator and
  // denominator still carry six games of evidence into shrink and not three.
  assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 6) < 1e-9);
  // Newest last, and a half-life of three halves the weight three games back.
  assert.ok(weights[5] > weights[0]);
  assert.ok(Math.abs(weights[5] / weights[2] - 2) < 1e-9);
});

test("a role that changed recently outweighs the season it replaced", () => {
  const games = [
    { tgt: 2, snaps: 20 }, { tgt: 2, snaps: 20 }, { tgt: 2, snaps: 20 },
    { tgt: 12, snaps: 60 },
  ];
  const recent = form(games, (g) => g.tgt, (g) => g.snaps, 1.5);
  const flat = form(games, (g) => g.tgt, (g) => g.snaps, 1000);
  assert.ok(recent.seen / recent.chances > flat.seen / flat.chances,
    "the last game should move the rate more than an equal-weight average does");
});

/* ---------- team volume ---------- */

test("an underdog throws more than the same team favoured", () => {
  const { weeks, games } = season();
  const { byTeam, scores } = readSeason(weeks, games);
  const league = leagueRates(weeks, byTeam, scores);
  const team = byTeam.get("AAA");

  const favoured = teamVolume(team, { implied: 27, impliedAgainst: 17, spread: -10, total: 44 }, league);
  const trailing = teamVolume(team, { implied: 17, impliedAgainst: 27, spread: 10, total: 44 }, league);

  assert.ok(trailing.passRate > favoured.passRate);
  assert.ok(trailing.dropbacks > favoured.dropbacks);
  // Pace is the team's own and does not move with the spread.
  assert.ok(Math.abs(trailing.plays - favoured.plays) < 1e-9);
});

test("the implied total is the total split by the spread", () => {
  const bundle = bundleOf();
  // Home, favoured by 3 in a game totalling 44: 22 + 1.5 against 22 - 1.5.
  assert.equal(bundle.teams.AAA.implied, 23.5);
  assert.equal(bundle.teams.BBB.implied, 20.5);
  assert.equal(bundle.teams.AAA.implied_against, bundle.teams.BBB.implied);
});

/* ---------- the two normalisations ---------- */

test("a team's touchdowns add up to the touchdowns it is expected to score", () => {
  const bundle = bundleOf();
  for (const team of TEAMS) {
    const expected = bundle.teams[team].team_tds;
    const projected = bundle.players
      .filter((p) => p.team === team && p.line && p.pos !== "K" && p.pos !== "DEF")
      .reduce((total, p) => total +
        (p.pos === "QB" ? 0 : p.line.rec_td ?? 0) + (p.line.rush_td ?? 0), 0);
    assert.ok(Math.abs(projected - expected) < 0.05,
      `${team}: projected ${projected.toFixed(2)} against an expected ${expected}`);
  }
});

test("targets a player who is out cannot take with him go to his team-mates", () => {
  const healthy = bundleOf();
  const hurt = bundleOf({ injury: "Out" });

  const before = find(healthy, "AAA-wr2").line.rec_tgt;
  const after = find(hurt, "AAA-wr2").line.rec_tgt;
  assert.ok(after > before,
    `WR2 should gain targets when WR1 is out: ${before} -> ${after}`);

  // And the other team, who lost nobody, is untouched.
  assert.equal(find(hurt, "BBB-wr2").line.rec_tgt, find(healthy, "BBB-wr2").line.rec_tgt);
});

test("a live injury tag moves the targets exactly as one known at build time", () => {
  // The page builds nothing: it takes the published rates and Sleeper's tags
  // as of now. A receiver ruled out after the morning build has to cost his
  // team-mates nothing and gain them exactly what he would have.
  const raw = rawOf();
  const live = finalizeWeek(raw, new Map([["AAA-wr1", "Out"]]));
  const known = bundleOf({ injury: "Out" });
  assert.equal(find(live, "AAA-wr1").inj, "Out");
  assert.equal(find(live, "AAA-wr2").line.rec_tgt, find(known, "AAA-wr2").line.rec_tgt);
  assert.ok(find(live, "AAA-wr2").line.rec_tgt > find(finalizeWeek(raw), "AAA-wr2").line.rec_tgt);
});

test("what is published is rates before injuries, and finishing it changes nothing in it", () => {
  const raw = rawOf();
  const before = JSON.stringify(raw);
  assert.ok(raw.players.every((p) => p.line === undefined), "no line: those depend on the tags");
  assert.ok(raw.league.sack_rate > 0 && raw.league.targets_per_attempt > 0);
  finalizeWeek(raw, new Map([["AAA-wr1", "Out"]]));
  assert.equal(JSON.stringify(raw), before, "a second league on the page must start from the same rates");
});

test("normalising touchdowns leaves the shares alone", () => {
  const volumes = { AAA: { team_tds: 3 } };
  const projected = [
    { position: "WR", team: "AAA", record: {}, parts: {},
      draw: { targets: 10, recTdPerTarget: 0.1, carries: 0, rushTdPerCarry: 0 } },
    { position: "RB", team: "AAA", record: {}, parts: {},
      draw: { targets: 4, recTdPerTarget: 0.05, carries: 15, rushTdPerCarry: 0.06 } },
  ];
  const share = (p) => p.draw.targets * p.draw.recTdPerTarget + p.draw.carries * p.draw.rushTdPerCarry;
  const was = projected.map(share);
  normalizeTouchdowns(projected, volumes);
  const now = projected.map(share);

  assert.ok(Math.abs(now[0] + now[1] - 3) < 1e-9, "the total is the team's");
  assert.ok(Math.abs(now[0] / now[1] - was[0] / was[1]) < 1e-9, "the ratio between them is not");
});

/* ---------- the defence ---------- */

test("`td` on a defensive row is touchdowns allowed, not a defensive score", () => {
  // Three touchdowns allowed every week by both defences, and not one scored.
  // Read the wrong key and this comes back at three a game.
  const bundle = bundleOf();
  const defence = bundle.players.filter((p) => p.pos === "DEF" && p.line);
  assert.ok(defence.length);
  for (const unit of defence) {
    assert.ok(unit.line.def_td < 0.2, `${unit.name} projects ${unit.line.def_td} defensive TDs`);
    assert.ok(unit.line.sack > 0, "sacks are a real defensive stat and should survive");
  }
});

test("points allowed is a distribution over the bands, centred on the implied total", () => {
  const bands = pointsAllowedBuckets({ pointsAllowed: 24, pointsAllowedSpread: 9.5 });
  const total = Object.values(bands).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, "the bands are exhaustive");
  // 24 sits in 21-27, which should therefore be the likeliest band.
  const likeliest = Object.entries(bands).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(likeliest, "pts_allow_21_27");
  // A shutout is possible and unlikely.
  assert.ok(bands.pts_allow_0 > 0 && bands.pts_allow_0 < 0.02);
});

test("yards allowed lands in the band it belongs to", () => {
  assert.equal(yardsAllowedBand(0), "yds_allow_0_100");
  assert.equal(yardsAllowedBand(299), "yds_allow_200_299");
  assert.equal(yardsAllowedBand(300), "yds_allow_300_349");
  assert.equal(yardsAllowedBand(1000), "yds_allow_550p");
});

/* ---------- the bundle ---------- */

test("a player whose team is not playing comes back flagged rather than missing", () => {
  const { weeks, games, week } = season();
  // Drop the week's only fixture: now nobody has a game.
  const bundle = buildBundle({
    season: "2099", week, weeks,
    games: games.filter((g) => g.week < week),
  });
  const player = find(bundle, "AAA-wr1");
  assert.ok(player, "he must still be in the bundle, or a roster cannot be resolved");
  assert.equal(player.flag, "bye");
  assert.equal(player.line, undefined);
});

test("the matchup layer can be switched off without changing anything else", () => {
  const { weeks, games, week } = season();
  const on = buildBundle({ season: "2099", week, weeks, games });
  const off = buildBundle({ season: "2099", week, weeks, games, matchup: false });

  // Volume is the team's and the spread's, so it survives either way.
  assert.deepEqual(on.teams, off.teams);
  // The measured factors are still published — they are context on the page
  // whether or not they were applied.
  assert.deepEqual(Object.keys(on.defence).sort(), Object.keys(off.defence).sort());
  assert.equal(find(off, "AAA-wr1").parts.matchup_volume, 1);
  assert.equal(find(off, "AAA-wr1").parts.matchup_efficiency, 1);
});

test("the bundle knows which weeks it was built from", () => {
  const bundle = bundleOf();
  assert.equal(bundle.week, 4);
  assert.equal(bundle.through_week, 3);
  assert.equal(bundle.season, "2099");
  assert.ok(bundle.league.points_per_td > 0);
});

test("a finished week is tagged by who played, not by today's injury report", () => {
  const raw = rawOf();
  const played = new Set(raw.players.filter((p) => p.id !== "AAA-wr1").map((p) => p.id));
  const past = tagByAttendance(raw, played);
  assert.equal(past.past, true);
  assert.equal(find(past, "AAA-wr1").inj, "Out", "he did not play, so he was out");
  assert.equal(find(past, "AAA-wr2").inj, null, "he played, so whatever his tag says now, he was in");
  // And finishing it hands the absent receiver's targets on, as a live Out would.
  assert.ok(find(finalizeWeek(past), "AAA-wr2").line.rec_tgt > find(finalizeWeek(raw), "AAA-wr2").line.rec_tgt);
});
