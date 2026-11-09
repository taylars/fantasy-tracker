#!/usr/bin/env node
/* The lineup bundle: built here, read by the page.
 *
 *     node bin/lineup.mjs build                      # this week, into data/lineup/
 *     node bin/lineup.mjs build --week 11
 *     node bin/lineup.mjs check                      # is what build wrote fit to publish?
 *     node bin/lineup.mjs show "Puka Nacua" "Jaxon Smith-Njigba"
 *     node bin/lineup.mjs show --user taylars --start      # the whole lineup
 *     node bin/lineup.mjs backtest --from 4                # how wrong is it?
 *     node bin/lineup.mjs backtest --from 4 --no-matchup   # does a layer help?
 *
 * `build` is the only one of these the site depends on. It fetches every
 * completed week of the season plus the schedule, runs js/project.js, and
 * writes one file per week under data/lineup/ — which is the whole reason the
 * page can set a lineup off three small Sleeper calls instead of nine
 * megabytes of weekly stats it would have to join in a browser.
 *
 * `show` is the same model on a terminal, with the component breakdown under
 * each player, because "nine points" is not an argument and "his snap share
 * went from 82% to 46%" is.
 *
 * `backtest` projects each completed week using only the weeks before it and
 * scores the result against what actually happened, with Sleeper's own weekly
 * projection alongside as the benchmark. Nothing here is worth keeping if it
 * cannot beat the number you can already see in the app.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileCache } from "../js/cache-fs.js";
import { SleeperClient } from "../js/sleeper.js";
import { scoreStats, scoringFor } from "../js/pool.js";
import { buildBundle, finalizeWeek, tagByAttendance } from "../js/project.js";
import { beats, lineupCard, project, worth } from "../js/lineup.js";
import { nextWeek, schedule, weekProjections, weeksBefore, weekStats } from "./lib/nfl.mjs";
import { checkBundle, REFERENCE_SCORING } from "./lib/bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "lineup");


/* Half PPR, for a terminal with no league in front of it. The page always has
 * one and never uses this; a backtest wants a fixed yardstick, and a backtest
 * whose yardstick moved between runs would be worthless.
 */
export { REFERENCE_SCORING };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) { args._.push(flag); continue; }
    const name = flag.slice(2);
    if (["no-matchup", "json", "start", "quiet", "all"].includes(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  return args;
}

const log = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);

async function season(args, sleeper) {
  if (args.season) return String(args.season);
  const state = await sleeper.getState();
  return String(state.season);
}

/* Everything the model reads, fetched once. */
async function inputs(args, cache, sleeper, { quiet = false } = {}) {
  const year = await season(args, sleeper);
  const games = await schedule(year, { cache });
  if (!games.length) throw new Error(`nflverse has no ${year} regular season schedule yet`);

  const week = Number(args.week) || nextWeek(games);
  if (!week) throw new Error(`every ${year} game has been played; pass --week to project one anyway`);

  if (!quiet) log(`[lineup] ${year} week ${week}; reading weeks 1-${week - 1}`);
  const weeks = await weeksBefore(year, week, {
    cache,
    onWeek: quiet ? null : ({ week: w, played }) => log(`[lineup]   week ${w}: ${played} players played`),
  });

  return { year, games, week, weeks };
}

// ------------------------------------------------------------------- build

async function build(args) {
  const cache = new FileCache();
  const sleeper = new SleeperClient({ cache });
  await mkdir(OUT_DIR, { recursive: true });

  /* The site deploys every day of the year, so a build with nothing to
   * project is not a failure: it writes an index that says why, the page
   * prints that, and the deploy goes out. Only a real error fails the job. */
  const idle = async (season, reason) => {
    await clearBundles(new Set());
    const index = { season, latest: null, current: null, reason,
                    generated_at: new Date().toISOString(), weeks: [] };
    await writeFile(path.join(OUT_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    log(`[lineup] nothing to project: ${reason}`);
  };

  const year = await season(args, sleeper);
  const games = await schedule(year, { cache });
  if (!games.length) return idle(year, `The ${year} schedule isn't out yet.`);

  const current = Number(args.week) || nextWeek(games);
  if (!current) return idle(year, `The ${year} regular season is over.`);

  /* Which weeks get a bundle: only weeks a sportsbook has priced, because
   * the implied total is what the whole projection hangs off and a guess at it
   * would be a guess dressed as a projection. That is the week a lineup is
   * being set for, once its lines are up, and — on a Monday — the week still
   * being played, because a Monday-night start is a real decision. Both are
   * built off the same history, and buildBundle only lets a week read the
   * weeks before it. */
  const priced = (week) => {
    const slate = games.filter((g) => g.week === week);
    return slate.length > 0 && slate.every((g) => Number.isFinite(g.spread) && Number.isFinite(g.total));
  };
  const inProgress = args.week ? null : firstOpenWeek(games);
  // Every finished week too, from week 2 (week 1 has nothing behind it), so
  // the page can look back at what it projected against what happened. Each
  // is built only from the weeks before it — the same no-lookahead rule as
  // the backtest — so it is the projection the page would have shown then.
  const finished = (week) => games.filter((g) => g.week === week)
    .every((g) => Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore));
  const past = args.week ? [] : Array.from({ length: current - 2 }, (_, i) => i + 2).filter(finished);
  const wanted = [...new Set([...past, inProgress, current])].filter((w) => w && priced(w)).sort((a, b) => a - b);
  if (!wanted.length) return idle(year, `Lines for week ${current} aren't posted yet.`);

  log(`[lineup] ${year} weeks ${wanted[0]}-${wanted[wanted.length - 1]}; reading weeks 1-${current - 1}`);
  const weeks = await weeksBefore(year, current, {
    cache,
    onWeek: ({ week: w, played }) => log(`[lineup]   week ${w}: ${played} players played`),
  });
  if (!weeks.length) return idle(year, "Projections start once week 1 has been played.");

  const generatedAt = new Date().toISOString();
  const written = [];
  for (const week of wanted) {
    let bundle = buildBundle({ season: year, week, weeks, games, generatedAt });
    if (!bundle.through_week) continue;   // an in-progress week 1 has nothing behind it
    const isPast = past.includes(week);
    if (isPast) {
      const rows = weeks.find((w) => w.week === week)?.rows ?? [];
      bundle = tagByAttendance(bundle, new Set(rows.filter((r) => (r.stats?.gp ?? 0) > 0).map((r) => r.player_id)));
    }
    const file = `${year}-week-${String(week).padStart(2, "0")}.json`;
    await writeFile(path.join(OUT_DIR, file), JSON.stringify(bundle));
    written.push({ season: year, week, file, ...(isPast ? { past: true } : {}) });

    const projected = bundle.players.filter((p) => p.draw);
    log(`[lineup] wrote data/lineup/${file}: ${projected.length} players, ` +
        `${Object.keys(bundle.teams).length} teams playing`);
  }

  // Bundles from earlier builds are removed: what is on disk is exactly what
  // the index names, so a local run looks like a deploy.
  await clearBundles(new Set(written.map((w) => w.file)));

  /* The index is what the page reads first, and it is one small file on
   * purpose: a browser should not have to guess a filename or walk a
   * directory listing GitHub Pages does not serve. `latest` is the week the
   * page opens on — this week, or the one still finishing if this week has
   * no lines yet; `weeks` is everything it can switch to. */
  const index = {
    season: year,
    latest: written.find((w) => w.week === current) ?? written[written.length - 1],
    current,
    generated_at: generatedAt,
    weeks: written,
  };
  await writeFile(path.join(OUT_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

async function clearBundles(keep) {
  for (const name of await readdir(OUT_DIR)) {
    if (/^\d{4}-week-\d{2}\.json$/.test(name) && !keep.has(name)) await rm(path.join(OUT_DIR, name));
  }
}

/* The earliest week with a game still to be played — on a Monday, the week
 * whose Monday-night game has not kicked off. */
function firstOpenWeek(games) {
  const open = games.filter((g) => !Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore));
  return open.length ? Math.min(...open.map((g) => g.week)) : null;
}

// ------------------------------------------------------------------- check

/* Fails, with every reason, if what build wrote is not fit to publish. The
 * Pages workflow runs this between building and uploading. */
async function check() {
  const read = async (name) => {
    try { return JSON.parse(await readFile(path.join(OUT_DIR, name), "utf8")); } catch { return null; }
  };
  const index = await read("index.json");
  const report = (label, { problems, warnings }) => {
    for (const w of warnings) console.error(`::warning::[check] ${label}${w}`);
    for (const p of problems) console.error(`[check] ${label}${p}`);
    return problems.length === 0;
  };
  if (index?.latest === null) {
    if (!report("", checkBundle(index, null))) process.exit(1);
    log(`[check] no week to project (${index.reason}); nothing else to check`);
    return;
  }
  let failed = false;
  for (const entry of index?.weeks ?? []) {
    const ok = report(`week ${entry.week}: `, checkBundle({ ...index, latest: entry }, await read(entry.file)));
    if (ok) log(`[check] week ${entry.week}: ok`);
    else failed = true;
  }
  if (!index?.weeks?.length || !index.latest) { console.error("[check] the index names no weeks"); failed = true; }
  if (failed) process.exit(1);
}

// -------------------------------------------------------------------- show

const pct = (value) => `${(value * 100).toFixed(0)}%`;
const signed = (value, digits = 1) => (value >= 0 ? "+" : "−") + Math.abs(value).toFixed(digits);

function describe(projection) {
  const parts = projection.parts ?? {};
  if (projection.pos === "QB") {
    return [
      `${parts.dropbacks?.toFixed(1)} team dropbacks × ${pct(parts.attempt_share ?? 0)} his`,
      `${parts.attempts?.toFixed(1)} attempts at ${parts.yards_per_attempt?.toFixed(2)} yd/att`,
      `${parts.carries?.toFixed(1)} carries`,
      `implied ${parts.implied?.toFixed(1)} (${parts.team_tds?.toFixed(2)} TDs)`,
      `matchup ×${parts.matchup_efficiency?.toFixed(2)} yards, ×${parts.matchup_td?.toFixed(2)} TDs`,
    ];
  }
  if (projection.pos === "K") {
    return [`${parts.fga?.toFixed(1)} attempts at ${pct(parts.fg_rate ?? 0)}`,
            `implied ${parts.implied?.toFixed(1)} (${parts.team_tds?.toFixed(2)} TDs)`];
  }
  if (projection.pos === "DEF") {
    return [`opponent implied ${parts.implied_against?.toFixed(1)}`,
            `${parts.sacks?.toFixed(1)} sacks, ${parts.takeaways?.toFixed(1)} takeaways`];
  }
  return [
    `${parts.dropbacks?.toFixed(1)} dropbacks × ${pct(parts.snap_share ?? 0)} snaps` +
      ` × ${(parts.targets_per_pass_snap ?? 0).toFixed(3)} tgt/pass snap`,
    `${parts.targets?.toFixed(1)} targets at ${parts.yards_per_target?.toFixed(2)} yd/tgt` +
      ` (${pct(parts.catch_rate ?? 0)} caught)`,
    parts.carries > 0.5 ? `${parts.carries.toFixed(1)} carries at ${parts.yards_per_carry?.toFixed(2)}` : null,
    `implied ${parts.implied?.toFixed(1)} (${parts.team_tds?.toFixed(2)} TDs)`,
    `matchup ×${parts.matchup_volume?.toFixed(2)} targets, ×${parts.matchup_efficiency?.toFixed(2)} yards,` +
      ` ×${parts.matchup_td?.toFixed(2)} TDs over ${parts.matchup_games ?? 0} games`,
  ].filter(Boolean);
}

async function show(args) {
  const cache = new FileCache();
  const sleeper = new SleeperClient({ cache });
  const { year, games, week, weeks } = await inputs(args, cache, sleeper);
  // Live injury tags, the same feed the page reads; the build's if it fails.
  const live = await sleeper.getWeekReport(year, week).catch(() => null);
  const bundle = finalizeWeek(buildBundle({ season: year, week, weeks, games, matchup: !args["no-matchup"] }),
    live?.tags ?? null);

  let scoring = REFERENCE_SCORING;
  let league = null;
  let roster = null;

  if (args.user) {
    const user = await sleeper.getUser(args.user);
    if (!user) { console.error(`no such Sleeper user: ${args.user}`); process.exit(1); }
    const leagues = await sleeper.getUserLeagues(user.user_id, year);
    league = args.league ? leagues.find((l) => l.league_id === args.league) : leagues[0];
    if (!league) { console.error(`no ${year} league for ${args.user}`); process.exit(1); }
    scoring = scoringFor(league, null);
    const rosters = await sleeper.getLeagueRosters(league.league_id);
    roster = rosters.find((r) => r.owner_id === user.user_id) ?? null;
  }

  if (args.start) {
    if (!roster) { console.error("--start needs --user"); process.exit(2); }
    const card = lineupCard({ bundle, roster, league, draws: 8000 });
    console.log(`${league.name} — week ${card.week}, through week ${card.through}\n`);
    const line = (slot, p) => `  ${slot.padEnd(11)} ${
      p ? `${p.name.padEnd(24)} ${worth(p).toFixed(1).padStart(5)}  (${p.floor.toFixed(1)}–${p.ceiling.toFixed(1)})`
        : "—"}`;
    console.log("Best lineup");
    for (const { slot, player } of card.optimal) console.log(line(slot, player));
    console.log(`  ${"total".padEnd(11)} ${"".padEnd(24)} ${card.totals.optimal.points.toFixed(1).padStart(5)}` +
      `  (${card.totals.optimal.floor.toFixed(1)}–${card.totals.optimal.ceiling.toFixed(1)})`);
    if (card.moves.length) {
      console.log("\nChanges from what you have in now");
      for (const move of card.moves) {
        const what = move.in && move.out ? `${move.in.name} in for ${move.out.name}`
          : move.in ? `start ${move.in.name} (the slot is empty)`
          : `sit ${move.out.name} (nobody on the bench can take the slot)`;
        console.log(`  ${move.slot}: ${what} — ${signed(move.gain)} points` +
          (move.odds != null ? `; ${move.in.name} beats ${move.out.name} ${pct(move.odds)} of the time` : ""));
      }
    } else {
      console.log("\nNothing to change — the lineup in Sleeper is the best one.");
    }
    if (card.calls.length) {
      console.log("\nClose calls");
      for (const call of card.calls) {
        console.log(`  ${call.slot}: ${call.start.name} over ${call.over.name}` +
          ` by ${call.gap.toFixed(1)}` +
          (call.odds != null ? `; ${call.start.name} beats ${call.over.name} ${pct(1 - call.odds)} of the time` : ""));
      }
    }
    if (card.unscored.length) console.log(`\nNot projected but scored: ${card.unscored.join(", ")}`);
    return;
  }

  const wanted = args._.slice(1);
  if (!wanted.length) { console.error('usage: node bin/lineup.mjs show "Player Name" ["Other Player"]'); process.exit(2); }

  const found = wanted.map((name) => {
    const needle = name.toLowerCase();
    const match = bundle.players.find((p) => p.name.toLowerCase() === needle)
      ?? bundle.players.find((p) => p.name.toLowerCase().includes(needle));
    if (!match) { console.error(`no player matching "${name}" has played this season`); process.exit(1); }
    return project(match, scoring, { draws: 20000, week: bundle.week });
  });

  console.log(`week ${bundle.week}, through week ${bundle.through_week}` +
    (league ? ` — ${league.name} scoring` : " — half PPR"));
  for (const p of found) {
    const where = p.flag === "bye" ? "BYE" : `${p.home ? "vs" : "@"} ${p.opp}`;
    console.log(`\n${p.name}  ${p.pos} ${p.team} ${where}${p.inj ? `  [${p.inj}]` : ""}`);
    console.log(`  expected ${p.mean.toFixed(1)}   floor ${p.floor.toFixed(1)}` +
      `   median ${p.median.toFixed(1)}   ceiling ${p.ceiling.toFixed(1)}`);
    for (const part of describe(p)) console.log(`  · ${part}`);
  }
  if (found.length === 2) {
    const [a, b] = found;
    const [ahead, behind] = worth(a) >= worth(b) ? [a, b] : [b, a];
    console.log(`\nStart ${ahead.name} over ${behind.name}: ${signed(worth(ahead) - worth(behind))} points; ` +
      `${ahead.name} beats ${behind.name} ${pct(beats(ahead, behind))} of the time.`);
  }
}

// ---------------------------------------------------------------- backtest

/* How wrong the model is, week by week, against the only honest yardstick:
 * what the players actually scored.
 *
 * Each week is projected from the weeks before it and nothing else — the
 * bundle is rebuilt from scratch per week, which is slow and is the point.
 * Any shortcut here leaks the answer.
 *
 * Only players with a real role are scored. Mean absolute error over every
 * player who took a snap is dominated by four hundred people who were always
 * going to score two points, and a model that nails those and misses every
 * starter would look excellent. A startable player is one the model expects
 * at least six points from, which is roughly the bench line at every
 * position.
 */
const STARTABLE = 6;

async function backtest(args) {
  const cache = new FileCache();
  const sleeper = new SleeperClient({ cache });
  const year = await season(args, sleeper);
  const games = await schedule(year, { cache });
  // The last week whose every game is final: a Monday-night game still to
  // play would score its players as zeros.
  const open = firstOpenWeek(games);
  const last = (open ?? Math.max(...games.map((g) => g.week)) + 1) - 1;
  const from = Number(args.from) || 2;
  const to = Math.min(Number(args.to) || last, last);
  if (to < from) { console.error(`nothing to backtest: weeks ${from}-${to}`); process.exit(1); }

  log(`[backtest] ${year} weeks ${from}-${to}${args["no-matchup"] ? " (matchup off)" : ""}`);

  const all = [];
  for (let week = from; week <= to; week++) {
    const history = await weeksBefore(year, week, { cache });
    const actual = await weekStats(year, week, { cache });
    const theirs = await weekProjections(year, week, { cache });

    const scored = new Map();
    for (const row of actual.rows) {
      if ((row.stats?.gp ?? 0) > 0) scored.set(row.player_id, scoreStats(row.stats, REFERENCE_SCORING));
    }

    /* Tagged by who played, as the page does for a finished week. The tags
     * on the stats are today's — Sleeper keeps no history of them — so
     * reading them would put a player hurt this week out of week 4 too, and
     * hand his week-4 targets to his team-mates. Knowing the inactives is
     * what a projection has by kickoff, and Sleeper's own is updated for
     * them too. */
    const raw = buildBundle({ season: year, week, weeks: history, games, matchup: !args["no-matchup"] });
    const bundle = finalizeWeek(tagByAttendance(raw, new Set(scored.keys())));

    for (const player of bundle.players) {
      if (!player.line) continue;
      // A player who did not take the field is not a projection miss, he is
      // an availability miss, and the two are different problems.
      if (!scored.has(player.id)) continue;
      // The simulated mean rather than the expected line, because the
      // yardage bonuses only exist in the draws — scoring the line would
      // leave every hundred-yard game's bonus out of the comparison.
      const mine = project(player, REFERENCE_SCORING, { draws: 1500, week }).mean;
      const them = theirs.has(player.id) ? scoreStats(theirs.get(player.id), REFERENCE_SCORING) : null;
      // Startable by either projection, so the pool is not the players one
      // side happened to like.
      if (mine < STARTABLE && (them ?? 0) < STARTABLE) continue;
      all.push({ week, pos: player.pos, mine, them, truth: scored.get(player.id) });
    }
    log(`[backtest]   week ${week}: ${all.filter((r) => r.week === week).length} startable players`);
  }

  const table = (rows) => {
    const mine = rows.map((r) => Math.abs(r.mine - r.truth));
    const paired = rows.filter((r) => r.them != null);
    const theirs = paired.map((r) => Math.abs(r.them - r.truth));
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const bias = mean(rows.map((r) => r.mine - r.truth));
    return {
      n: rows.length,
      mae: mean(mine),
      bias,
      theirN: paired.length,
      theirMae: mean(paired.map((r) => Math.abs(r.mine - r.truth))),
      sleeperMae: mean(theirs),
    };
  };

  const report = { season: year, weeks: [from, to], matchup: !args["no-matchup"], by_position: {},
    by_week: Object.fromEntries([...new Set(all.map((r) => r.week))].map((w) => {
      const rows = all.filter((r) => r.week === w && r.them != null);
      const m = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
      return [w, { n: rows.length, ours: m((r) => Math.abs(r.mine - r.truth)), sleeper: m((r) => Math.abs(r.them - r.truth)) }];
    })) };
  const positions = ["QB", "RB", "WR", "TE", "K", "DEF"];
  for (const pos of positions.concat(["all"])) {
    const rows = pos === "all" ? all : all.filter((r) => r.pos === pos);
    if (!rows.length) continue;
    report.by_position[pos] = table(rows);
  }

  if (args.json) { console.log(JSON.stringify({ ...report, rows: all }, null, 2)); return; }

  console.log(`\n${year} weeks ${from}–${to}, half PPR, players either projection had at ${STARTABLE}+` +
    `${args["no-matchup"] ? " — matchup layer OFF" : ""}\n`);
  console.log("  pos      n     MAE    bias   |  same players: ours   Sleeper");
  for (const [pos, row] of Object.entries(report.by_position)) {
    console.log(`  ${pos.padEnd(5)} ${String(row.n).padStart(5)}  ${row.mae.toFixed(2).padStart(6)}` +
      `  ${signed(row.bias, 2).padStart(6)}   |  ${String(row.theirN).padStart(5)}` +
      `  ${row.theirMae.toFixed(2).padStart(6)}    ${row.sleeperMae.toFixed(2).padStart(6)}`);
  }
  /* Week by week, on the rows both sides projected: whether the gap moves
   * as the season fills in. Early on everything here is regressed toward its
   * position, and a provider with last season's data should have the edge;
   * the question is whether it closes. */
  const paired = all.filter((r) => r.them != null);
  const weeksSeen = [...new Set(paired.map((r) => r.week))].sort((a, b) => a - b);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log("\n  week     n    ours  Sleeper   diff   ours closer   bias: ours  Sleeper");
  for (const week of weeksSeen) {
    const rows = paired.filter((r) => r.week === week);
    const ours = mean(rows.map((r) => Math.abs(r.mine - r.truth)));
    const sl = mean(rows.map((r) => Math.abs(r.them - r.truth)));
    const closer = rows.filter((r) => Math.abs(r.mine - r.truth) < Math.abs(r.them - r.truth)).length / rows.length;
    console.log(`  ${String(week).padStart(4)} ${String(rows.length).padStart(5)}  ${ours.toFixed(2).padStart(6)}` +
      `   ${sl.toFixed(2).padStart(6)}  ${signed(ours - sl, 2).padStart(6)}      ${(closer * 100).toFixed(0).padStart(3)}%` +
      `        ${signed(mean(rows.map((r) => r.mine - r.truth)), 2).padStart(6)}  ${signed(mean(rows.map((r) => r.them - r.truth)), 2).padStart(6)}`);
  }
  console.log("\n  MAE is mean absolute error in points. bias is signed: positive means the");
  console.log("  model projects more than players score. The right-hand pair is the same");
  console.log("  rows scored both ways, so it is a fair comparison and the left-hand MAE");
  console.log("  is not necessarily equal to it.");
}

// -------------------------------------------------------------------- main

const COMMANDS = { build, check, show, backtest };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = COMMANDS[args._[0]] ?? (args._.length ? null : build);
  if (!command) {
    console.error("usage: node bin/lineup.mjs <build|check|show|backtest> [options]");
    process.exit(2);
  }
  await command(args);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
