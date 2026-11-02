/* The luck table.
 *
 * Same shape as the board next door: everything comes from one Sleeper
 * username, nothing is hardcoded, and there is no server. The username gives
 * the leagues, a league gives its rosters and every week's scores, and
 * js/luck.js turns those into the standings the schedule would have produced.
 *
 * The arithmetic lives in js/luck.js and is tested there. This file fetches and
 * draws, and is deliberately the only half that knows what a DOM is.
 */

import { SleeperClient } from "./sleeper.js";
import { IndexedDbCache } from "./cache-idb.js";
import { luckTable } from "./luck.js";

const SESSION_KEY = "luck:session";

const cache = new IndexedDbCache();
const sleeper = new SleeperClient({ cache });

let USER = null;
let SEASON = null;
let WEEK = 1;            // the week Sleeper says the NFL is on
let LEAGUES = [];
let LEAGUE = null;
let TABLE = null;
const OPEN = new Set();  // roster ids whose week-by-week is unfolded

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const signed = (n, digits = 0) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(digits);

/* ---------- the session ---------- */

/* The address bar is how a table gets bookmarked or sent to the league;
 * localStorage is how it comes back without one. Written together, so the page
 * never remembers you one way and not the other.
 */
function syncUrl() {
  const params = new URLSearchParams();
  if (USER) params.set("user", USER.username ?? USER.display_name);
  if (LEAGUE) params.set("league", LEAGUE.league_id);
  history.replaceState(null, "", params.toString() ? "?" + params : location.pathname);
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      username: USER?.username, league: LEAGUE?.league_id,
    }));
  } catch { /* storage off; the url still works */ }
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

/* ---------- drawing ---------- */

/* The luck meter: one bar, growing out of the middle line, left for a season
 * that has gone against you and right for one that hasn't.
 *
 * Diverging rather than a fill from the left, because the number is a
 * deviation and the middle is the meaningful value — a fill would draw
 * "average" as half full, which reads as half bad. Green for lucky and red for unlucky, the
 * same pair as a win and a loss. Deutan vision can't separate those two, so
 * the colour is never carrying the reading alone: which side of the middle
 * line the bar grows on says the same thing, and the length says how far.
 *
 * The exact score is not printed. The bar is the reading; the number is there
 * on hover (the cell's title) for anyone who wants it, and as the meter's
 * label for a screen reader, which has no bar to look at.
 */
/* The width is a percentage of the whole track while the bar only owns half
 * of it, so ±100 is 50% and a score is halved to draw it. Get that wrong and
 * a big score runs past the end of the track.
 */
function meter(luck) {
  const side = luck >= 0 ? "up" : "down";
  const width = Math.min(Math.abs(luck) / 2, 50);
  return `<span class="meter" role="img" aria-label="Luck ${signed(luck)}">` +
    '<span class="meter-mid"></span>' +
    `<span class="meter-bar ${side}" style="width:${width.toFixed(1)}%"></span>` +
    "</span>";
}

function weekHtml(w) {
  // The flag rides on the opponent's name: it is a verdict on that matchup,
  // and most weeks have none, so a column of its own was mostly empty space.
  const mark = w.stolen ? '<span class="flag stolen">robbed</span>'
    : w.gifted ? '<span class="flag gifted">gifted</span>' : "";
  const result = w.tied ? "T" : w.won ? "W" : "L";
  // How the opponent did against the week, not against you: this is the "did
  // they have a good game on me" column, and the sign is what matters.
  const vs = w.oppPoints - w.leagueAvg;
  return '<li class="wk">' +
    `<span class="wk-no">wk ${w.week}</span>` +
    `<span class="wk-res ${result}">${result}</span>` +
    `<span class="wk-score wk-me">${w.points.toFixed(1)}</span>` +
    `<span class="wk-dash">vs</span>` +
    `<span class="wk-opp"><span class="wk-opp-name">${esc(w.opponent)}</span>${mark}</span>` +
    `<span class="wk-score wk-them">${w.oppPoints.toFixed(1)}</span>` +
    `<span class="wk-vs" title="their score against the league's ${w.leagueAvg.toFixed(1)} that week">` +
      `${signed(vs, 1)} vs week</span>` +
    "</li>";
}

function rowHtml(r) {
  const open = OPEN.has(r.rosterId);
  const swing = r.placeSwing === 0 ? "—" : signed(r.placeSwing);
  const swingClass = r.placeSwing > 0 ? "up" : r.placeSwing < 0 ? "down" : "flat";
  const record = `${r.wins}-${r.losses}` + (r.ties ? `-${r.ties}` : "");
  const expRecord = `${r.expectedWins.toFixed(1)}-${r.expectedLosses.toFixed(1)}`;

  // The opponents' side of schedule luck, signed the way the week rows sign
  // it: plus means they scored above the league that week, which is bad for
  // you. scheduleLuckPerWeek runs the other way (plus is good for you), and
  // printing it straight into a sentence about the opponents' scoring said
  // "-10.4 off the average — a hard draw" for opponents who were 10.4 above.
  const oppVsWeek = -r.scheduleLuckPerWeek;
  const draw = oppVsWeek > 0 ? "above the league average — a hard draw"
    : oppVsWeek < 0 ? "below the league average — a soft draw"
    : "right on the league average — an even draw";

  return '<tbody class="team' + (open ? " open" : "") + '">' +
    `<tr class="team-row" data-roster="${r.rosterId}" tabindex="0" role="button"` +
      ` aria-expanded="${open}" title="click for the week by week">` +
      `<td class="c-place">${r.place}</td>` +
      '<td class="c-team"><span class="tm-name">' + esc(r.team) + "</span>" +
        '<span class="tm-mgr">' + esc(r.manager) + "</span></td>" +
      `<td class="c-rec">${record}</td>` +
      // The title is on the whole cell rather than the 12px bar, so the
      // number turns up wherever in the column you happen to hover.
      `<td class="c-luck" title="Luck ${signed(r.luck)}">` + meter(r.luck) + "</td>" +
      `<td class="c-exp">${r.expectedPlace}<span class="c-exp-rec">${expRecord}</span></td>` +
      `<td class="c-swing ${swingClass}">${swing}</td>` +
    "</tr>" +
    '<tr class="detail"><td colspan="6">' +
      '<div class="detail-in">' +
        '<p class="detail-sum">' +
          `Scored <b>${r.pointsFor.toFixed(1)}</b>, allowed <b>${r.pointsAgainst.toFixed(1)}</b>. ` +
          `Beat the field ${(r.expectedWins / Math.max(r.gamesPlayed, 1) * 100).toFixed(0)}% of the time ` +
          `for ${r.expectedWins.toFixed(2)} wins, and has <b>${signed(r.recordLuck, 2)}</b> against that. ` +
          `Opponents averaged <b>${signed(oppVsWeek, 1)}</b> vs week against them, ` +
          `${draw}.` +
        "</p>" +
        '<ul class="wks">' + r.weeks.map(weekHtml).join("") + "</ul>" +
      "</div>" +
    "</td></tr>" +
    "</tbody>";
}

function render() {
  const { rows, throughWeek } = TABLE;

  if (!throughWeek) {
    $("table-wrap").innerHTML =
      '<p class="status">No finished weeks in this league yet — the table fills in ' +
      "once a scoring week is over.</p>";
    $("standing").textContent = "";
    return;
  }

  const luckiest = [...rows].sort((a, b) => b.luck - a.luck)[0];
  const unluckiest = [...rows].sort((a, b) => a.luck - b.luck)[0];
  $("standing").innerHTML =
    `Through <b>week ${throughWeek}</b> · ${rows.length} teams · ` +
    `luckiest <b>${esc(luckiest.team)}</b> · ` +
    `unluckiest <b>${esc(unluckiest.team)}</b>`;

  $("table-wrap").innerHTML =
    '<table class="tbl">' +
      "<thead><tr>" +
        '<th class="c-place" title="where the league has them now">#</th>' +
        '<th class="c-team">Team</th>' +
        '<th class="c-rec">Rec</th>' +
        '<th class="c-luck" title="Hover a bar for the score: 0 is average for this league, ±100 is two standard deviations">Luck</th>' +
        '<th class="c-exp" title="place on the all-play record, and that record">Exp</th>' +
        '<th class="c-swing" title="places the schedule has moved them">Swing</th>' +
      "</tr></thead>" +
      rows.map(rowHtml).join("") +
    "</table>";
}

/* ---------- fetching ---------- */

function note(text) {
  $("status-note").textContent = text || "";
}

/* One league's table.
 *
 * The weeks are fetched in parallel and only as far as the season has got:
 * asking for week 14 in October is a round trip for a row of zeroes. Playoff
 * weeks are never asked for at all — js/luck.js would drop them anyway.
 *
 * The week in progress is not fetched either. Sleeper's state.week is the week
 * being played, so the last finished one is the one before it — a live week is
 * a scoreboard, and a scoreboard read as a result is how the table ends up a
 * game ahead of the league's own standings.
 */
async function showLeague(leagueId) {
  LEAGUE = LEAGUES.find((l) => l.league_id === leagueId) || LEAGUES[0];
  if (!LEAGUE) return;
  syncUrl();

  $("table-wrap").innerHTML = '<p class="status">Reading the season…</p>';
  $("standing").textContent = "";

  const playoffs = LEAGUE.settings?.playoff_week_start || 15;
  const done = Math.min(playoffs - 1, WEEK - 1);

  if (done < 1) {
    TABLE = luckTable({ matchups: {}, rosters: [], users: [], league: LEAGUE });
    render();
    return;
  }

  note(`fetching ${done} week${done === 1 ? "" : "s"} of scores…`);
  const [rosters, users, ...weeks] = await Promise.all([
    sleeper.getLeagueRosters(LEAGUE.league_id),
    sleeper.getLeagueUsers(LEAGUE.league_id),
    ...Array.from({ length: done }, (_, i) => sleeper.getMatchups(LEAGUE.league_id, i + 1)),
  ]);
  note("");

  const matchups = {};
  weeks.forEach((rows, i) => { matchups[i + 1] = rows; });

  TABLE = luckTable({ matchups, rosters, users, league: LEAGUE, completedThrough: done });
  OPEN.clear();
  render();
}

/* ---------- the start screen ---------- */

function showStart(message) {
  $("start").hidden = false;
  $("app").hidden = true;
  $("start-error").textContent = message || "";
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
    if (!user) { showStart(`No Sleeper user called “${username}”.`); startBusy(false); return; }

    USER = { ...user, username };
    const state = await sleeper.getState();
    SEASON = wanted.season || state.season;
    WEEK = Number(state.week) || 1;

    startBusy(true, "finding your leagues…");
    LEAGUES = await sleeper.getUserLeagues(USER.user_id, SEASON);
    if (!LEAGUES.length) {
      showStart(`${user.display_name} isn't in any ${SEASON} leagues on Sleeper.`);
      startBusy(false);
      return;
    }

    $("start").hidden = true;
    $("app").hidden = false;
    $("who").textContent = user.display_name;
    $("season").textContent = SEASON;

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
    console.error(err);
    showStart(err.message || "Sleeper didn't answer. Try again in a moment.");
    startBusy(false);
  }
}

/* ---------- boot ---------- */

function onTableClick(e) {
  const row = e.target.closest(".team-row");
  if (!row) return;
  const id = Number(row.dataset.roster);
  if (OPEN.has(id)) OPEN.delete(id); else OPEN.add(id);
  row.closest(".team").classList.toggle("open", OPEN.has(id));
  row.setAttribute("aria-expanded", String(OPEN.has(id)));
}

function wire() {
  $("table-wrap").addEventListener("click", onTableClick);
  $("table-wrap").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!e.target.closest(".team-row")) return;
    e.preventDefault();
    onTableClick(e);
  });

  $("league-pick").addEventListener("change", (e) => showLeague(e.target.value));

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

/* A link wins over a remembered session: it is the league somebody just chose,
 * and following it into last week's instead would be wrong every time.
 */
function main() {
  wire();
  const params = new URLSearchParams(location.search);
  const linked = params.get("user");
  const remembered = readSession();

  if (linked) {
    $("username").value = linked;
    signIn(linked, { league: params.get("league") });
  } else if (remembered?.username) {
    $("username").value = remembered.username;
    signIn(remembered.username, { league: remembered.league });
  } else {
    showStart();
  }
}

main();
