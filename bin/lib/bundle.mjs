/* What a lineup bundle has to look like before it is allowed onto the site.
 *
 * The bundle is no longer committed: the Pages workflow builds it from
 * Sleeper and nflverse on every deploy and once a day, and nobody looks at it
 * before it ships. So this is the look. A deploy whose bundle fails here does
 * not go out, and the site keeps serving the last one that passed — a day-old
 * lineup is a much smaller problem than a confidently wrong one.
 *
 * Every limit below is a range a real week sits comfortably inside, measured
 * off 2026 weeks 9 and 10, wide enough that an odd week (a blowout spread, a
 * team with three backs on IR) still passes and narrow enough that the ways
 * this has actually broken would not: a defence scoring touchdowns allowed
 * (fourteen points a week on every one), a team missing an eighth of its
 * targets, a schedule with no lines on it.
 */

import { scoreStats } from "../../js/pool.js";
import { finalizeWeek, playProbability } from "../../js/project.js";

/* Half PPR with a standard defence: the scoring the backtest and the CLI
 * report in, and the one the sanity limits below are written against. */
export const REFERENCE_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2,
  fgm: 3, fgmiss: -1, xpm: 1, xpmiss: -1,
  sack: 1, ff: 1, int: 2, fum_rec: 2, def_td: 6, def_st_td: 6, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

const LIMITS = {
  league: {
    team_snaps: [55, 72], team_pass_rate: [0.45, 0.7],
    team_tds: [1.5, 3.5], points_per_td: [6.5, 12],
  },
  team: {
    total: [30, 65], implied: [5, 42], plays: [50, 75],
    dropbacks: [22, 52], rushes: [15, 42], team_tds: [0.5, 5],
  },
  defenceFactor: [0.5, 2],
  // Targets as a share of dropbacks, and carries of designed runs, summed over
  // a team's players weighted by whether they play. The volume normalisation
  // pins the first near 0.89. Carries run wider: the normalisation's scale
  // stops at 0.7, and a backfield where four backs and three quarterbacks all
  // have recent carries (Philadelphia, late 2026) can stay over by a fifth
  // once it gets there. Past 1.3 is something else.
  targetShare: [0.8, 0.95],
  carryShare: [0.65, 1.3],
  // How many teams may sit outside the target and carry ranges before it is
  // the model rather than the week. One team with three receivers out cannot
  // absorb every target before the normalisation's cap (Arizona, week 10 of
  // 2026), and that is a warning; the bug this guards against left every team
  // an eighth short at once.
  maxVolumeOutliers: 3,
  minTeams: 20,
  minPlayersPerTeam: 15,
  maxPoints: 45,
  // The average defence and kicker, in half PPR. Real weeks sit near 6.3 and
  // 6.9; reading touchdowns allowed as touchdowns scored put the defences
  // near 20.
  averageDefence: [3, 11],
  averageKicker: [4, 10.5],
  topQuarterback: [15, 35],
  minStarters: 60,         // players projected for 10+ points
};

const inside = (value, [lo, hi]) => Number.isFinite(value) && value >= lo && value <= hi;

/* Every problem with the bundle, as sentences: `problems` stop a deploy,
 * `warnings` are printed and let through. No problems means ship it. An index
 * with no week in it is the offseason, which is a fine thing to publish. */
export function checkBundle(index, bundle, limits = LIMITS) {
  const problems = [];
  const warnings = [];
  const fail = (message) => problems.push(message);
  const done = () => ({ problems, warnings });

  if (!index) { fail("no index.json"); return done(); }
  if (index.latest === null) {
    if (!index.reason) fail("the index names no week and gives no reason");
    return done();
  }
  if (!index.latest?.file) { fail("the index names no file"); return done(); }
  if (!bundle) { fail(`${index.latest.file} is missing`); return done(); }
  if (bundle.week !== index.latest.week || bundle.season !== index.latest.season) {
    fail(`the index says ${index.latest.season} week ${index.latest.week}; ` +
         `the bundle is ${bundle.season} week ${bundle.week}`);
  }
  if (!(bundle.through_week >= 1)) fail("the bundle is built from no completed weeks");

  // A published bundle is rates before injuries; what gets checked is what a
  // reader would see, so it is finished here against the build's own tags.
  if (bundle.players?.some((p) => p.draw)) {
    for (const key of ["sack_rate", "targets_per_attempt"]) {
      if (!(bundle.league?.[key] > 0)) fail(`league ${key} is missing`);
    }
    bundle = finalizeWeek(bundle);
  }

  for (const [key, range] of Object.entries(limits.league)) {
    if (!inside(bundle.league?.[key], range)) fail(`league ${key} is ${bundle.league?.[key]}, outside ${range}`);
  }

  const teams = Object.entries(bundle.teams ?? {});
  if (teams.length < limits.minTeams) fail(`only ${teams.length} teams have a game`);
  if (teams.length % 2) fail(`${teams.length} teams playing is an odd number`);
  for (const [team, volume] of teams) {
    for (const [key, range] of Object.entries(limits.team)) {
      if (!inside(volume[key], range)) fail(`${team} ${key} is ${volume[key]}, outside ${range}`);
    }
    if (bundle.teams[volume.opponent]?.opponent !== team) fail(`${team} and ${volume.opponent} disagree about their game`);
  }

  const defences = Object.entries(bundle.defence ?? {});
  if (defences.length !== 32) fail(`${defences.length} defences rated, not 32`);
  for (const [team, rating] of defences) {
    for (const [bucket, factors] of Object.entries(rating)) {
      if (typeof factors !== "object") continue;
      for (const [name, value] of Object.entries(factors)) {
        if (!inside(value, limits.defenceFactor)) fail(`${team} ${bucket} ${name} factor is ${value}`);
      }
    }
  }

  const byTeam = new Map(teams.map(([team]) => [team, { players: 0, targets: 0, carries: 0, positions: new Set() }]));
  const points = [];
  for (const player of bundle.players ?? []) {
    if (!player.line) continue;
    const mine = byTeam.get(player.team);
    if (!mine) { fail(`${player.name} is projected for ${player.team}, which has no game`); continue; }
    for (const [key, value] of Object.entries(player.line)) {
      if (!(Number.isFinite(value) && value >= 0)) fail(`${player.name} ${key} is ${value}`);
    }
    const plays = playProbability(player.inj);
    mine.players++;
    mine.positions.add(player.pos);
    mine.targets += plays * (player.line.rec_tgt ?? 0);
    mine.carries += plays * (player.line.rush_att ?? 0);
    points.push({ player, points: scoreStats(player.line, REFERENCE_SCORING) });
  }

  const outliers = [];
  for (const [team, mine] of byTeam) {
    const volume = bundle.teams[team];
    if (mine.players < limits.minPlayersPerTeam) fail(`${team} has only ${mine.players} players projected`);
    for (const position of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
      if (!mine.positions.has(position)) fail(`${team} has no ${position} projected`);
    }
    const targetShare = mine.targets / volume.dropbacks;
    const carryShare = mine.carries / volume.rushes;
    if (!inside(targetShare, limits.targetShare)) outliers.push(`${team} targets are ${targetShare.toFixed(2)} of its dropbacks`);
    if (!inside(carryShare, limits.carryShare)) outliers.push(`${team} carries are ${carryShare.toFixed(2)} of its runs`);
  }
  if (outliers.length > limits.maxVolumeOutliers) outliers.forEach(fail);
  else warnings.push(...outliers);

  points.sort((a, b) => b.points - a.points);
  const top = points[0];
  if (top && top.points > limits.maxPoints) fail(`${top.player.name} projects ${top.points.toFixed(1)} points`);
  const quarterback = points.find((p) => p.player.pos === "QB");
  if (!inside(quarterback?.points, limits.topQuarterback)) {
    fail(`the best quarterback projects ${quarterback?.points?.toFixed(1)} points`);
  }
  for (const [position, key] of [["DEF", "averageDefence"], ["K", "averageKicker"]]) {
    const scored = points.filter((p) => p.player.pos === position);
    const average = scored.reduce((sum, p) => sum + p.points, 0) / scored.length;
    if (!inside(average, limits[key])) fail(`the average ${position} projects ${average.toFixed(1)} points`);
  }
  const starters = points.filter((p) => p.points >= 10).length;
  if (starters < limits.minStarters) fail(`only ${starters} players project 10 or more points`);

  return done();
}

export { LIMITS };
