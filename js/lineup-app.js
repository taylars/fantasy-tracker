/* The set-lineup page.
 *
 * Same shape as the two pages next door: one Sleeper username, no server,
 * nothing hardcoded. What is different is where the numbers come from. The
 * board and the luck table compute everything in the browser from what
 * Sleeper answers; a weekly projection cannot be, because it needs nine weeks
 * of play-by-play-adjacent stats and a schedule with spreads on it, which is
 * nine megabytes and two providers.
 *
 * So that part is done once a week on the command line — `node
 * bin/lineup.mjs build` — and committed as a static file. The page downloads
 * one bundle and asks Sleeper for four small things: who you are, your
 * leagues, their rosters, and their managers. Everything else is arithmetic
 * on what it already has.
 *
 * The arithmetic that is left is the arithmetic that needs the league in
 * front of it: points under its own scoring, percentiles of those points, and
 * which slots exist. That is js/lineup.js, and it is tested there. This file
 * fetches and draws.
 */

import { SleeperClient } from "./sleeper.js";
import { IndexedDbCache } from "./cache-idb.js";
import { CLOSE_POINTS, lineupCard, worth } from "./lineup.js";
import { scoreStats, scoringFor } from "./pool.js";
import { finalizeWeek } from "./project.js";

const SESSION_KEY = "lineup:session";
const BUNDLE_ROOT = "data/lineup/";

const cache = new IndexedDbCache();
const sleeper = new SleeperClient({ cache });

let USER = null;
let SEASON = null;
let LEAGUES = [];
let LEAGUE = null;
let INDEX = null;
let BUNDLE = null;        // the week as published: rates before injuries
let WEEK = null;          // the same week finished against the live tags
let REPORT = null;        // {at, tags, projections} from Sleeper, or null if it didn't answer
let METHOD = "ours";      // whose projection the card runs on: "ours" or "sleeper"
let ACTUAL = null;        // Map(player id → points scored so far this week, league scoring)
const BUNDLES = new Map();   // week -> bundle, so switching back is instant
let CARD = null;
const OPEN = new Set();   // player ids whose breakdown is unfolded

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const signed = (n, digits = 1) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(digits);
const pct = (n) => `${Math.round(n * 100)}%`;

/* ---------- the session ---------- */

function syncUrl() {
  const params = new URLSearchParams();
  if (USER) params.set("user", USER.username ?? USER.display_name);
  if (LEAGUE) params.set("league", LEAGUE.league_id);
  // The week goes in the url only when it is not the default, so a saved link
  // keeps opening on whatever week is current rather than a stale one.
  if (BUNDLE && INDEX?.latest && BUNDLE.week !== INDEX.latest.week) params.set("week", BUNDLE.week);
  if (METHOD !== "ours") params.set("proj", METHOD);
  history.replaceState(null, "", params.toString() ? "?" + params : location.pathname);
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      username: USER?.username, league: LEAGUE?.league_id, proj: METHOD,
    }));
  } catch { /* storage off; the url still works */ }
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

/* ---------- the bundle ---------- */

/* `no-store` on both, the same as the grades file next door: the index moves
 * every time a week is built, and a bundle rebuilt on Saturday against the
 * same filename as Thursday's would otherwise be served from the browser's
 * own cache for as long as it felt like. Three quarters of a megabyte once
 * per page load is the right trade for never showing a stale lineup.
 */
class Idle extends Error {}

/* The index says which weeks exist. One with no week in it is the offseason,
 * or a Tuesday before the books have priced the coming week — not an error,
 * and the page says which. */
async function loadIndex() {
  const index = await fetch(`${BUNDLE_ROOT}index.json`, { cache: "no-store" });
  if (!index.ok) throw new Error(`no projections published yet (${index.status})`);
  const parsed = await index.json();
  if (parsed.latest === null) throw new Idle(parsed.reason || "There is no week to project right now.");
  if (!parsed.latest?.file) throw new Error("the projection index names no week");
  return parsed;
}

async function loadBundle(entry) {
  if (BUNDLES.has(entry.week)) return BUNDLES.get(entry.week);
  const bundle = await fetch(`${BUNDLE_ROOT}${entry.file}`, { cache: "no-store" });
  if (!bundle.ok) throw new Error(`couldn't load ${entry.file} (${bundle.status})`);
  const parsed = await bundle.json();
  BUNDLES.set(entry.week, parsed);
  return parsed;
}

/* A week still being played is labelled as one: its Sunday is over, and
 * Sleeper has locked everyone who played in it. */
const weekLabel = (entry) =>
  entry.past ? `Week ${entry.week} · final`
  : entry.week < INDEX.current ? `Week ${entry.week} · Monday night` : `Week ${entry.week}`;

function fillWeeks() {
  const pick = $("week-pick");
  pick.innerHTML = [...INDEX.weeks].sort((a, b) => b.week - a.week).map((w) =>
    `<option value="${w.week}"${w.week === BUNDLE.week ? " selected" : ""}>${esc(weekLabel(w))}</option>`).join("");
  pick.disabled = INDEX.weeks.length < 2;
}

/* The published week is rates before injuries; this finishes it against
 * Sleeper's tags as of now — who plays, and where an absent player's targets
 * and carries go. If Sleeper's feed does not answer, the tags from the
 * morning build are used and the footnote says so. */
async function finishWeek() {
  try {
    REPORT = await sleeper.getWeekReport(BUNDLE.season, BUNDLE.week);
  } catch (err) {
    console.warn("Sleeper's week feed unavailable; using the build's tags", err);
    REPORT = null;
  }
  // A finished week keeps the tags it was built with — who actually played —
  // because today's injury report says nothing about a game three weeks ago.
  WEEK = finalizeWeek(BUNDLE, BUNDLE.past ? null : REPORT?.tags ?? null);
}

async function showWeek(week) {
  const entry = INDEX.weeks.find((w) => w.week === Number(week)) ?? INDEX.latest;
  $("card").innerHTML = '<p class="status">Loading the projections…</p>';
  $("standing").textContent = "";
  try {
    BUNDLE = await loadBundle(entry);
    await finishWeek();
  } catch (err) {
    console.error(err);
    $("card").innerHTML = `<p class="status">${esc(err.message)}. Reload to try again.</p>`;
    return;
  }
  $("week").textContent = BUNDLE.week;
  fillWeeks();
  await showLeague(LEAGUE?.league_id);
}

/* Sleeper's own projection, scored under this league's settings the same way
 * ours is — Map(player id → points) — for the card to run on when that is the
 * projection picked. Null if Sleeper's feed did not answer. */
function sleeperPoints(scoring) {
  if (!REPORT) return null;
  const points = new Map();
  for (const [id, line] of REPORT.projections) points.set(id, scoreStats(line, scoring));
  return points;
}

const STAT_LABELS = [
  ["pass_att", "attempts"], ["pass_cmp", "completions"], ["pass_yd", "pass yards"], ["pass_td", "pass TDs"],
  ["pass_int", "interceptions"], ["rec_tgt", "targets"], ["rec", "catches"], ["rec_yd", "rec yards"],
  ["rec_td", "rec TDs"], ["rush_att", "carries"], ["rush_yd", "rush yards"], ["rush_td", "rush TDs"],
  ["fga", "field goal tries"], ["fgm", "field goals"], ["xpm", "extra points"],
  ["sack", "sacks"], ["int", "interceptions"], ["fum_rec", "fumble recoveries"], ["def_td", "defensive TDs"],
];

/* The breakdown behind a row when the card runs on Sleeper's projection:
 * there is no derivation to show, only the stat line Sleeper expects. */
function sleeperBreakdown(player) {
  const line = REPORT?.projections.get(player.id);
  if (!line) return '<p class="bd-none">Sleeper has no projection for this player this week.</p>';
  const rows = STAT_LABELS
    .filter(([key]) => (line[key] ?? 0) >= 0.05)
    .map(([key, label]) => {
      const value = line[key];
      return `<li><span class="bd-k">${esc(label)}</span>` +
        `<span class="bd-v">${value.toFixed(value >= 10 ? 0 : 1)}</span></li>`;
    });
  return `<ul class="bd">${rows.join("")}</ul>` +
    '<p class="bd-games">Sleeper\'s projected stat line, scored under this league\'s settings.' +
    `${player.plays === 0 ? " Projected at zero because he is not expected to play." : ""}</p>`;
}

/* ---------- drawing ---------- */

/* A player's week as a bar: the middle three-fifths of it, with the median
 * marked.
 *
 * Twenty to eightieth percentile rather than the whole range, because the
 * whole range of a simulated receiver runs from nought to forty and drawing
 * that says only that football is random. Every bar on the page shares one scale, so two
 * rows are read against each other rather than each against itself — which is
 * the entire question a start/sit decision asks.
 */
function bar(player, scale) {
  if (!scale || player.flag === "bye") return "";
  // Sleeper's projection is a single number: no span, but the actual still
  // has somewhere to go against it.
  if (player.source === "other") {
    if (scored(player) == null) return "";
    const mid = Math.max(0, Math.min(100, (worth(player) / scale) * 100));
    return '<span class="rng" role="img">' +
      `<span class="rng-mid" style="left:${mid.toFixed(1)}%"></span>` + actualMark(player, scale) + "</span>";
  }
  const left = Math.max(0, Math.min(100, (player.floor / scale) * 100));
  const right = Math.max(0, Math.min(100, (player.ceiling / scale) * 100));
  const mid = Math.max(0, Math.min(100, (worth(player) / scale) * 100));
  return '<span class="rng" role="img" ' +
    `aria-label="${player.floor.toFixed(1)} to ${player.ceiling.toFixed(1)} points">` +
    `<span class="rng-span" style="left:${left.toFixed(1)}%;width:${Math.max(right - left, 1).toFixed(1)}%"></span>` +
    `<span class="rng-mid" style="left:${mid.toFixed(1)}%"></span>` +
    actualMark(player, scale) +
    "</span>";
}

/* Where he actually landed, on the same bar: green above his range, red
 * below it, dark inside it. Two in five land outside by construction — the
 * range is the 20th to 80th percentile — so outside is a big week or a bad
 * one, not the projection failing. */
function actualMark(player, scale) {
  const points = scored(player);
  if (points == null) return "";
  const at = Math.max(0, Math.min(100, (points / scale) * 100));
  const where = points > player.ceiling ? " above" : points < player.floor ? " below" : "";
  return `<span class="rng-act${where}" style="left:${at.toFixed(1)}%" ` +
    `title="scored ${points.toFixed(1)}"></span>`;
}

/* The chip after a name. A bye and an injury are the two things that make a
 * projection a different kind of number rather than a smaller one, so they
 * are said on the row rather than left to the points.
 */
function chip(player) {
  if (player.flag === "bye") return '<span class="chip bye">bye</span>';
  if (player.flag === "unknown") return '<span class="chip unknown">no data</span>';
  if (player.locked) return '<span class="chip bye" title="his game has kicked off; Sleeper has locked him">locked</span>';
  if (!player.inj) return "";
  const short = { Questionable: "Q", Doubtful: "D", Out: "OUT", IR: "IR",
                  PUP: "PUP", Suspended: "SUSP" }[player.inj] ?? player.inj;
  const hard = player.plays === 0;
  const soft = player.plays > 0 && player.plays < 1;
  return `<span class="chip ${hard ? "out" : soft ? "doubt" : "quest"}" ` +
    `title="${esc(player.inj)}${hard ? " — projected at zero" : soft
      ? ` — plays ${pct(player.plays)} of the time` : " — not discounted"}">${esc(short)}</span>`;
}

function where(player) {
  if (player.flag === "bye") return "on bye";
  if (!player.opp) return "";
  return `${player.home ? "vs" : "@"} ${player.opp}`;
}

/* The one-line summary under a name: where the volume is coming from. The
 * full breakdown is behind the row; this is the part worth seeing without
 * clicking, because it is what a projection is mostly made of.
 */
function gist(player) {
  // A man who isn't playing has no week to describe, and "0.0 points against"
  // after "on bye" reads as a projection rather than as the absence of one.
  if (player.flag === "bye" || !player.parts) return "";
  if (player.source === "other") return sleeperGist(player);
  const parts = player.parts;
  if (player.pos === "QB" && parts.attempts != null) {
    return `${parts.attempts.toFixed(0)} att · ${pct(parts.cmp_rate ?? 0)} comp`;
  }
  if (player.pos === "K") return `${(parts.fga ?? 0).toFixed(1)} FG att`;
  if (player.pos === "DEF") return `${(parts.implied_against ?? 0).toFixed(1)} pts against`;
  const bits = [];
  if (parts.targets > 0.5) bits.push(`${parts.targets.toFixed(1)} tgt`);
  if (parts.carries > 0.5) bits.push(`${parts.carries.toFixed(1)} car`);
  if (parts.snap_share != null) bits.push(`${pct(parts.snap_share)} snaps`);
  return bits.join(" · ");
}

/* The same one-line summary, off Sleeper's stat line when the page runs on it,
 * so the line under a name never describes a different projection from the
 * number beside it. */
function sleeperGist(player) {
  const line = REPORT?.projections.get(player.id);
  if (!line) return "no Sleeper projection";
  if (player.pos === "QB") return `${(line.pass_att ?? 0).toFixed(0)} att · ${(line.pass_yd ?? 0).toFixed(0)} yds`;
  if (player.pos === "K") return `${(line.fga ?? 0).toFixed(1)} FG att`;
  if (player.pos === "DEF") return `${(line.sack ?? 0).toFixed(1)} sacks · ${(line.int ?? 0).toFixed(1)} int`;
  const bits = [];
  if ((line.rec_tgt ?? 0) > 0.5) bits.push(`${line.rec_tgt.toFixed(1)} tgt`);
  if ((line.rush_att ?? 0) > 0.5) bits.push(`${line.rush_att.toFixed(1)} car`);
  const yards = (line.rec_yd ?? 0) + (line.rush_yd ?? 0);
  if (yards > 0.5) bits.push(`${yards.toFixed(0)} yds`);
  return bits.join(" · ");
}

/* The breakdown, as the chain of multiplications it actually is.
 *
 * Printed as "a × b × c = d" rather than as a list of numbers, because the
 * useful thing about the decomposition is that it composes: a receiver's
 * targets are his team's dropbacks times his share of the snaps times what he
 * does with a pass snap, and seeing which of the three moved is the whole
 * reason to open the row.
 */
function breakdown(player) {
  if (player.source === "other") return sleeperBreakdown(player);
  const p = player.parts ?? {};
  if (!player.parts) return "<p class=\"bd-none\">No projection for this player.</p>";

  const rows = [];
  const row = (label, value, note = "") =>
    rows.push(`<li><span class="bd-k">${label}</span><span class="bd-v">${value}</span>` +
      (note ? `<span class="bd-n">${esc(note)}</span>` : "") + "</li>");

  if (player.pos === "DEF") {
    row("points against", (p.implied_against ?? 0).toFixed(1), "the opponent's implied total");
    row("yards against", (p.yards_against ?? 0).toFixed(0), "their recent form, regressed");
    row("sacks", (p.sacks ?? 0).toFixed(1));
    row("takeaways", (p.takeaways ?? 0).toFixed(1), "interceptions and fumbles recovered");
  } else if (player.pos === "K") {
    row("implied total", (p.implied ?? 0).toFixed(1), "half the total, plus half the spread");
    row("field goals", `${(p.fga ?? 0).toFixed(1)} × ${pct(p.fg_rate ?? 0)}`);
    row("extra points", (p.team_tds ?? 0).toFixed(2), "one per expected touchdown");
  } else if (player.pos === "QB") {
    row("attempts", `${(p.dropbacks ?? 0).toFixed(1)} dropbacks × ${pct(p.attempt_share ?? 0)}` +
      ` = ${(p.attempts ?? 0).toFixed(1)}`, "team dropbacks, and his share of them");
    row("yards per attempt", (p.yards_per_attempt ?? 0).toFixed(2),
      `${pct(p.cmp_rate ?? 0)} completed`);
    if (p.carries > 0.3) row("carries", (p.carries).toFixed(1));
    row("implied total", `${(p.implied ?? 0).toFixed(1)} → ${(p.team_tds ?? 0).toFixed(2)} TDs`);
    row("matchup", `×${(p.matchup_efficiency ?? 1).toFixed(2)} yards, ` +
      `×${(p.matchup_td ?? 1).toFixed(2)} TDs`, `${p.matchup_games ?? 0} games of defence`);
  } else {
    row("targets", `${(p.dropbacks ?? 0).toFixed(1)} × ${pct(p.snap_share ?? 0)} × ` +
      `${(p.targets_per_pass_snap ?? 0).toFixed(3)} = ${(p.targets ?? 0).toFixed(1)}`,
      "team dropbacks × his snap share × targets per pass snap");
    row("yards per target", (p.yards_per_target ?? 0).toFixed(2), `${pct(p.catch_rate ?? 0)} caught`);
    if (p.carries > 0.3) {
      row("carries", `${(p.rushes ?? 0).toFixed(1)} × ${pct(p.snap_share ?? 0)} × ` +
        `${(p.carries_per_run_snap ?? 0).toFixed(2)} = ${(p.carries).toFixed(1)}`);
      row("yards per carry", (p.yards_per_carry ?? 0).toFixed(2));
    }
    row("implied total", `${(p.implied ?? 0).toFixed(1)} → ${(p.team_tds ?? 0).toFixed(2)} TDs`,
      "half the game total, plus half the spread");
    row("matchup", `×${(p.matchup_volume ?? 1).toFixed(2)} targets, ` +
      `×${(p.matchup_efficiency ?? 1).toFixed(2)} yards, ×${(p.matchup_td ?? 1).toFixed(2)} TDs`,
      `${p.matchup_games ?? 0} games of defence, schedule-adjusted and regressed`);
  }

  const line = player.line
    ? Object.entries(player.line)
        .filter(([key, value]) => value >= 0.05 && !key.startsWith("pts_allow_") &&
          !key.startsWith("yds_allow_") && !key.startsWith("bonus_") && !key.startsWith("fgm_"))
        .map(([key, value]) => `${key} ${value.toFixed(value >= 10 ? 0 : 1)}`)
        .join("  ")
    : "";

  return `<ul class="bd">${rows.join("")}</ul>` +
    (line ? `<p class="bd-line">${esc(line)}</p>` : "") +
    `<p class="bd-games">${player.games} game${player.games === 1 ? "" : "s"} of evidence</p>`;
}

/* Points scored so far, for a player whose game has kicked off. Blank for
 * anyone still to play, so the column only ever holds something real. */
/* What a player scored, once there is anything to show: his game has kicked
 * off, or the whole week is in the past. Null otherwise. */
function scored(player) {
  if (!player || !ACTUAL || !(player.locked || WEEK?.past)) return null;
  return ACTUAL.get(player.id) ?? null;
}

function actual(player) {
  const points = scored(player);
  if (points == null) return "";
  // Coloured the same as the dot on the bar, so the two read together. A
  // projection with no range (Sleeper's) is judged against its one number:
  // green if he beat it, red if he fell short.
  const where = player.ceiling > player.floor
    ? (points > player.ceiling ? "above" : points < player.floor ? "below" : "")
    : (points > worth(player) ? "above" : points < worth(player) ? "below" : "");
  return `<span class="act${where ? ` ${where}` : ""}">${points.toFixed(1)}</span>`;
}

// Sleeper's projection is one number, so there is no range to draw: the
// column is left out rather than sitting empty.
const rangeCell = (html) => (METHOD === "ours" ? `<td class="c-range">${html}</td>` : "");

function playerRow(label, player, scale, { note = "" } = {}) {
  if (!player) {
    return '<tbody class="pl empty"><tr class="pl-row">' +
      `<td class="c-slot">${esc(label)}</td>` +
      '<td class="c-who"><span class="pl-name">nobody</span>' +
      '<span class="pl-meta">no one on the roster can take this slot</span></td>' +
      rangeCell("") + '<td class="c-pts">—</td><td class="c-act"></td></tr></tbody>';
  }
  const open = OPEN.has(player.id);
  const ranged = player.ceiling > player.floor;
  return `<tbody class="pl${open ? " open" : ""}">` +
    `<tr class="pl-row" data-id="${esc(player.id)}" tabindex="0" role="button"` +
      ` aria-expanded="${open}" title="click for the breakdown">` +
      `<td class="c-slot">${esc(label)}</td>` +
      '<td class="c-who">' +
        `<span class="pl-name">${esc(player.name ?? player.id)}${chip(player)}</span>` +
        `<span class="pl-meta">${esc([player.pos, player.team, where(player), gist(player)]
          .filter(Boolean).join(" · "))}${note ? ` <b>${esc(note)}</b>` : ""}</span></td>` +
      rangeCell(bar(player, scale)) +
      `<td class="c-pts">${worth(player).toFixed(1)}` +
        (ranged ? `<span class="c-pts-rng">${player.floor.toFixed(0)}–${player.ceiling.toFixed(0)}</span>` : "") +
      "</td>" +
      `<td class="c-act">${actual(player)}</td>` +
    "</tr>" +
    `<tr class="detail"><td colspan="${METHOD === "ours" ? 5 : 4}"><div class="detail-in">${breakdown(player)}</div></td></tr>` +
    "</tbody>";
}

/* A total's range in brackets, or nothing when the projection is a single
 * number (Sleeper's has no range). */
const range = (total) => (total.ceiling > total.floor
  ? ` (${total.floor.toFixed(0)}–${total.ceiling.toFixed(0)})` : "");

/* A week already played: what you started scored, what it was projected to,
 * and what the projected best lineup would actually have scored — the honest
 * test of whether following the page would have helped. */
function pastVerdict() {
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const yours = sum(scoredBy(CARD.current));
  const projected = CARD.totals.current.points;
  if (!CARD.moves.length) {
    return '<div class="verdict ok"><b>You started the projected best lineup.</b> ' +
      `Projected <b>${projected.toFixed(1)}</b>, scored <b>${yours.toFixed(1)}</b>.</div>`;
  }
  const theirs = sum(scoredBy(CARD.optimal));
  const diff = theirs - yours;
  const tone = diff > 0.05 ? "act" : "ok";
  return `<div class="verdict ${tone}">You scored <b>${yours.toFixed(1)}</b> (projected ` +
    `${projected.toFixed(1)}). The projected best lineup would have scored <b>${theirs.toFixed(1)}</b> — ` +
    (Math.abs(diff) < 0.05 ? "the same." : diff > 0
      ? `<b>${signed(diff)}</b> better.` : `${signed(diff)}, so your lineup did better.`) + "</div>";
}

function verdict() {
  if (WEEK.past) return pastVerdict();
  const gain = CARD.totals.optimal.points - CARD.totals.current.points;
  const started = CARD.current.filter((s) => s.player).length;

  if (!started) {
    return '<div class="verdict none"><b>No lineup saved in Sleeper yet.</b> ' +
      "What is below is the best one off this roster.</div>";
  }
  if (!CARD.moves.length) {
    return '<div class="verdict ok"><b>The lineup you have in is the best one.</b> ' +
      `Projected <b>${CARD.totals.optimal.points.toFixed(1)}</b>${range(CARD.totals.optimal)}.</div>`;
  }
  return '<div class="verdict act">' +
    `<b>${CARD.moves.length} change${CARD.moves.length === 1 ? "" : "s"}</b>, worth ` +
    `<b>${signed(gain)}</b> points — ${CARD.totals.current.points.toFixed(1)} now, ` +
    `${CARD.totals.optimal.points.toFixed(1)} after.</div>`;
}

/* "Addison beats Swift 63% of the time": how often, across the simulated
 * weeks, the first outscores the second. Only on the Simulated projection —
 * Sleeper's is one number each, which says nothing about how often — and only
 * when both are playing, because beating a man on bye says nothing either. */
function head(winner, loser, odds) {
  if (odds == null || !winner || !loser || winner.plays === 0 || loser.plays === 0 ||
      winner.flag === "bye" || loser.flag === "bye") return "";
  return `<span class="mv-odds">${esc(winner.name)} beats ${esc(loser.name)} ` +
    `${pct(odds)} of the time</span>`;
}

/* For a change whose games have been played: what it actually came to. */
function swing(move) {
  const a = scored(move.in);
  const b = move.out ? scored(move.out) : 0;
  if (a == null || b == null) return "";
  const diff = a - b;
  return `<span class="mv-act ${diff >= 0 ? "up" : "down"}">actually ${signed(diff)}: ` +
    `${esc(move.in.name)} ${a.toFixed(1)}${move.out ? `, ${esc(move.out.name)} ${b.toFixed(1)}` : ""}</span>`;
}

function movesHtml() {
  if (!CARD.moves.length) return "";
  const rows = CARD.moves.map((move) => {
    const what = move.in && move.out
      ? `<b>${esc(move.in.name)}</b> in for ${esc(move.out.name)}`
      : move.in ? `start <b>${esc(move.in.name)}</b>`
      : `sit <b>${esc(move.out.name)}</b> — nobody on the bench can take the slot`;
    return '<li class="mv">' +
      `<span class="mv-slot">${esc(move.slot ?? "")}</span>` +
      `<span class="mv-what">${what}</span>` +
      `<span class="mv-gain">${signed(move.gain)}</span>` +
      head(move.in, move.out, move.odds) + swing(move) + "</li>";
  });
  const title = WEEK.past ? "What it would have changed" : "Changes";
  return `<section class="block"><h2>${title}</h2><ul class="mvs">` + rows.join("") + "</ul></section>";
}

function callsHtml() {
  // A finished week has no decision left in it to call close.
  if (!CARD.calls.length || WEEK.past) return "";
  const rows = CARD.calls.map((call) =>
    '<li class="mv">' +
    `<span class="mv-slot">${esc(call.slot)}</span>` +
    `<span class="mv-what"><b>${esc(call.start.name)}</b> over ${esc(call.over.name)}</span>` +
    `<span class="mv-gain thin">${signed(call.gap)}</span>` +
    head(call.start, call.over, call.odds == null ? null : 1 - call.odds) + "</li>");
  return '<section class="block"><h2>Too close to matter</h2>' +
    `<p class="block-note">Less than ${CLOSE_POINTS} points apart. Either is a fine start.</p>` +
    '<ul class="mvs">' + rows.join("") + "</ul></section>";
}

function footnotes() {
  const notes = [];
  if (CARD.missing.length) {
    notes.push(`${CARD.missing.length} player${CARD.missing.length === 1 ? "" : "s"} on this ` +
      "roster have not taken a snap this season, so there is nothing to project them from: " +
      CARD.missing.map((p) => esc(p.id)).join(", ") + ".");
  }
  if (CARD.unscored.length) {
    notes.push("This league scores " + CARD.unscored.map((k) => `<code>${esc(k)}</code>`).join(", ") +
      ", which nothing here projects — every player is a little low by the same amount.");
  }
  if (WEEK.past) {
    notes.push(`Week ${CARD.week} is over. The projections are what this page would have shown ` +
      `before it, built from weeks 1–${CARD.through} only. Sleeper keeps no history of injury tags, ` +
      "so anyone who didn't play that week counts as out — about what the inactives list told you at kickoff. " +
      "The lineup is the one you had in Sleeper that week.");
  } else if (INDEX && CARD.week < INDEX.current) {
    notes.push(`Week ${CARD.week} is still being played. Anyone whose game has kicked off is ` +
      "locked in Sleeper, so only the seats still to play are a decision.");
  }
  if (METHOD === "sleeper") {
    notes.push(REPORT
      ? "Projections are Sleeper's, scored under this league's settings. Anyone not expected to play is at zero."
      : "Sleeper's projections didn't load, so there is nothing to show for them — switch back to Simulated.");
  }
  const built = new Date(CARD.generated);
  if (WEEK.past) {
    notes.push(`Built ${built.toLocaleString()}.`);
    return '<div class="foot">' + notes.map((n) => `<p>${n}</p>`).join("") + "</div>";
  }
  notes.push(REPORT
    ? `Injury tags and Sleeper's projections live as of ${new Date(REPORT.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}; ` +
      `the rest was built ${built.toLocaleString()} from weeks 1–${CARD.through}.`
    : `Sleeper's injury report didn't answer, so these use the tags from the build at ` +
      `${built.toLocaleString()}, from weeks 1–${CARD.through}.`);
  return '<div class="foot">' + notes.map((n) => `<p>${n}</p>`).join("") + "</div>";
}

/* Points the lineup Sleeper has saved has scored so far, once any of its
 * games have kicked off. */
const scoredBy = (seats) => seats.map((s) => scored(s.player)).filter((p) => p != null);

function actualTotal() {
  const points = scoredBy(CARD.current);
  if (!points.length) return "";
  const total = points.reduce((a, b) => a + b, 0);
  return WEEK.past ? ` · you scored <b>${total.toFixed(1)}</b>` : ` · scored so far <b>${total.toFixed(1)}</b>`;
}

function render() {
  const everyone = [...CARD.optimal.map((s) => s.player), ...CARD.bench].filter(Boolean);
  const scale = Math.max(12, ...everyone.map((p) => Math.max(p.ceiling, scored(p) ?? 0))) * 1.02;

  $("standing").innerHTML =
    `Week <b>${CARD.week}</b> · through week <b>${CARD.through}</b> · ` +
    `best lineup <b>${CARD.totals.optimal.points.toFixed(1)}</b>${range(CARD.totals.optimal)}` +
    actualTotal();

  // A finished week shows the lineup you actually had, because projected
  // against actual is the point of looking back; the changes above say what
  // the projection would have done differently. A live week shows the
  // projection's best lineup, with the newcomers marked.
  const past = WEEK.past;
  const lineup = past ? CARD.current : CARD.optimal;
  const startedIds = new Set(lineup.map((s) => s.player?.id).filter(Boolean));
  const benched = past
    ? [...CARD.optimal.map((s) => s.player), ...CARD.bench].filter((p) => p && !startedIds.has(p.id))
    : CARD.bench;
  const starters = lineup.map(({ slot, player }) => {
    const moved = !past && CARD.moves.find((m) => m.in?.id === player?.id);
    const dropped = past && CARD.moves.find((m) => m.out?.id === player?.id);
    return playerRow(slot, player, scale, { note: moved ? "new" : dropped ? "would sit" : "" });
  }).join("");

  const bench = benched.length
    ? benched.map((player) => playerRow("BN", player, scale)).join("")
    : '<tbody class="pl empty"><tr class="pl-row"><td class="c-slot">BN</td>' +
      '<td class="c-who"><span class="pl-name">nobody</span></td>' +
      rangeCell("") + '<td class="c-pts">—</td><td class="c-act"></td></tr></tbody>';

  const table = (rows) => '<table class="tbl">' +
    '<thead><tr><th class="c-slot">Slot</th><th class="c-who">Player</th>' +
    (METHOD === "ours" ? '<th class="c-range">Range</th>' : "") +
    '<th class="c-pts">Proj</th>' +
    '<th class="c-act" title="points scored so far, once his game has kicked off">Actual</th>' +
    "</tr></thead>" + rows + "</table>";

  $("card").innerHTML =
    verdict() +
    movesHtml() +
    `<section class="block"><h2>${past ? "You started" : "Start"}</h2>` + table(starters) + "</section>" +
    callsHtml() +
    '<section class="block"><h2>Bench</h2>' + table(bench) + "</section>" +
    footnotes();
}

/* ---------- fetching ---------- */

const note = (text) => { $("status-note").textContent = text || ""; };

async function showLeague(leagueId) {
  LEAGUE = LEAGUES.find((l) => l.league_id === leagueId) || LEAGUES[0];
  if (!LEAGUE) return;
  syncUrl();

  $("card").innerHTML = '<p class="status">Reading your roster…</p>';
  $("standing").textContent = "";

  const rosters = await sleeper.getLeagueRosters(LEAGUE.league_id);
  const mine = rosters.find((r) => r.owner_id === USER.user_id)
    ?? rosters.find((r) => (r.co_owners ?? []).includes(USER.user_id));

  if (!mine) {
    $("card").innerHTML = '<p class="status">No roster in this league belongs to you — ' +
      "it may be a league you were removed from.</p>";
    return;
  }

  // Points scored so far this week, from the league's own matchups — already
  // under its scoring. Nothing to show if Sleeper doesn't answer. For a week
  // already played the matchup is also where that week's roster and lineup
  // live; the roster above is today's.
  let entry = null;
  try {
    const matchups = await sleeper.getMatchups(LEAGUE.league_id, WEEK.week);
    entry = matchups.find((m) => m.roster_id === mine.roster_id) ?? null;
  } catch { /* no actuals */ }
  ACTUAL = entry?.players_points ? new Map(Object.entries(entry.players_points)) : null;
  const roster = WEEK.past && entry?.players?.length
    ? { ...mine, players: entry.players, starters: entry.starters ?? [] }
    : mine;

  const scoring = scoringFor(LEAGUE, null);
  CARD = lineupCard({
    bundle: WEEK,
    roster,
    league: LEAGUE,
    scoring,
    points: METHOD === "sleeper" ? sleeperPoints(scoring) ?? new Map() : null,
  });
  OPEN.clear();
  render();
}

/* ---------- the start screen ---------- */

function showStart(message) {
  $("start").hidden = false;
  $("app").hidden = true;
  $("start-error").innerHTML = message || "";
  $("start-error").hidden = !message;
  $("username").focus();
}

function startBusy(busy, text) {
  $("start-go").disabled = busy;
  $("username").disabled = busy;
  $("start-note").textContent = text || "";
}

async function signIn(username, wanted = {}) {
  startBusy(true, "looking you up…");
  try {
    const user = await sleeper.getUser(username);
    if (!user) { showStart(`No Sleeper user called “${esc(username)}”.`); startBusy(false); return; }

    USER = { ...user, username };
    const state = await sleeper.getState();
    SEASON = wanted.season || state.season;

    startBusy(true, "finding your leagues…");
    LEAGUES = await sleeper.getUserLeagues(USER.user_id, SEASON);
    if (!LEAGUES.length) {
      showStart(`${esc(user.display_name)} isn't in any ${SEASON} leagues on Sleeper.`);
      startBusy(false);
      return;
    }

    startBusy(true, "loading this week's projections…");
    INDEX = await loadIndex();
    const entry = INDEX.weeks.find((w) => w.week === Number(wanted.week)) ?? INDEX.latest;
    BUNDLE = await loadBundle(entry);
    startBusy(true, "checking the injury report…");
    await finishWeek();
    fillWeeks();

    $("start").hidden = true;
    $("app").hidden = false;
    $("who").textContent = user.display_name;
    $("season").textContent = BUNDLE.season;
    $("week").textContent = BUNDLE.week;

    const picked = LEAGUES.some((l) => l.league_id === wanted.league)
      ? wanted.league : LEAGUES[0].league_id;
    const pick = $("league-pick");
    pick.innerHTML = LEAGUES.map((l) =>
      `<option value="${esc(l.league_id)}"${l.league_id === picked ? " selected" : ""}>` +
      esc(l.name) + "</option>").join("");
    pick.disabled = LEAGUES.length < 2;

    await showLeague(picked);
    startBusy(false);
  } catch (err) {
    if (err instanceof Idle) {
      showStart(esc(err.message));
      startBusy(false);
      return;
    }
    console.error(err);
    // A missing bundle is the one failure a reader can do something about, so
    // it says what to run rather than "something went wrong".
    const missing = /no projections published|couldn't load|names no week/.test(err.message ?? "");
    showStart(missing
      ? `${esc(err.message)}.<br>Run <code>npm run lineup</code> to build this week's ` +
        "projections, then reload."
      : esc(err.message || "Sleeper didn't answer. Try again in a moment."));
    startBusy(false);
  }
}

/* ---------- boot ---------- */

function onCardClick(e) {
  const row = e.target.closest(".pl-row");
  if (!row || !row.dataset.id) return;
  const id = row.dataset.id;
  if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id);
  row.closest(".pl").classList.toggle("open", OPEN.has(id));
  row.setAttribute("aria-expanded", String(OPEN.has(id)));
}

function wire() {
  $("card").addEventListener("click", onCardClick);
  $("card").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!e.target.closest(".pl-row")) return;
    e.preventDefault();
    onCardClick(e);
  });

  $("league-pick").addEventListener("change", (e) => showLeague(e.target.value));
  $("week-pick").addEventListener("change", (e) => showWeek(e.target.value));
  $("proj-pick").addEventListener("change", (e) => {
    METHOD = e.target.value === "sleeper" ? "sleeper" : "ours";
    showLeague(LEAGUE?.league_id);
  });

  $("switch-user").addEventListener("click", () => {
    USER = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to forget */ }
    history.replaceState(null, "", location.pathname);
    $("username").value = "";
    showStart();
  });

  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = $("username").value.trim();
    if (username) signIn(username);
  });
}

function main() {
  wire();
  const params = new URLSearchParams(location.search);
  const linked = params.get("user");
  const remembered = readSession();
  METHOD = (params.get("proj") ?? remembered?.proj) === "sleeper" ? "sleeper" : "ours";
  $("proj-pick").value = METHOD;

  if (linked) {
    $("username").value = linked;
    signIn(linked, { league: params.get("league"), week: params.get("week") });
  } else if (remembered?.username) {
    $("username").value = remembered.username;
    signIn(remembered.username, { league: remembered.league });
  } else {
    showStart();
  }
}

main();
