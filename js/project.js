/* Weekly fantasy projections, built from what has already happened.
 *
 * This is the half of the lineup page that never runs in a browser. It takes
 * every completed week of a season — one row per player per game, straight off
 * Sleeper's weekly stats — plus the schedule with its spreads and totals, and
 * turns them into a projected stat line for one upcoming week.
 *
 * Nothing in here is a provider's projection. The board next door prices
 * players off Rotowire's season line because a draft needs one number per
 * player and no history to build it from; a lineup in week 10 has nine weeks
 * of evidence sitting right there, and a start/sit call turns on exactly the
 * things a season projection has already averaged away — who is getting the
 * snaps now, who the defence is, and whether the game is going to be a
 * shootout or a grind.
 *
 * The shape of it, which is also the shape of what the page prints:
 *
 *     points = team volume × player opportunity × efficiency × matchup
 *
 *   team volume       how many dropbacks and runs the offence gets, from its
 *                     own pace and the game's implied total
 *   player opportunity his snap share, and what he does with a pass snap
 *   efficiency        catch rate and yards, his own blended with his
 *                     position's
 *   matchup           what this defence has allowed per target, adjusted for
 *                     the offences that did the allowing
 *
 * Every layer is regressed toward its league average by sample size, because
 * in week 4 almost nothing is known and in week 14 most of it is. The
 * regression is the same everywhere: a rate is `(seen + prior × k) / (chances
 * + k)`, so k is "how many chances before the player outweighs his position".
 *
 * A projected stat line, not points. Points are a league's own business — the
 * same line is worth different amounts under two scoring settings — so this
 * emits the line and js/lineup.js scores it. That is the same division the
 * draft board already makes.
 *
 * Pure arithmetic over plain objects: no fetching, no clock, no DOM. The
 * fetching is in bin/lib/nfl.mjs and the drawing is in js/lineup-app.js.
 */

// ---------------------------------------------------------------- the knobs

/* How fast a role change registers. A half-life of three games means last
 * week counts double the game four weeks ago, over a window of eight. Longer
 * and a back who just took over the backfield still reads as a backup;
 * shorter and one quiet afternoon in a committee looks like a benching.
 */
export const FORM_WINDOW = 8;
export const FORM_HALF_LIFE = 3;

/* Regression constants, in units of the chances each rate is measured over.
 * A receiver needs about 45 targets before his own catch rate outweighs his
 * position's — which is the 60/40 blend a full season of targets gets you,
 * and in week 5 it is nearer 25/75, which is the right answer in week 5.
 *
 * Touchdown rates get the heaviest hand of all: a target becomes a touchdown
 * a twentieth of the time, so ten games of evidence is a handful of events
 * and a receiver with three of them is not a touchdown machine.
 */
const K = {
  catchRate: 30,
  yardsPerCatch: 20,
  yardsPerCarry: 40,
  recTdPerTarget: 50,
  rushTdPerCarry: 40,
  firstDowns: 25,
  fumbles: 120,
  cmpRate: 60,
  yardsPerCompletion: 40,
  passTdPerAttempt: 80,
  intPerAttempt: 120,
  teamPace: 4,       // games, not chances: team pace settles fast
  defence: 8,        // the handoff's g/(g+8)
  kickRate: 20,
};

/* Game script: how much the spread moves a pass rate. Trailing teams throw,
 * and the effect is real but small — about half a point of pass rate per
 * point of expected margin. Capped at eight points of rate either way, which
 * a 14-point spread already reaches: past that the relationship flattens out
 * and the cap is nearer the truth than the line is.
 */
const PASS_RATE_PER_POINT = 0.005;
const PASS_RATE_CAP = 0.08;

/* A red-zone target is worth more than a target, and the ratio of a player's
 * red-zone share to his overall share is the cheapest honest way to say so.
 * Half weight, clamped: a tight end with two red-zone looks in nine games is
 * not a goal-line specialist, and this term should never be the whole story.
 */
const RED_ZONE_WEIGHT = 0.5;
const RED_ZONE_CLAMP = [0.5, 2.0];

/* Matchup factors are clamped after regression. With nine games the
 * regression alone pulls a 1.4 down to 1.2, so these fire only on an outlier,
 * and an outlier in a ten-game defensive sample is usually a schedule
 * artefact rather than a defence.
 */
const MATCHUP_CLAMP = [0.78, 1.28];
const MATCHUP_TD_CLAMP = [0.7, 1.4];

/* Spread of the per-touch yardage, as a coefficient of variation. Used only
 * by the simulation in js/lineup.js, and carried here so the floor and
 * ceiling come from the same file as the median.
 *
 * These are the shapes of the distributions rather than fitted values: a
 * catch is a mean of 12 yards with a long right tail, a carry is 4.5 with a
 * longer one, and a completion is the steadiest of the three because a
 * quarterback's game is 30 of them averaged together.
 */
export const YARD_SPREAD = { rec: 1.0, rush: 1.15, pass: 0.75 };

/* Points a team scores per offensive touchdown, if the season says nothing.
 * Calibrated off the season itself where there is one — see tdsPerPoint.
 */
const FALLBACK_POINTS_PER_TD = 9.4;

/* Kicking. Field goal attempts rise with a team's implied total but far less
 * than proportionally: a team expected to score 30 is in range more often but
 * is also scoring touchdowns from there instead.
 */
const FGA_ELASTICITY = 0.5;
const XP_PER_TD = 0.94;

/* How far a game's actual points land from its implied total. Nine and a half
 * points: a total is a good forecast of a game and a poor one of an afternoon.
 * The defensive projection is mostly this number — points allowed is what a
 * fantasy defence is scored on, and it is the least predictable thing on the
 * board.
 */
export const POINTS_ALLOWED_SPREAD = 9.5;

// Positions worth projecting. FB is folded into RB: Sleeper lists a handful
// and they are used as backs when they are used at all.
export const PROJECTED = ["QB", "RB", "WR", "TE", "K", "DEF"];

export function normalizePosition(position) {
  return position === "FB" ? "RB" : position;
}

/* How likely a player is to play at all, from the injury tag his last row
 * carried.
 *
 * It lives here rather than next to the lineup because the volume
 * normalisation below needs it: a receiver who is out does not take his
 * targets with him, and the only way his team-mates can be credited with them
 * is for the model to know he is not going to be there.
 *
 * Questionable is left alone on purpose. Most questionable players play, the
 * tag says nothing about how well, and discounting it would quietly shave
 * half a roster in November. It is flagged on the row instead, which is where
 * a decision about it belongs.
 */
export const PLAY_PROBABILITY = {
  Out: 0, IR: 0, "Injured Reserve": 0, PUP: 0, Suspended: 0, NA: 0, DNR: 0,
  Doubtful: 0.25, Questionable: 1, Probable: 1,
};

export function playProbability(injuryStatus) {
  if (!injuryStatus) return 1;
  return PLAY_PROBABILITY[injuryStatus] ?? 1;
}

// Which defensive bucket a player's receiving work falls in. Position only:
// the slot proxy the handoff leaves for later would split WR in two, and
// without it a slot receiver reads as a receiver, which is most of the way
// there.
const RECEIVING_BUCKET = { WR: "WR", TE: "TE", RB: "RB_rec" };

// --------------------------------------------------------------- small math

const sum = (values) => values.reduce((a, b) => a + b, 0);

/* A rate, regressed toward a prior by how many chances it was measured over.
 *
 * `(seen + prior × k) / (chances + k)` — the conjugate form, which is the
 * same arithmetic as "pretend the prior arrived as k chances of its own". At
 * chances = k it is a straight half-and-half blend, which is what makes k
 * readable: it is the sample size at which a player starts to outweigh his
 * position.
 */
export function shrink(seen, chances, prior, k) {
  if (!Number.isFinite(prior)) prior = 0;
  return (seen + prior * k) / (chances + k);
}

/* Recency weights over a list of games, oldest first.
 *
 * Rescaled to sum to the number of games, so a weighted numerator and
 * denominator still carry an honest sample size into `shrink`. Weight the
 * games and leave it there and six games of evidence counts as three, which
 * would regress every player halfway to his position for no reason.
 */
export function formWeights(count, halfLife = FORM_HALF_LIFE) {
  if (count <= 0) return [];
  const raw = Array.from({ length: count }, (_, i) => 0.5 ** ((count - 1 - i) / halfLife));
  const scale = count / sum(raw);
  return raw.map((w) => w * scale);
}

/* A recency-weighted ratio over games: Σw·num / Σw·den, with both halves
 * returned so the caller can regress it. `den` of zero contributes nothing
 * rather than infinity.
 */
export function form(games, num, den, halfLife = FORM_HALF_LIFE) {
  const window = games.slice(-FORM_WINDOW);
  const weights = formWeights(window.length, halfLife);
  let seen = 0;
  let chances = 0;
  window.forEach((game, i) => {
    const d = den(game);
    if (!Number.isFinite(d) || d <= 0) return;
    seen += weights[i] * (num(game) || 0);
    chances += weights[i] * d;
  });
  return { seen, chances };
}

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

/* A matchup factor: a ratio of allowed to expected, pulled toward neutral by
 * how many games of defence it was measured over, then clamped.
 */
function matchupFactor(allowed, expected, games, bounds = MATCHUP_CLAMP) {
  if (!(expected > 0)) return 1;
  const weight = games / (games + K.defence);
  return clamp(1 + (allowed / expected - 1) * weight, bounds);
}

const round = (value, places = 3) => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const stat = (row, key) => row.stats?.[key] ?? 0;

// -------------------------------------------------------- the season so far

/* Every completed game, grouped three ways: by player, by offence, by defence.
 *
 * `weeks` is [{week, rows}] with one row per player per game, each row
 * carrying the team he played for that week and who he played — so a traded
 * player's early games are attributed to the offence he was actually in, which
 * a current-roster join would get wrong.
 */
export function readSeason(weeks, games) {
  const byTeam = new Map();     // team -> week -> offensive totals
  const byPlayer = new Map();   // player_id -> [{week, team, opponent, stats, player}]
  const scores = new Map();     // team -> week -> {scored, allowed}

  for (const game of games) {
    if (!Number.isFinite(game.homeScore) || !Number.isFinite(game.awayScore)) continue;
    if (!scores.has(game.home)) scores.set(game.home, new Map());
    if (!scores.has(game.away)) scores.set(game.away, new Map());
    scores.get(game.home).set(game.week, { scored: game.homeScore, allowed: game.awayScore });
    scores.get(game.away).set(game.week, { scored: game.awayScore, allowed: game.homeScore });
  }

  for (const { week, rows } of weeks) {
    for (const row of rows) {
      if (!row.team || !row.player_id) continue;
      const position = normalizePosition(row.position);

      if (!byTeam.has(row.team)) byTeam.set(row.team, new Map());
      const teamWeeks = byTeam.get(row.team);
      if (!teamWeeks.has(week)) {
        teamWeeks.set(week, {
          week, opponent: row.opponent ?? null, plays: 0, passAtt: 0, rushAtt: 0,
          sacks: 0, rzTargets: 0, rzCarries: 0, recTd: 0, rushTd: 0, yards: 0,
        });
      }
      const team = teamWeeks.get(week);
      // Every player on a team shares the team's snap count, so the largest
      // is the team's — a player who came on late reports fewer.
      team.plays = Math.max(team.plays, stat(row, "tm_off_snp"));
      team.passAtt += stat(row, "pass_att");
      team.rushAtt += stat(row, "rush_att");
      team.rzTargets += stat(row, "rec_rz_tgt");
      team.rzCarries += stat(row, "rush_rz_att");
      team.recTd += stat(row, "rec_td");
      team.rushTd += stat(row, "rush_td");
      // Passing plus rushing, never receiving: rec_yd is the same yardage as
      // pass_yd seen from the other end, and adding both doubles the offence.
      team.yards += stat(row, "pass_yd") + stat(row, "rush_yd");

      // A defence's sack total is the offence's sacks allowed, and the only
      // place a dropback's missing half is written down.
      if (position === "DEF" && row.opponent) {
        if (!byTeam.has(row.opponent)) byTeam.set(row.opponent, new Map());
        const them = byTeam.get(row.opponent);
        if (!them.has(week)) {
          them.set(week, {
            week, opponent: row.team, plays: 0, passAtt: 0, rushAtt: 0,
            sacks: 0, rzTargets: 0, rzCarries: 0, recTd: 0, rushTd: 0, yards: 0,
          });
        }
        them.get(week).sacks += stat(row, "sack");
      }

      if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, []);
      byPlayer.get(row.player_id).push({ ...row, week, position });
    }
  }

  // Derived per-team-week figures everything downstream reads.
  for (const weeksOf of byTeam.values()) {
    for (const team of weeksOf.values()) {
      team.dropbacks = team.passAtt + team.sacks;
      team.snaps = team.dropbacks + team.rushAtt;
      team.passRate = team.snaps > 0 ? team.dropbacks / team.snaps : 0.57;
    }
  }

  return { byTeam, byPlayer, scores };
}

/* League averages, by position, over everything that has happened.
 *
 * These are the priors every player is regressed toward, so they are weighted
 * by volume rather than averaged per player: a position's catch rate is the
 * catch rate of its targets, not the mean of four hundred players' own.
 */
export function leagueRates(weeks, byTeam, scores) {
  const totals = {};
  const bump = (position, key, value) => {
    const row = (totals[position] ??= {});
    row[key] = (row[key] ?? 0) + (value || 0);
  };

  let points = 0;
  let offensiveTds = 0;
  let sacks = 0;
  let dropbacks = 0;
  const teamGames = [];

  for (const { rows } of weeks) {
    for (const row of rows) {
      const position = normalizePosition(row.position);
      if (!PROJECTED.includes(position)) continue;
      for (const key of [
        "rec_tgt", "rec", "rec_yd", "rec_td", "rec_rz_tgt", "rec_fd",
        "rush_att", "rush_yd", "rush_td", "rush_rz_att", "rush_fd",
        "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_fd",
        "fum_lost", "fga", "fgm", "xpa", "xpm", "sack", "int", "fum_rec",
        "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50_59", "fgm_50p", "ff",
      ]) bump(position, key, stat(row, key));
      if (position === "DEF") {
        // `td` on a defensive row is touchdowns ALLOWED — it averages 2.6 a
        // game, which is the other team's scoring, not this one's. The two
        // keys a defence is actually credited for are def_td (a pick-six or a
        // fumble returned) and def_st_td (a return touchdown), and together
        // they happen about once every eleven games. Reading `td` as a
        // defensive score put fourteen points a week on every defence.
        bump(position, "def_td", stat(row, "def_td"));
        bump(position, "def_st_td", stat(row, "def_st_td"));
      }
      bump(position, "games", stat(row, "gp") > 0 ? 1 : 0);
    }
  }

  for (const [team, weeksOf] of byTeam) {
    for (const game of weeksOf.values()) {
      if (!(game.snaps > 0)) continue;
      teamGames.push(game);
      sacks += game.sacks;
      dropbacks += game.dropbacks;
      offensiveTds += game.recTd + game.rushTd;
      points += scores.get(team)?.get(game.week)?.scored ?? 0;
    }
  }

  const rate = (position, num, den, fallback) => {
    const row = totals[position] ?? {};
    return row[den] > 0 ? row[num] / row[den] : fallback;
  };

  const teamSnaps = teamGames.length ? sum(teamGames.map((g) => g.snaps)) / teamGames.length : 61;
  const teamYards = teamGames.length ? sum(teamGames.map((g) => g.yards)) / teamGames.length : 335;
  const teamDropbacks = teamGames.length ? sum(teamGames.map((g) => g.dropbacks)) / teamGames.length : 35;
  const teamTds = teamGames.length ? offensiveTds / teamGames.length : 2.4;

  let allTargets = 0;
  let allAttempts = 0;
  for (const { rows } of weeks) {
    for (const row of rows) {
      allTargets += stat(row, "rec_tgt");
      allAttempts += stat(row, "pass_att");
    }
  }

  const receiving = (position) => ({
    catchRate: rate(position, "rec", "rec_tgt", 0.65),
    yardsPerCatch: rate(position, "rec_yd", "rec", 11),
    recTdPerTarget: rate(position, "rec_td", "rec_tgt", 0.05),
    rzTargetShare: rate(position, "rec_rz_tgt", "rec_tgt", 0.1),
    firstDownPerCatch: rate(position, "rec_fd", "rec", 0.5),
    yardsPerCarry: rate(position, "rush_yd", "rush_att", 4.2),
    rushTdPerCarry: rate(position, "rush_td", "rush_att", 0.03),
    rzCarryShare: rate(position, "rush_rz_att", "rush_att", 0.1),
    firstDownPerCarry: rate(position, "rush_fd", "rush_att", 0.2),
    fumblesPerTouch: rate(position, "fum_lost", "rec", 0.01),
  });

  return {
    teamSnaps,
    teamYards,
    teamDropbacks,
    // A dropback is a pass attempt or a sack, and only one of them is a
    // target. Turning expected dropbacks into expected targets needs this.
    sackRate: dropbacks > 0 ? sacks / dropbacks : 0.065,
    // And an attempt is not quite a target either: a throwaway, a spike and a
    // ball batted down at the line are all attempts nobody was credited for.
    // Measured over 2026 weeks 1-9 it is 0.953, which is a 5% error in every
    // team's target total if it is assumed away.
    targetsPerAttempt: allAttempts > 0 ? allTargets / allAttempts : 0.95,
    teamPassRate: teamSnaps > 0 ? teamDropbacks / teamSnaps : 0.57,
    teamTds,
    // Touchdowns a team scores per point it scores, calibrated off this
    // season rather than assumed. Its inverse is "points per touchdown",
    // which is what turns an implied total into expected touchdowns.
    tdsPerPoint: points > 0 ? offensiveTds / points : 1 / FALLBACK_POINTS_PER_TD,
    pointsPerGame: teamGames.length ? points / teamGames.length : 22.5,
    QB: {
      cmpRate: rate("QB", "pass_cmp", "pass_att", 0.65),
      yardsPerCompletion: rate("QB", "pass_yd", "pass_cmp", 11.4),
      passTdPerAttempt: rate("QB", "pass_td", "pass_att", 0.045),
      intPerAttempt: rate("QB", "pass_int", "pass_att", 0.025),
      firstDownPerCompletion: rate("QB", "pass_fd", "pass_cmp", 0.52),
      yardsPerCarry: rate("QB", "rush_yd", "rush_att", 4.6),
      rushTdPerCarry: rate("QB", "rush_td", "rush_att", 0.05),
      fumblesPerAttempt: rate("QB", "fum_lost", "pass_att", 0.008),
    },
    RB: receiving("RB"),
    WR: receiving("WR"),
    TE: receiving("TE"),
    K: {
      fgaPerGame: rate("K", "fga", "games", 1.9),
      fgRate: rate("K", "fgm", "fga", 0.84),
      xpRate: rate("K", "xpm", "xpa", 0.96),
      /* Where made field goals land, so a league that pays by distance gets
       * something to pay on. Disjoint bands, because the draw deals a made
       * kick into exactly one of them — `fgm_50p` is the same kicks as
       * `fgm_50_59` seen under another name (Sleeper reports no made kick
       * from 60 or beyond), so it is derived afterwards rather than being a
       * fifth band that would make the shares add to more than one.
       */
      distance: {
        fgm_20_29: rate("K", "fgm_20_29", "fgm", 0.26),
        fgm_30_39: rate("K", "fgm_30_39", "fgm", 0.28),
        fgm_40_49: rate("K", "fgm_40_49", "fgm", 0.27),
        fgm_50_59: rate("K", "fgm_50_59", "fgm", 0.19),
      },
    },
    DEF: {
      sackPerGame: rate("DEF", "sack", "games", 2.3),
      intPerGame: rate("DEF", "int", "games", 0.7),
      fumRecPerGame: rate("DEF", "fum_rec", "games", 0.6),
      ffPerGame: rate("DEF", "ff", "games", 2.2),
      defTdPerGame: rate("DEF", "def_td", "games", 0.06),
      stTdPerGame: rate("DEF", "def_st_td", "games", 0.03),
    },
  };
}

// --------------------------------------------------------------- the defence

/* What each defence has allowed, per opportunity, against what the offences
 * that faced it normally produce.
 *
 * Per target rather than per game, because a defence that faces 40 dropbacks
 * a week allows more of everything without being any worse at football. And
 * schedule-adjusted, because eight games against the two worst offences in
 * the league is the most common way a defence looks elite: for every game,
 * what the offence it played would have been expected to do is the
 * denominator, so a defence is measured against its own schedule rather than
 * against the league.
 *
 * Three factors per bucket, because they apply in different places: volume to
 * the targets, efficiency to the yards, and touchdowns to the touchdowns.
 */
export function defenceFactors(weeks, byTeam, league) {
  const BUCKETS = ["WR", "TE", "RB_rec", "RB_rush", "QB_pass"];

  // First, what each offence does per opportunity across the season. This is
  // the "what those opponents normally produce" half of the adjustment.
  const offence = new Map();
  const defence = new Map();
  const blank = () => Object.fromEntries(BUCKETS.map((b) => [b, {
    chances: 0, yards: 0, tds: 0, dropbacks: 0, rushes: 0,
  }]));

  const bucketOf = (row) => {
    const position = normalizePosition(row.position);
    if (position === "QB") return null;
    return RECEIVING_BUCKET[position] ?? null;
  };

  for (const { week, rows } of weeks) {
    for (const row of rows) {
      if (!row.team || !row.opponent) continue;
      const position = normalizePosition(row.position);
      const teamGame = byTeam.get(row.team)?.get(week);
      if (!teamGame || !(teamGame.snaps > 0)) continue;

      if (!offence.has(row.team)) offence.set(row.team, blank());
      if (!defence.has(row.opponent)) defence.set(row.opponent, blank());
      const off = offence.get(row.team);
      const def = defence.get(row.opponent);

      const bucket = bucketOf(row);
      if (bucket) {
        for (const side of [off, def]) {
          side[bucket].chances += stat(row, "rec_tgt");
          side[bucket].yards += stat(row, "rec_yd");
          side[bucket].tds += stat(row, "rec_td");
        }
      }
      if (position === "RB") {
        for (const side of [off, def]) {
          side.RB_rush.chances += stat(row, "rush_att");
          side.RB_rush.yards += stat(row, "rush_yd");
          side.RB_rush.tds += stat(row, "rush_td");
        }
      }
      if (position === "QB") {
        for (const side of [off, def]) {
          side.QB_pass.chances += stat(row, "pass_att");
          side.QB_pass.yards += stat(row, "pass_yd");
          side.QB_pass.tds += stat(row, "pass_td");
        }
      }
    }
  }

  // The opportunity counts each bucket's chances are measured against: pass
  // buckets per dropback, the rushing bucket per rush attempt.
  const exposure = new Map();
  for (const [team, weeksOf] of byTeam) {
    let dropbacks = 0;
    let rushes = 0;
    let games = 0;
    const faced = [];
    for (const game of weeksOf.values()) {
      if (!(game.snaps > 0)) continue;
      dropbacks += game.dropbacks;
      rushes += game.rushAtt;
      games += 1;
      if (game.opponent) faced.push({ opponent: game.opponent, dropbacks: game.dropbacks, rushes: game.rushAtt });
    }
    exposure.set(team, { dropbacks, rushes, games, faced });
  }

  const denominatorFor = (bucket) => (bucket === "RB_rush" ? "rushes" : "dropbacks");

  // Each offence's rate per opportunity — the expectation a defence's own
  // games are compared against.
  const offenceRate = new Map();
  for (const [team, buckets] of offence) {
    const seen = exposure.get(team) ?? { dropbacks: 0, rushes: 0 };
    const rates = {};
    for (const bucket of BUCKETS) {
      const chances = buckets[bucket].chances;
      const opportunities = seen[denominatorFor(bucket)];
      rates[bucket] = {
        perOpportunity: opportunities > 0 ? chances / opportunities : 0,
        yardsPerChance: chances > 0 ? buckets[bucket].yards / chances : 0,
        tdsPerChance: chances > 0 ? buckets[bucket].tds / chances : 0,
      };
    }
    offenceRate.set(team, rates);
  }

  // League rates, as the fallback for an offence with nothing to say yet.
  const leagueBucket = {};
  for (const bucket of BUCKETS) {
    let chances = 0;
    let yards = 0;
    let tds = 0;
    let opportunities = 0;
    for (const [team, buckets] of offence) {
      chances += buckets[bucket].chances;
      yards += buckets[bucket].yards;
      tds += buckets[bucket].tds;
      opportunities += exposure.get(team)?.[denominatorFor(bucket)] ?? 0;
    }
    leagueBucket[bucket] = {
      perOpportunity: opportunities > 0 ? chances / opportunities : 0,
      yardsPerChance: chances > 0 ? yards / chances : 0,
      tdsPerChance: chances > 0 ? tds / chances : 0,
    };
  }

  // Now the defences, each measured against the offences it actually played.
  const out = {};
  for (const [team, buckets] of defence) {
    const schedule = [];
    for (const [other, weeksOf] of byTeam) {
      for (const game of weeksOf.values()) {
        if (game.opponent === team && game.snaps > 0) {
          schedule.push({ offence: other, dropbacks: game.dropbacks, rushes: game.rushAtt });
        }
      }
    }

    const games = schedule.length;
    const factors = { games };
    for (const bucket of BUCKETS) {
      let expectedChances = 0;
      for (const game of schedule) {
        const rates = offenceRate.get(game.offence)?.[bucket] ?? leagueBucket[bucket];
        expectedChances += rates.perOpportunity * game[denominatorFor(bucket)];
      }
      const allowed = buckets[bucket];

      // Yards and touchdowns are compared per chance actually allowed, so a
      // defence that gave up few targets is not credited twice.
      let expectedYards = 0;
      let expectedTds = 0;
      for (const game of schedule) {
        const rates = offenceRate.get(game.offence)?.[bucket] ?? leagueBucket[bucket];
        const share = expectedChances > 0
          ? (rates.perOpportunity * game[denominatorFor(bucket)]) / expectedChances
          : 0;
        expectedYards += share * allowed.chances * (rates.yardsPerChance || leagueBucket[bucket].yardsPerChance);
        expectedTds += share * allowed.chances * (rates.tdsPerChance || leagueBucket[bucket].tdsPerChance);
      }

      factors[bucket] = {
        volume: round(matchupFactor(allowed.chances, expectedChances, games)),
        efficiency: round(matchupFactor(allowed.yards, expectedYards, games)),
        td: round(matchupFactor(allowed.tds, expectedTds, games, MATCHUP_TD_CLAMP)),
      };
    }
    out[team] = factors;
  }

  // A defence with no games at all reads as perfectly average rather than as
  // missing, so a week-1 bundle still projects.
  return { factors: out, neutral: Object.fromEntries(
    BUCKETS.map((b) => [b, { volume: 1, efficiency: 1, td: 1 }]).concat([["games", 0]]),
  ) };
}

// ------------------------------------------------------------ team volume

/* What an offence is expected to run in one game, and how much of it it is
 * expected to score.
 *
 * Pace from its own season, regressed to the league after four games. The
 * split between throwing and running from its own season too, then moved by
 * the spread: a team expected to trail throws more, and nothing else about
 * the game is known as early or as reliably as which way it is going.
 *
 * The implied total is the spread and the total rearranged — half the total
 * each, then the spread split between them — and it is the single most useful
 * number on the page. Expected touchdowns follow from it at the rate this
 * season has actually been scoring them.
 */
export function teamVolume(teamGames, game, league) {
  const played = [...teamGames.values()].filter((g) => g.snaps > 0).sort((a, b) => a.week - b.week);
  const window = played.slice(-FORM_WINDOW);
  const weights = formWeights(window.length, FORM_HALF_LIFE);

  let snaps = 0;
  let dropbacks = 0;
  let weight = 0;
  window.forEach((g, i) => {
    snaps += weights[i] * g.snaps;
    dropbacks += weights[i] * g.dropbacks;
    weight += weights[i];
  });

  const games = window.length;
  const ownSnaps = weight > 0 ? snaps / weight : league.teamSnaps;
  const ownPassRate = snaps > 0 ? dropbacks / snaps : league.teamPassRate;
  const pace = shrink(ownSnaps * games, games, league.teamSnaps, K.teamPace);
  const basePassRate = shrink(ownPassRate * games, games, league.teamPassRate, K.teamPace);

  // Positive margin means favoured, and a favoured team throws less.
  const margin = game.implied - game.impliedAgainst;
  const script = clamp(-PASS_RATE_PER_POINT * margin, [-PASS_RATE_CAP, PASS_RATE_CAP]);
  const passRate = clamp(basePassRate + script, [0.3, 0.8]);

  const tds = game.implied * league.tdsPerPoint;

  return {
    games,
    plays: pace,
    passRate,
    basePassRate,
    script,
    dropbacks: pace * passRate,
    rushes: pace * (1 - passRate),
    implied: game.implied,
    impliedAgainst: game.impliedAgainst,
    spread: game.spread,
    total: game.total,
    tds,
    // Everything touchdown-shaped is scaled by how much this offence is
    // expected to score against how much an offence scores, so a 31-point
    // favourite's receivers all tick up together.
    scoring: league.teamTds > 0 ? tds / league.teamTds : 1,
  };
}

// --------------------------------------------------------- a player's week

/* One skill player's projected line.
 *
 * The decomposition is the whole point, and it is why the parts come back
 * alongside the line: expected targets is dropbacks × snap share × targets
 * per pass snap, and each of those three is a different claim that can be
 * wrong on its own. A page that prints only the total can tell you a receiver
 * is worth nine points; one that prints the parts can tell you it is because
 * his snap share halved.
 *
 * Targets per *pass* snap rather than per snap, so a tight end who blocks on
 * half his snaps is discounted by measurement rather than by a special case:
 * his pass snaps are fewer and his rate per pass snap is unremarkable.
 */
function projectSkill(games, position, team, volume, matchup, league) {
  const prior = league[position] ?? league.WR;
  const weighted = (num, den) => form(games, num, den);

  const snaps = weighted((g) => stat(g, "off_snp"), (g) => stat(g, "tm_off_snp"));
  const snapShare = snaps.chances > 0 ? snaps.seen / snaps.chances : 0;

  // A game's pass snaps are its snaps split by the team's pass rate that
  // week — the closest thing to participation data that a free source has.
  const passSnaps = weighted(
    (g) => stat(g, "rec_tgt"),
    (g) => stat(g, "off_snp") * (g.teamPassRate ?? league.teamPassRate),
  );
  const targetsPerPassSnap = passSnaps.chances > 0 ? passSnaps.seen / passSnaps.chances : 0;

  const runSnaps = weighted(
    (g) => stat(g, "rush_att"),
    (g) => stat(g, "off_snp") * (1 - (g.teamPassRate ?? league.teamPassRate)),
  );
  const carriesPerRunSnap = runSnaps.chances > 0 ? runSnaps.seen / runSnaps.chances : 0;

  const bucket = RECEIVING_BUCKET[position] ?? "WR";
  const recMatchup = matchup[bucket] ?? { volume: 1, efficiency: 1, td: 1 };
  const rushMatchup = matchup.RB_rush ?? { volume: 1, efficiency: 1, td: 1 };

  const passSnapsExpected = volume.dropbacks * snapShare;
  const runSnapsExpected = volume.rushes * snapShare;
  const targets = passSnapsExpected * targetsPerPassSnap * recMatchup.volume;
  const carries = runSnapsExpected * carriesPerRunSnap * rushMatchup.volume;

  // Efficiency: his own, blended with his position's by how much of it there
  // has been to look at.
  const catches = weighted((g) => stat(g, "rec"), (g) => stat(g, "rec_tgt"));
  const catchRate = Math.min(0.95, shrink(catches.seen, catches.chances, prior.catchRate, K.catchRate));

  const recYards = weighted((g) => stat(g, "rec_yd"), (g) => stat(g, "rec"));
  const yardsPerCatch = shrink(recYards.seen, recYards.chances, prior.yardsPerCatch, K.yardsPerCatch)
    * recMatchup.efficiency;

  const rushYards = weighted((g) => stat(g, "rush_yd"), (g) => stat(g, "rush_att"));
  const yardsPerCarry = shrink(rushYards.seen, rushYards.chances, prior.yardsPerCarry, K.yardsPerCarry)
    * rushMatchup.efficiency;

  /* Touchdowns, the part most worth regressing and least worth trusting.
   *
   * The base rate is his own per target, pulled hard toward his position's.
   * Red-zone share nudges it: the ratio of how often his targets come inside
   * the twenty to how often a target does, at half weight and clamped, so a
   * goal-line tight end is credited for it without a two-week run of red-zone
   * looks deciding his season. Then the team's expected scoring scales it, so
   * everyone in a 31-point favourite ticks up together.
   */
  const redZone = (ownNum, ownDen, priorShare) => {
    const seen = weighted(ownNum, ownDen);
    if (!(seen.chances > 0) || !(priorShare > 0)) return 1;
    const ratio = shrink(seen.seen, seen.chances, priorShare, K.firstDowns) / priorShare;
    return 1 + RED_ZONE_WEIGHT * (clamp(ratio, RED_ZONE_CLAMP) - 1);
  };

  const recTds = weighted((g) => stat(g, "rec_td"), (g) => stat(g, "rec_tgt"));
  const recTdPerTarget = shrink(recTds.seen, recTds.chances, prior.recTdPerTarget, K.recTdPerTarget)
    * redZone((g) => stat(g, "rec_rz_tgt"), (g) => stat(g, "rec_tgt"), prior.rzTargetShare)
    * recMatchup.td;

  const rushTds = weighted((g) => stat(g, "rush_td"), (g) => stat(g, "rush_att"));
  const rushTdPerCarry = shrink(rushTds.seen, rushTds.chances, prior.rushTdPerCarry, K.rushTdPerCarry)
    * redZone((g) => stat(g, "rush_rz_att"), (g) => stat(g, "rush_att"), prior.rzCarryShare)
    * rushMatchup.td;

  const recFd = weighted((g) => stat(g, "rec_fd"), (g) => stat(g, "rec"));
  const rushFd = weighted((g) => stat(g, "rush_fd"), (g) => stat(g, "rush_att"));
  const fumbles = weighted(
    (g) => stat(g, "fum_lost"),
    (g) => stat(g, "rec") + stat(g, "rush_att"),
  );

  const draw = {
    targets,
    catchRate,
    yardsPerCatch,
    recTdPerTarget,
    carries,
    yardsPerCarry,
    rushTdPerCarry,
    firstDownPerCatch: shrink(recFd.seen, recFd.chances, prior.firstDownPerCatch, K.firstDowns),
    firstDownPerCarry: shrink(rushFd.seen, rushFd.chances, prior.firstDownPerCarry, K.firstDowns),
    fumblesPerTouch: shrink(fumbles.seen, fumbles.chances, prior.fumblesPerTouch, K.fumbles),
  };

  const parts = {
    dropbacks: volume.dropbacks,
    rushes: volume.rushes,
    snap_share: snapShare,
    targets_per_pass_snap: targetsPerPassSnap,
    carries_per_run_snap: carriesPerRunSnap,
    targets,
    carries,
    catch_rate: catchRate,
    yards_per_target: catchRate * yardsPerCatch,
    yards_per_carry: yardsPerCarry,
    implied: volume.implied,
    team_tds: volume.tds,
    matchup_volume: recMatchup.volume,
    matchup_efficiency: recMatchup.efficiency,
    matchup_td: recMatchup.td,
    matchup_rush_volume: rushMatchup.volume,
    matchup_rush_efficiency: rushMatchup.efficiency,
    matchup_games: matchup.games ?? 0,
  };

  return { draw, parts };
}

/* A quarterback's week.
 *
 * His share of the team's attempts rather than a snap share, because a backup
 * who played a quarter of the snaps threw a quarter of the passes and the
 * snap count adds nothing. Sacks come out of the dropbacks before the
 * attempts do, since a dropback is an attempt or a sack and only one of them
 * is worth fantasy points.
 *
 * The defensive volume factor is deliberately not applied to his attempts. How
 * often a team throws is the offence's decision and the scoreboard's, both of
 * which are already in the game script above; a defence that has faced a lot
 * of passes mostly faced teams that were behind.
 */
function projectQb(games, team, volume, matchup, league) {
  const prior = league.QB;
  const weighted = (num, den) => form(games, num, den);
  const pass = matchup.QB_pass ?? { volume: 1, efficiency: 1, td: 1 };
  const rush = matchup.RB_rush ?? { volume: 1, efficiency: 1, td: 1 };

  const share = weighted((g) => stat(g, "pass_att"), (g) => g.teamPassAtt ?? 0);
  const attemptShare = share.chances > 0 ? Math.min(1, share.seen / share.chances) : 0;

  const sacks = weighted((g) => g.teamSacks ?? 0, (g) => g.teamDropbacks ?? 0);
  const sackRate = Math.min(0.15, shrink(sacks.seen, sacks.chances, 0.065, 40));

  const attempts = volume.dropbacks * (1 - sackRate) * attemptShare;

  const completions = weighted((g) => stat(g, "pass_cmp"), (g) => stat(g, "pass_att"));
  const cmpRate = Math.min(0.85, shrink(completions.seen, completions.chances, prior.cmpRate, K.cmpRate));

  const yards = weighted((g) => stat(g, "pass_yd"), (g) => stat(g, "pass_cmp"));
  const yardsPerCompletion = shrink(yards.seen, yards.chances, prior.yardsPerCompletion, K.yardsPerCompletion)
    * pass.efficiency;

  const tds = weighted((g) => stat(g, "pass_td"), (g) => stat(g, "pass_att"));
  const passTdPerAttempt = shrink(tds.seen, tds.chances, prior.passTdPerAttempt, K.passTdPerAttempt)
    * pass.td;

  const ints = weighted((g) => stat(g, "pass_int"), (g) => stat(g, "pass_att"));
  const intPerAttempt = shrink(ints.seen, ints.chances, prior.intPerAttempt, K.intPerAttempt);

  const carriesForm = weighted((g) => stat(g, "rush_att"), (g) => g.teamRushAtt ?? 0);
  const carryShare = carriesForm.chances > 0 ? carriesForm.seen / carriesForm.chances : 0;
  const carries = volume.rushes * carryShare;

  const rushYards = weighted((g) => stat(g, "rush_yd"), (g) => stat(g, "rush_att"));
  const rushTds = weighted((g) => stat(g, "rush_td"), (g) => stat(g, "rush_att"));
  const fd = weighted((g) => stat(g, "pass_fd"), (g) => stat(g, "pass_cmp"));
  const fumbles = weighted((g) => stat(g, "fum_lost"), (g) => stat(g, "pass_att"));

  const draw = {
    attempts,
    cmpRate,
    yardsPerCompletion,
    passTdPerAttempt,
    intPerAttempt,
    carries,
    yardsPerCarry: shrink(rushYards.seen, rushYards.chances, prior.yardsPerCarry, K.yardsPerCarry)
      * rush.efficiency,
    rushTdPerCarry: shrink(rushTds.seen, rushTds.chances, prior.rushTdPerCarry, K.rushTdPerCarry)
      * rush.td,
    firstDownPerCompletion: shrink(fd.seen, fd.chances, prior.firstDownPerCompletion, K.firstDowns),
    fumblesPerAttempt: shrink(fumbles.seen, fumbles.chances, prior.fumblesPerAttempt, K.fumbles),
  };

  const parts = {
    dropbacks: volume.dropbacks,
    attempt_share: attemptShare,
    sack_rate: sackRate,
    attempts,
    cmp_rate: cmpRate,
    yards_per_attempt: cmpRate * yardsPerCompletion,
    carries,
    implied: volume.implied,
    team_tds: volume.tds,
    matchup_efficiency: pass.efficiency,
    matchup_td: pass.td,
    matchup_games: matchup.games ?? 0,
  };

  return { draw, parts };
}

/* A kicker's week: extra points follow the touchdowns, field goals follow the
 * implied total but far less than one for one — a team that is expected to
 * score more is in range more often and is also scoring touchdowns from
 * there instead, so the elasticity is a half rather than a one.
 */
function projectKicker(games, volume, league) {
  const prior = league.K;
  const weighted = (num, den) => form(games, num, den);
  const made = weighted((g) => stat(g, "fgm"), (g) => stat(g, "fga"));
  const fgRate = Math.min(0.98, shrink(made.seen, made.chances, prior.fgRate, K.kickRate));

  const attempts = prior.fgaPerGame
    * (league.pointsPerGame > 0 ? (volume.implied / league.pointsPerGame) ** FGA_ELASTICITY : 1);

  return {
    draw: {
      fga: attempts,
      fgRate,
      xpa: volume.tds * XP_PER_TD,
      xpRate: prior.xpRate,
      distance: prior.distance,
    },
    parts: {
      implied: volume.implied,
      team_tds: volume.tds,
      fga: attempts,
      fg_rate: fgRate,
    },
  };
}

/* A defence's week, which is mostly one number: what the other team scores.
 *
 * Points allowed is both the biggest slice of a fantasy defence's score and
 * the least predictable thing on the board, so it is projected straight from
 * the opponent's implied total and simulated with a nine-and-a-half point
 * spread around it. Sacks and takeaways are the unit's own recent rates,
 * regressed, and they move the score far less than one bad quarter does.
 */
/* How many yards an offence is expected to put up, for the defence on the
 * other side of it. Its own recent form, regressed to the league — nothing
 * about the spread, because a team that is behind throws more and gains more
 * yards while scoring fewer points, and the two pull in opposite directions.
 */
export function teamYardsPerGame(teamGames, league) {
  const played = [...teamGames.values()].filter((g) => g.snaps > 0).sort((a, b) => a.week - b.week);
  const window = played.slice(-FORM_WINDOW);
  const weights = formWeights(window.length, FORM_HALF_LIFE);
  let yards = 0;
  let weight = 0;
  window.forEach((g, i) => { yards += weights[i] * g.yards; weight += weights[i]; });
  const own = weight > 0 ? yards / weight : league.teamYards;
  return shrink(own * window.length, window.length, league.teamYards, K.teamPace);
}

/* How far a game's yardage lands from its forecast. Seventy-five yards: a
 * yardage band is three hundred points of this distribution wide, so getting
 * the spread roughly right matters more than getting the centre exactly so.
 */
const YARDS_ALLOWED_SPREAD = 75;

/* The chance a defence's yards allowed lands in each of Sleeper's bands. Same
 * normal-over-bands arithmetic as the points, and it exists for the same
 * reason: a league that pays by band needs every band's probability, and one
 * that pays per yard needs the mean, and both come out of this.
 */
export function yardsAllowedBuckets({ yardsAllowed, yardsAllowedSpread = YARDS_ALLOWED_SPREAD }) {
  const bands = [
    ["yds_allow_0_100", -Infinity, 100.5],
    ["yds_allow_100_199", 100.5, 199.5],
    ["yds_allow_200_299", 199.5, 299.5],
    ["yds_allow_300_349", 299.5, 349.5],
    ["yds_allow_350_399", 349.5, 399.5],
    ["yds_allow_400_449", 399.5, 449.5],
    ["yds_allow_450_499", 449.5, 499.5],
    ["yds_allow_500_549", 499.5, 549.5],
    ["yds_allow_550p", 549.5, Infinity],
  ];
  const cdf = (x) => (x === Infinity ? 1 : x === -Infinity ? 0
    : 0.5 * (1 + erf((x - yardsAllowed) / (yardsAllowedSpread * Math.SQRT2))));
  return Object.fromEntries(bands.map(([key, low, high]) => [key, Math.max(0, cdf(high) - cdf(low))]));
}

export function yardsAllowedBand(yards) {
  return yards <= 100 ? "yds_allow_0_100"
    : yards <= 199 ? "yds_allow_100_199"
    : yards <= 299 ? "yds_allow_200_299"
    : yards <= 349 ? "yds_allow_300_349"
    : yards <= 399 ? "yds_allow_350_399"
    : yards <= 449 ? "yds_allow_400_449"
    : yards <= 499 ? "yds_allow_450_499"
    : yards <= 549 ? "yds_allow_500_549"
    : "yds_allow_550p";
}

function projectDefence(games, volume, league, yardsAgainst) {
  const prior = league.DEF;
  const played = games.filter((g) => stat(g, "gp") > 0).slice(-FORM_WINDOW);
  const weights = formWeights(played.length, FORM_HALF_LIFE);
  const per = (key, priorValue) => {
    let seen = 0;
    let count = 0;
    played.forEach((g, i) => { seen += weights[i] * stat(g, key); count += weights[i]; });
    return shrink(seen, count, priorValue, 4);
  };

  return {
    draw: {
      pointsAllowed: volume.impliedAgainst,
      pointsAllowedSpread: POINTS_ALLOWED_SPREAD,
      yardsAllowed: yardsAgainst,
      yardsAllowedSpread: YARDS_ALLOWED_SPREAD,
      sack: per("sack", prior.sackPerGame),
      ff: per("ff", prior.ffPerGame),
      int: per("int", prior.intPerGame),
      fumRec: per("fum_rec", prior.fumRecPerGame),
      defTd: per("def_td", prior.defTdPerGame),
      stTd: per("def_st_td", prior.stTdPerGame),
    },
    parts: {
      implied_against: volume.impliedAgainst,
      yards_against: yardsAgainst,
      implied: volume.implied,
      sacks: per("sack", prior.sackPerGame),
      takeaways: per("int", prior.intPerGame) + per("fum_rec", prior.fumRecPerGame),
    },
  };
}

// ----------------------------------------------------------- the stat line

/* The expected stat line for a set of draw parameters.
 *
 * Keyed exactly the way a league's `scoring_settings` is, so js/lineup.js can
 * score it with the league's own numbers and nothing here has to know what a
 * reception is worth. The hundred-yard bonuses are probabilities rather than
 * counts, which is what an expectation of a bonus is.
 */
export function expectedLine(position, draw) {
  if (position === "QB") {
    const completions = draw.attempts * draw.cmpRate;
    const passYards = completions * draw.yardsPerCompletion;
    const rushYards = draw.carries * draw.yardsPerCarry;
    return {
      pass_att: draw.attempts,
      pass_cmp: completions,
      pass_inc: draw.attempts - completions,
      pass_yd: passYards,
      pass_td: draw.attempts * draw.passTdPerAttempt,
      pass_int: draw.attempts * draw.intPerAttempt,
      pass_fd: completions * draw.firstDownPerCompletion,
      // Yardage bonuses are step functions, and a step function has no
      // useful expectation — "0.4 of a 300-yard bonus" is not a thing that
      // happens. They are drawn in the simulation, off the yards it actually
      // rolled, and left at zero in the expected line so nothing reads a
      // fabricated fraction as a projection.
      bonus_pass_yd_300: 0,
      rush_att: draw.carries,
      rush_yd: rushYards,
      rush_td: draw.carries * draw.rushTdPerCarry,
      fum_lost: draw.attempts * draw.fumblesPerAttempt,
    };
  }
  if (position === "K") {
    const made = draw.fga * draw.fgRate;
    const line = {
      fga: draw.fga,
      fgm: made,
      fgmiss: draw.fga - made,
      xpa: draw.xpa,
      xpm: draw.xpa * draw.xpRate,
      xpmiss: draw.xpa * (1 - draw.xpRate),
    };
    for (const [key, share] of Object.entries(draw.distance)) line[key] = made * share;
    line.fgm_50p = line.fgm_50_59 ?? 0;
    return line;
  }
  if (position === "DEF") {
    const line = {
      sack: draw.sack,
      ff: draw.ff,
      int: draw.int,
      fum_rec: draw.fumRec,
      def_td: draw.defTd,
      def_st_td: draw.stTd,
      pts_allow: draw.pointsAllowed,
    };
    // The expected line carries the bucket a league actually scores as the
    // probability of landing in it, which is the honest expectation of a
    // step function. The simulation draws one bucket per game instead.
    for (const [key, probability] of Object.entries(pointsAllowedBuckets(draw))) line[key] = probability;
    for (const [key, probability] of Object.entries(yardsAllowedBuckets(draw))) line[key] = probability;
    line.yds_allow = draw.yardsAllowed;
    return line;
  }

  const receptions = draw.targets * draw.catchRate;
  const recYards = receptions * draw.yardsPerCatch;
  const rushYards = draw.carries * draw.yardsPerCarry;
  return {
    rec_tgt: draw.targets,
    rec: receptions,
    rec_yd: recYards,
    rec_td: draw.targets * draw.recTdPerTarget,
    rec_fd: receptions * draw.firstDownPerCatch,
    // See the note on bonuses in the quarterback branch: drawn, never
    // averaged.
    bonus_rec_yd_100: 0,
    rush_att: draw.carries,
    rush_yd: rushYards,
    rush_td: draw.carries * draw.rushTdPerCarry,
    rush_fd: draw.carries * draw.firstDownPerCarry,
    bonus_rush_yd_100: 0,
    fum_lost: (receptions + draw.carries) * draw.fumblesPerTouch,
  };
}

/* The chance a defence's points allowed lands in each of Sleeper's bands.
 *
 * A normal around the opponent's implied total, integrated over each band.
 * Exported because both the expected line and the simulation need the same
 * bands, and a league that scores `pts_allow_1_6` and one that scores
 * `pts_allow` per point should both get an answer.
 */
export function pointsAllowedBuckets({ pointsAllowed, pointsAllowedSpread = POINTS_ALLOWED_SPREAD }) {
  const bands = [
    ["pts_allow_0", -Infinity, 0.5],
    ["pts_allow_1_6", 0.5, 6.5],
    ["pts_allow_7_13", 6.5, 13.5],
    ["pts_allow_14_20", 13.5, 20.5],
    ["pts_allow_21_27", 20.5, 27.5],
    ["pts_allow_28_34", 27.5, 34.5],
    ["pts_allow_35p", 34.5, Infinity],
  ];
  const cdf = (x) => (x === Infinity ? 1 : x === -Infinity ? 0
    : 0.5 * (1 + erf((x - pointsAllowed) / (pointsAllowedSpread * Math.SQRT2))));
  return Object.fromEntries(bands.map(([key, low, high]) => [key, Math.max(0, cdf(high) - cdf(low))]));
}

// Abramowitz & Stegun 7.1.26 — four decimal places, which is three more than
// a points-allowed band needs.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

/* Make every team's targets and carries add up to the ball it is expected to
 * have.
 *
 * Without this the model is systematically short, and the reason is worth
 * writing down because it looks like a bug and is not. Every rate here is
 * conditional on the player being on the field: a receiver's targets per pass
 * snap is what he does when he plays. Project a whole team that way and the
 * totals come to about seven-eighths of the team's actual targets, because an
 * eighth of them are owed to players who will not be out there — the back who
 * is on injured reserve, the receiver who is a late scratch. Those targets do
 * not vanish on Sunday. They go to whoever is.
 *
 * So the team's expected dropbacks and rushes are divided among the players
 * expected to play, in proportion to the rates they earned. A receiver whose
 * team-mate is out gets a bigger share without anyone having to guess at a
 * depth chart, and the shares themselves — which is what all the per-player
 * work was for — are untouched.
 *
 * Measured over 2026 weeks 4-9 this is worth about a point of mean absolute
 * error at running back and a point and a half at receiver, and it removes
 * most of the model's negative bias.
 */
export function normalizeVolume(projected, volumes, league, bounds = [0.7, 1.7]) {
  const byTeamList = new Map();
  for (const entry of projected) {
    if (entry.position === "K" || entry.position === "DEF") continue;
    if (!byTeamList.has(entry.team)) byTeamList.set(entry.team, []);
    byTeamList.get(entry.team).push(entry);
  }

  for (const [team, entries] of byTeamList) {
    const volume = volumes[team];
    if (!volume) continue;
    const attempts = volume.dropbacks * (1 - league.sackRate);

    let targets = 0;
    let carries = 0;
    for (const entry of entries) {
      const plays = playProbability(entry.record.inj);
      carries += plays * (entry.draw.carries ?? 0);
      if (entry.position !== "QB") targets += plays * (entry.draw.targets ?? 0);
    }

    const scale = (planned, expected) => (planned > 0 && expected > 0
      ? clamp(expected / planned, bounds) : 1);
    const targetScale = scale(targets, attempts * league.targetsPerAttempt);
    const carryScale = scale(carries, volume.rushes);

    /* Quarterback attempts are deliberately left out of this.
     *
     * Their denominator is already the team's own attempts, so a starter's
     * share is near one and there is nothing to redistribute. What
     * normalising them actually did was take attempts off the starter to make
     * room for a backup whose share had not decayed out of the window yet —
     * one relief appearance in week 2 cost the starter a tenth of his
     * attempts in week 10. It made the quarterback bias four times worse.
     */
    for (const entry of entries) {
      const { draw, parts } = entry;
      if (entry.position !== "QB" && draw.targets != null) {
        draw.targets *= targetScale;
        parts.targets = draw.targets;
        parts.target_scale = targetScale;
      }
      if (draw.carries != null) {
        draw.carries *= carryScale;
        parts.carries = draw.carries;
        parts.carry_scale = carryScale;
      }
    }
  }
}

/* Make every team's touchdowns add up to the touchdowns it is expected to
 * score.
 *
 * This is the one place the model is solved as a team rather than a player at
 * a time, and it has to be. Each player's touchdown rate is his own history
 * nudged by his red-zone share, and nothing in that arithmetic knows about
 * the other ten men in the huddle — so a backfield where both backs score
 * often, in an offence the spread says will score three times, comes out
 * projecting five touchdowns between them. Rates decide the *shares*; the
 * implied total decides the *total*; this closes the loop.
 *
 * The share is what the per-player work was for, and it survives
 * untouched — everyone on a team moves by the same factor. The factor is
 * clamped, because a team whose entire skill group has barely played would
 * otherwise have the whole gap handed to whoever did.
 */
export function normalizeTouchdowns(projected, volumes, bounds = [0.6, 1.6]) {
  const byTeamList = new Map();
  for (const entry of projected) {
    if (entry.position === "K" || entry.position === "DEF") continue;
    if (!byTeamList.has(entry.team)) byTeamList.set(entry.team, []);
    byTeamList.get(entry.team).push(entry);
  }

  for (const [team, entries] of byTeamList) {
    const expected = volumes[team]?.team_tds;
    if (!(expected > 0)) continue;

    // A passing touchdown and the receiving touchdown it threw are one event,
    // so only the catching and running sides are counted.
    let planned = 0;
    for (const { position, draw } of entries) {
      if (position === "QB") planned += draw.carries * draw.rushTdPerCarry;
      else planned += draw.targets * draw.recTdPerTarget + draw.carries * draw.rushTdPerCarry;
    }
    if (!(planned > 0)) continue;

    const factor = clamp(expected / planned, bounds);
    for (const entry of entries) {
      const { draw } = entry;
      if (draw.recTdPerTarget != null) draw.recTdPerTarget *= factor;
      if (draw.rushTdPerCarry != null) draw.rushTdPerCarry *= factor;
      if (draw.passTdPerAttempt != null) draw.passTdPerAttempt *= factor;
      entry.parts.td_scale = factor;
    }
  }
}

// ------------------------------------------------------------- the bundle

/* Everything the page needs for one week, and nothing it doesn't.
 *
 * `weeks` is every completed week, oldest first. `games` is the whole
 * schedule with spreads and totals. `week` is the one being projected. The
 * result is what gets written to data/lineup/<season>-week-NN.json and read
 * by the page: team volume, defensive factors, and a line plus its parts for
 * every player who has been on a field this season.
 *
 * A player whose team is not playing is still in the bundle, flagged `bye`,
 * because a roster has to be fully resolvable — a missing player reads as a
 * bug, and "he is on bye" is the answer the page needs to print.
 */
export function buildBundle({ season, week, weeks, games, matchup = true,
                              generatedAt = new Date().toISOString() }) {
  const completed = weeks.filter((w) => w.week < week).sort((a, b) => a.week - b.week);
  const { byTeam, byPlayer, scores } = readSeason(completed, games);
  const league = leagueRates(completed, byTeam, scores);
  const measured = defenceFactors(completed, byTeam, league);
  const neutral = measured.neutral;
  // The ablation the handoff asks for: run the whole model with every defence
  // read as exactly average, and see whether the error goes up or down.
  const factors = matchup ? measured.factors : {};

  // The week's games, as each team's own view of it.
  const fixtures = new Map();
  const lastWeek = completed.length ? completed[completed.length - 1].week : 0;
  for (const game of games.filter((g) => g.week === week)) {
    const half = game.total / 2;
    const edge = game.spread / 2;
    fixtures.set(game.home, {
      opponent: game.away, home: true, kickoff: game.kickoff ?? null, score: game.homeScore,
      spread: -game.spread, total: game.total,
      implied: half + edge, impliedAgainst: half - edge,
    });
    fixtures.set(game.away, {
      opponent: game.home, home: false, kickoff: game.kickoff ?? null, score: game.awayScore,
      spread: game.spread, total: game.total,
      implied: half - edge, impliedAgainst: half + edge,
    });
  }

  const volumes = {};
  for (const [team, fixture] of fixtures) {
    const volume = teamVolume(byTeam.get(team) ?? new Map(), fixture, league);
    volumes[team] = {
      opponent: fixture.opponent, home: fixture.home, kickoff: fixture.kickoff,
      spread: round(fixture.spread, 1), total: round(fixture.total, 1),
      implied: round(volume.implied, 1), implied_against: round(volume.impliedAgainst, 1),
      plays: round(volume.plays, 1), pass_rate: round(volume.passRate),
      base_pass_rate: round(volume.basePassRate), script: round(volume.script),
      dropbacks: round(volume.dropbacks, 1), rushes: round(volume.rushes, 1),
      team_tds: round(volume.tds, 2), scoring: round(volume.scoring),
      games: volume.games,
      // Already played, on the morning a build runs mid-week. Only the week
      // still being played has any; Sleeper has locked these players, so
      // the page leaves them where they are.
      final: Number.isFinite(fixture.score),
    };
  }

  const players = [];
  const projected = [];
  for (const [id, history] of byPlayer) {
    const latest = history[history.length - 1];
    const position = normalizePosition(latest.position);
    if (!PROJECTED.includes(position)) continue;

    // His current team is the one he last played for. A traded player's older
    // games stay attributed to the offence he was in, because every game
    // carries its own team — but the week being projected is the new one's.
    const team = latest.team;
    const fixture = fixtures.get(team);

    const record = {
      id,
      name: latest.name,
      pos: position,
      team,
      inj: latest.injury_status ?? null,
      games: history.filter((g) => stat(g, "gp") > 0).length,
    };

    if (!fixture) {
      players.push({ ...record, flag: "bye" });
      continue;
    }

    // Each of his games needs its team's shape that week, for the pass-snap
    // and share denominators.
    const enriched = history
      .filter((g) => stat(g, "gp") > 0)
      .sort((a, b) => a.week - b.week)
      .map((g) => {
        const teamGame = byTeam.get(g.team)?.get(g.week);
        return {
          ...g,
          teamPassRate: teamGame?.passRate ?? league.teamPassRate,
          teamPassAtt: teamGame?.passAtt ?? 0,
          teamRushAtt: teamGame?.rushAtt ?? 0,
          teamDropbacks: teamGame?.dropbacks ?? 0,
          teamSacks: teamGame?.sacks ?? 0,
        };
      });

    const volume = teamVolume(byTeam.get(team) ?? new Map(), fixture, league);
    const matchup = factors[fixture.opponent] ?? neutral;

    const { draw, parts } =
      position === "QB" ? projectQb(enriched, team, volume, matchup, league)
      : position === "K" ? projectKicker(enriched, volume, league)
      : position === "DEF" ? projectDefence(enriched, volume, league,
          teamYardsPerGame(byTeam.get(fixture.opponent) ?? new Map(), league))
      : projectSkill(enriched, position, team, volume, matchup, league);

    projected.push({ record, position, team, fixture, draw, parts, volume });
  }

  /* The team-level normalisations are NOT run here. They are the one part of
   * the model that depends on who is injured — an absent receiver's targets
   * go to the men who are playing — and injury news moves by the hour. So the
   * bundle carries every player's rates before them, and finalizeWeek runs
   * them wherever the bundle is read: in the page against Sleeper's live tags,
   * on the command line against the tags as of the build. */
  for (const { record, fixture, draw, parts } of projected) {
    players.push({
      ...record,
      opp: fixture.opponent,
      home: fixture.home,
      kickoff: fixture.kickoff,
      draw: Object.fromEntries(Object.entries(draw).map(([k, v]) =>
        [k, typeof v === "object" ? v : round(v, 5)])),
      parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 3)])),
    });
  }

  players.sort((a, b) => a.name.localeCompare(b.name));

  return {
    season: String(season),
    week,
    through_week: lastWeek,
    generated_at: generatedAt,
    league: {
      team_snaps: round(league.teamSnaps, 1),
      team_pass_rate: round(league.teamPassRate),
      team_tds: round(league.teamTds, 2),
      points_per_game: round(league.pointsPerGame, 1),
      points_per_td: round(league.tdsPerPoint > 0 ? 1 / league.tdsPerPoint : FALLBACK_POINTS_PER_TD, 2),
      // The two constants finalizeWeek needs to turn a team's dropbacks into
      // the targets it has to hand out.
      sack_rate: round(league.sackRate, 5),
      targets_per_attempt: round(league.targetsPerAttempt, 5),
    },
    teams: volumes,
    defence: measured.factors,
    players,
  };
}

/* A built week, made into projections: injury tags applied, then each team's
 * targets, carries and touchdowns divided among the players who will play.
 *
 * `injuries` is a Map of player id to his tag right now (null for healthy) —
 * in the page, Sleeper's live feed. A player it does not mention keeps the tag
 * he was built with, and with no map at all every tag is the build's. The
 * bundle is not changed; the players come back as new objects with a `line`
 * on each, ready to score.
 *
 * Volume first, then touchdowns: the touchdown totals are counted off the
 * targets and carries, so normalising them the other way round would undo
 * itself.
 */
export function finalizeWeek(bundle, injuries = null) {
  const tagged = (player) => (injuries?.has(player.id) ? injuries.get(player.id) ?? null : player.inj ?? null);
  const players = bundle.players.map((player) => ({ ...player, inj: tagged(player) }));

  const entries = players
    .filter((player) => player.draw)
    .map((player) => {
      player.draw = { ...player.draw };
      player.parts = { ...player.parts };
      return { record: player, position: player.pos, team: player.team, draw: player.draw, parts: player.parts };
    });

  const league = {
    sackRate: bundle.league.sack_rate ?? 0.065,
    targetsPerAttempt: bundle.league.targets_per_attempt ?? 0.95,
  };
  normalizeVolume(entries, bundle.teams, league);
  normalizeTouchdowns(entries, bundle.teams);

  for (const { record, position, draw, parts } of entries) {
    record.line = Object.fromEntries(Object.entries(expectedLine(position, draw)).map(([k, v]) => [k, round(v, 2)]));
    for (const key of ["targets", "carries", "target_scale", "carry_scale", "td_scale"]) {
      if (typeof parts[key] === "number") parts[key] = round(parts[key], 3);
    }
  }
  return { ...bundle, players, injuries: injuries ? "live" : "build" };
}

/* A finished week's bundle, with each player's tag set by whether he played.
 *
 * Sleeper keeps no history of injury tags — every feed answers with today's —
 * so a week already played cannot be finished against the tags it had. What
 * it can be finished against is who took the field: anyone who did not is Out,
 * anyone who did is healthy. That is close to what the inactives list told you
 * ninety minutes before kickoff, and it is what a look back at "what should I
 * have started" wants. Defences always play.
 */
export function tagByAttendance(bundle, played) {
  return {
    ...bundle,
    past: true,
    players: bundle.players.map((player) => (player.pos === "DEF" || player.flag === "bye"
      ? player
      : { ...player, inj: played.has(player.id) ? null : "Out" })),
  };
}
