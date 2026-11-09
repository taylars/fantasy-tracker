/* The gate between a nightly build and the site: what bin/lib/bundle.mjs
 * refuses to publish. A healthy two-team week is built by hand, then broken
 * one way at a time — each the shape of a failure this model has actually
 * had, or one an upstream change could cause. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBundle, LIMITS } from "../bin/lib/bundle.mjs";

// The real limits, scaled down to a two-team league.
const SMALL = { ...LIMITS, minTeams: 2, minPlayersPerTeam: 6, minStarters: 4 };

function team(name, opponent) {
  return {
    opponent, home: name === "AAA", spread: 0, total: 46, implied: 23, implied_against: 23,
    plays: 63, pass_rate: 0.57, dropbacks: 36, rushes: 27, team_tds: 2.5, games: 9, final: false,
  };
}

function roster(teamName) {
  const p = (id, pos, line) => ({ id: `${teamName}-${id}`, name: `${teamName} ${id}`, pos, team: teamName, inj: null, line });
  return [
    p("qb", "QB", { pass_att: 34, pass_cmp: 22, pass_yd: 260, pass_td: 1.7, pass_int: 0.7, rush_att: 3, rush_yd: 15, rush_td: 0.1 }),
    p("rb", "RB", { rec_tgt: 4, rec: 3, rec_yd: 22, rec_td: 0.1, rush_att: 18, rush_yd: 80, rush_td: 0.6 }),
    p("rb2", "RB", { rec_tgt: 2, rec: 1.5, rec_yd: 10, rec_td: 0.05, rush_att: 6, rush_yd: 25, rush_td: 0.2 }),
    p("wr", "WR", { rec_tgt: 10, rec: 6.5, rec_yd: 85, rec_td: 0.5 }),
    p("wr2", "WR", { rec_tgt: 8, rec: 5, rec_yd: 60, rec_td: 0.35 }),
    p("wr3", "WR", { rec_tgt: 4, rec: 2.5, rec_yd: 30, rec_td: 0.15 }),
    p("te", "TE", { rec_tgt: 4, rec: 3, rec_yd: 30, rec_td: 0.2 }),
    p("k", "K", { fgm: 1.7, fga: 2, xpm: 2.4 }),
    p("def", "DEF", { sack: 2.5, int: 0.8, fum_rec: 0.6, def_td: 0.15, pts_allow_21_27: 0.5 }),
  ];
}

const defence = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`T${i}`, {
  games: 9, WR: { volume: 1, efficiency: 1, td: 1 }, TE: { volume: 1.1, efficiency: 0.9, td: 1.2 },
}]));

function healthy() {
  const index = { season: "2099", current: 10, latest: { season: "2099", week: 10, file: "2099-week-10.json" } };
  const bundle = {
    season: "2099", week: 10, through_week: 9,
    league: { team_snaps: 62, team_pass_rate: 0.57, team_tds: 2.5, points_per_game: 23, points_per_td: 9.3 },
    teams: { AAA: team("AAA", "BBB"), BBB: team("BBB", "AAA") },
    defence,
    players: [...roster("AAA"), ...roster("BBB")],
  };
  return { index, bundle };
}

test("a healthy week passes", () => {
  const { index, bundle } = healthy();
  assert.deepEqual(checkBundle(index, bundle, SMALL).problems, []);
});

test("the offseason passes as long as it says why", () => {
  assert.deepEqual(checkBundle({ latest: null, reason: "The 2099 regular season is over." }, null).problems, []);
  assert.equal(checkBundle({ latest: null }, null).problems.length, 1);
});

test("a game with no line on it fails", () => {
  const { index, bundle } = healthy();
  bundle.teams.AAA.total = NaN;
  bundle.teams.AAA.implied = NaN;
  assert.ok(checkBundle(index, bundle, SMALL).problems.some((p) => /AAA total/.test(p)));
});

test("a defence projected like an offence fails", () => {
  // The bug this guards: reading touchdowns allowed as touchdowns scored put
  // fourteen points a week on every defence.
  const { index, bundle } = healthy();
  for (const p of bundle.players) if (p.pos === "DEF") p.line.def_td = 2.6;
  assert.ok(checkBundle(index, bundle, SMALL).problems.some((p) => /average DEF/.test(p)));
});

test("one team short of its targets is a warning; every team short fails", () => {
  // One receiver room with three men out is a week; every team an eighth short
  // is the bug where rates conditional on playing were never redistributed.
  const { index, bundle } = healthy();
  for (const p of bundle.players) if (p.team === "BBB" && p.line.rec_tgt) p.line.rec_tgt *= 0.6;
  const one = checkBundle(index, bundle, SMALL);
  assert.deepEqual(one.problems, []);
  assert.ok(one.warnings.some((w) => /BBB targets/.test(w)));

  for (const p of bundle.players) if (p.team === "AAA" && p.line.rec_tgt) p.line.rec_tgt *= 0.6;
  const both = checkBundle(index, bundle, { ...SMALL, maxVolumeOutliers: 1 });
  assert.ok(both.problems.some((p) => /AAA targets/.test(p)) && both.problems.some((p) => /BBB targets/.test(p)));
});

test("a missing position, a negative stat and a lopsided game all fail", () => {
  const { index, bundle } = healthy();
  bundle.players = bundle.players.filter((p) => !(p.team === "AAA" && p.pos === "K"));
  bundle.players.find((p) => p.pos === "WR").line.rec_yd = -5;
  bundle.teams.BBB.opponent = "CCC";
  const problems = checkBundle(index, bundle, SMALL).problems;
  assert.ok(problems.some((p) => /AAA has no K/.test(p)));
  assert.ok(problems.some((p) => /rec_yd is -5/.test(p)));
  assert.ok(problems.some((p) => /disagree/.test(p)));
});

test("an index pointing at a different week from its bundle fails", () => {
  const { index, bundle } = healthy();
  bundle.week = 9;
  assert.ok(checkBundle(index, bundle, SMALL).problems.some((p) => /index says/.test(p)));
});
