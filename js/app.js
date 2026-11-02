/* The draft board.
 *
 * Everything on this page is derived from one thing: a Sleeper username. That
 * gives the leagues, the leagues give the drafts, the draft gives the picks and
 * the seat we're drafting from, and the projections give every player worth
 * listing. Nothing is hardcoded, nothing is loaded beforehand, and there is no
 * server — the page talks to Sleeper directly and prices the board itself.
 *
 * The one exception is the newest historical season's grades: the context no projection
 * carries — how good the offense is, how secure the role is, how many games he
 * will actually play, and how much room sits above the mean case. That is the
 * only opinion the board ships, and it is why the value column is worth more
 * than the ADP it sits next to.
 */

import { SleeperClient } from "./sleeper.js";
import { IndexedDbCache } from "./cache-idb.js";
import { buildPool, draftState, draftShape, draftFormat, adpKey } from "./pool.js";
import { ourPicks } from "./value.js";
import { loadGrades } from "./grades.js";

// Sleeper's own player page, which is the thing worth reading when a name on
// the list needs a second look. Team defenses key on the abbreviation and work
// on the same shape (.../ATL).
const SLEEPER_PLAYER = "https://sleeper.com/nfl/players/";

// Mock drafts can't be listed from Sleeper's API — a mock started cold belongs
// to no league — so the id has to come from the url a mock hands out:
// /draft/nfl/<id>, plain or under /beta/.
const DRAFT_URL_RE = /sleeper\.com\/(?:beta\/)?draft\/nfl\/(\d+)/;

const FLEXOK = ["RB", "WR", "TE"];
// The positions worth counting on the roster strip, in the order they're said.
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const SCORING = { half_ppr: "Half PPR", ppr: "PPR", std: "Standard", "2qb": "2QB" };

// Three seconds is the cadence js/sleeper.js documents for a draft loop: 20
// polls a minute, well under Sleeper's 1000. Ten was too slow to be live —
// bots in a mock pick every couple of seconds, so a ten-second tick could open
// with most of a round already gone, and the board would show it without ever
// looking broken.
const POLL_MS = 3000;

// How stale the board may get before it says so out loud. Comfortably past a
// poll or two lost to a hiccup, comfortably short of a round going by while the
// light sits there looking healthy.
const STALE_MS = 15000;

const LIVE_KEY = "draft-board:live";
const COLLAPSE_KEY = "draft-board:collapsed";
const SESSION_KEY = "draft-board:session";
const FAVORITES_KEY = "draft-board:favorites";

const cache = new IndexedDbCache();
const sleeper = new SleeperClient({ cache });

let USER = null;         // {user_id, display_name} — everything hangs off this
let SEASON = null;
let GRADES = {};
let PROJECTIONS = [];
let LEAGUES = [];
let LEAGUE = null;       // the league on show
let DRAFT = null;        // the draft on show, flattened, or null
let DRAFTS = [];
let SLOTS = [];
let PLAYERS = [];        // every player with an ADP, best first
let BY_ID = new Map();   // player_id -> the row above, for pricing one in place
let TURNS = [];          // our own trips to the board, in order
let COLLAPSED = new Set();

// Who's off the board is the draft's answer, not ours.
let DRAFTED = new Set();
let MINE = [];

// Players marked out by hand, for this league. Emphasis and nothing else: a
// favorite is on the list either way, at whatever ADP puts him.
let FAVORITES = new Set();

// What each player is worth to us, computed in the worker.
let VALUES = new Map();
let RECOMMENDED = new Set();

// Two different things, kept apart on purpose. ARMED is what the button says
// and what survives a reload; LIVE is whether a timer is actually running. They
// come apart when the tab is hidden — the light stays on, the polling doesn't,
// and coming back to the tab starts it again without anything to click.
let ARMED = false;
let LIVE = null;

let POLLING = false;
let POLL_SEQ = 0;
let LAST_OK = 0;
let AT_PICK = 0;

/* ---------- the worker ---------- */

// Pricing is a few hundred milliseconds of arithmetic that must not land on
// the thread keeping the page scrollable. The worker holds the pool; each poll
// sends it only the picks.
let worker = null;
let workerSeq = 0;
const pending = new Map();

function valueWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    data.ok ? waiting.resolve(data.result) : waiting.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    for (const { reject } of pending.values()) reject(new Error(event.message || "the value worker failed"));
    pending.clear();
  };
  return worker;
}

function ask(type, payload) {
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    valueWorker().postMessage({ id, type, payload });
  });
}

/* ---------- small helpers ---------- */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const title = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const formatEdge = (edge) => (edge > 0 ? "+" : "") + edge.toFixed(0);
const $ = (id) => document.getElementById(id);

function valueCell(playerId) {
  const v = VALUES.get(playerId);
  return v ? '<span class="val">' + formatEdge(v.value) + "</span>" : '<span class="val"></span>';
}

let toastTimer = null;
function toast(message, isError) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 1800);
}

/* ---------- our picks ---------- */

// Consecutive pick numbers are one trip to the board, not two: a snake turns at
// the end of the round and hands back the next pick straight away. Grouping
// them means pick 24 and pick 25 read as the single decision they are.
function asTurns(picks) {
  const turns = [];
  for (const pick of picks) {
    const last = turns[turns.length - 1];
    if (last && pick.pick_no === last[last.length - 1].pick_no + 1) last.push(pick);
    else turns.push([pick]);
  }
  return turns;
}

function myPicks() {
  if (!DRAFT || !DRAFT.teams || !DRAFT.rounds || !DRAFT.draft_order) return [];
  const numbers = ourPicks(DRAFT, new Set([USER.user_id]));
  return numbers.map((pick_no, index) => ({ round: index + 1, pick_no }));
}

// "2.12" — the round and the seat within it, which is how a pick gets talked
// about out loud.
function slotLabel(pick) {
  if (!DRAFT?.teams) return "";
  const place = pick.pick_no - (pick.round - 1) * DRAFT.teams;
  return pick.round + "." + String(place).padStart(2, "0");
}

const roundLabel = (rounds) => (rounds.length > 1 ? "Rounds " : "Round ") + rounds.join(" / ");

/* ---------- pickers ---------- */

const leagueLabel = (l) => [l.name, l.season].filter(Boolean).join(" · ");

function draftLabel(d, all) {
  const bits = [d.league_id ? "League draft" : "Mock draft"];
  // Two mocks off one league would otherwise read identically.
  if (!d.league_id && all.filter((x) => !x.league_id).length > 1) bits.push("#" + d.draft_id.slice(-4));
  if (d.status) bits.push(d.status.replace(/_/g, "-"));
  return bits.join(" · ");
}

function fillSelect(el, items, selected) {
  el.innerHTML = items
    .map((i) => '<option value="' + esc(i.value) + '"' +
      (i.value === selected ? " selected" : "") + ">" + esc(i.label) + "</option>")
    .join("");
  el.disabled = items.length < 2;
}

function fillDraftPicker(drafts) {
  fillSelect($("draft-pick"),
    drafts.map((d) => ({ value: d.draft_id, label: draftLabel(d, drafts) })),
    DRAFT ? DRAFT.draft_id : "");
  if (!drafts.length) $("draft-pick").innerHTML = '<option>no draft yet</option>';
}

// The address bar is the way to bookmark a board, and localStorage is the way
// back to it without one. They say the same thing, so they are written
// together: a board that survives a bookmark but not a reload, or the other way
// round, is a board that remembers you inconsistently.
function syncUrl() {
  const params = new URLSearchParams();
  if (USER) params.set("user", USER.username ?? USER.display_name);
  if (LEAGUE) params.set("league", LEAGUE.league_id);
  if (DRAFT) params.set("draft", DRAFT.draft_id);
  history.replaceState(null, "", params.toString() ? "?" + params : location.pathname);
  saveSession();
}

/* ---------- rendering ---------- */

function rowHtml(pl) {
  const hurt = pl.injury_status ? ' · <span class="hurt">' + esc(pl.injury_status) + "</span>" : "";

  // Ours reads as ours rather than as gone, which is why the two are drawn
  // differently: a pick we made fills a roster slot, everyone else's just takes
  // a name off the list.
  const isMine = MINE.some((m) => m.k === pl.player_id);
  const isGone = DRAFTED.has(pl.player_id) && !isMine;

  const isFavorite = FAVORITES.has(pl.player_id);

  const cls = ["row", isGone && "gone", isMine && "mine", isFavorite && "fav",
               RECOMMENDED.has(pl.player_id) && "recommended"].filter(Boolean).join(" ");
  // A strikethrough says nothing out loud, and neither does a highlight, so
  // both states go in the name.
  const label = [pl.name, pl.position + " " + (pl.team || "free agent"),
                 "ADP " + pl.adp.toFixed(1),
                 isMine ? "drafted by you" : isGone ? "drafted" : null,
                 isFavorite ? "favorite" : null]
                .filter(Boolean).join(", ");

  return '<div class="' + cls + '" data-player="' + esc(pl.player_id) + '">' +
    '<a class="open" href="' + SLEEPER_PLAYER + encodeURIComponent(pl.player_id) + '"' +
      ' target="_blank" rel="noopener noreferrer"' +
      ' aria-label="' + esc(label) + '. Open on Sleeper.">' +
      '<span class="adp">' + pl.adp.toFixed(1) + "</span>" +
      '<span class="pos ' + esc(pl.position) + '">' + esc(pl.position) + "</span>" +
      '<span class="who"><span class="nm">' + esc(pl.name) + "</span>" +
        '<span class="tm">' + esc(pl.team || "FA") + hurt + "</span></span>" +
      '<span class="pts">' + (pl.points == null ? "" : pl.points.toFixed(0)) + "</span>" +
      valueCell(pl.player_id) +
    "</a>" +
    '<button type="button" class="star' + (isFavorite ? " on" : "") + '"' +
      ' aria-pressed="' + (isFavorite ? "true" : "false") + '"' +
      ' aria-label="Favorite ' + esc(pl.name) + '">' + (isFavorite ? "★" : "☆") + "</button>" +
  "</div>";
}

/* The marker at one of our own picks.
 *
 * Three things, in the order they answer questions. The pick number is the
 * handle — it is what folds the stretch away, so it is the one thing built to
 * be pressed. The round and the slot beneath it are how a pick gets talked
 * about out loud ("round one, the eight"). The rule runs out to the margin,
 * which is what makes this read as a break in the list rather than a heading
 * on top of it, and the hidden count rides the far end where it is legible
 * without crowding the label it isn't part of.
 */
function breakHtml(turn, hidden) {
  const shut = COLLAPSED.has(turnKey(turn));
  return '<div class="brk">' +
    '<div class="brk-head">' +
      '<button type="button" class="picknum' + (turn.length > 1 ? " multi" : "") + '"' +
        ' aria-expanded="' + (shut ? "false" : "true") + '"' +
        ' title="Fold away the players who go between this pick and the next">' +
        turn.map((p) => p.pick_no).join(" · ") + "</button>" +
      '<div class="brk-meta">' +
        '<div class="brk-round">' + esc(roundLabel(turn.map((p) => p.round))) + "</div>" +
        '<div class="brk-slot">' + esc(turn.map(slotLabel).join(" · ")) + "</div>" +
      "</div>" +
      '<div class="brk-rule"></div>' +
      '<span class="brk-count">' + hidden + " hidden</span>" +
    "</div>" +
  "</div>";
}

function buildBoard() {
  const board = $("board");
  if (!PLAYERS.length) {
    board.innerHTML = '<p class="status"><b>No ADP for ' + esc(LEAGUE.name) + " yet.</b><br>" +
      "The list is every player Sleeper publishes an average draft position for, in " +
      "<code>" + esc(adpKey(draftFormat(LEAGUE, DRAFT))) + "</code>. Sleeper may not have " +
      "published a set for this season yet.</p>";
    return;
  }

  // One pass down the list, dropping a break in front of the first player who
  // is already going later than a turn of ours. ADP is measured in pick
  // numbers, so the two compare directly — no index arithmetic that would drift
  // as the board is struck through. A turn is anchored on its first pick, since
  // that's the one we're on the clock for.
  const sections = [];
  let cur = { turn: null, rows: [] };
  let next = 0;
  for (const pl of PLAYERS) {
    while (next < TURNS.length && TURNS[next][0].pick_no <= pl.adp) {
      sections.push(cur);
      cur = { turn: TURNS[next], rows: [] };
      next++;
    }
    cur.rows.push(rowHtml(pl));
  }
  sections.push(cur);
  // Turns that fall past the deepest ADP we have still belong on the board.
  while (next < TURNS.length) { sections.push({ turn: TURNS[next], rows: [] }); next++; }

  board.innerHTML = '<div class="list">' + sections.map(sectionHtml).join("") + "</div>";
}

// The players ahead of our first pick have no break of their own, so they get a
// section without a head — and stay open, since there's no number to press.
function sectionHtml(sec) {
  const rows = '<div class="sect-rows">' + sec.rows.join("") + "</div>";
  if (!sec.turn) return sec.rows.length ? '<section class="sect">' + rows + "</section>" : "";
  const key = turnKey(sec.turn);
  return '<section class="sect' + (COLLAPSED.has(key) ? " collapsed" : "") + '"' +
    ' data-turn="' + esc(key) + '">' + breakHtml(sec.turn, sec.rows.length) + rows + "</section>";
}

function assignSlots() {
  const filled = SLOTS.map((s) => ({ label: s, player: null }));
  const pool = MINE.slice();
  for (const slot of filled) {
    if (slot.label === "BN" || slot.label === "FLEX") continue;
    const i = pool.findIndex((m) => m.p === slot.label);
    if (i >= 0) slot.player = pool.splice(i, 1)[0];
  }
  for (const slot of filled) {
    if (slot.label !== "FLEX") continue;
    const i = pool.findIndex((m) => FLEXOK.includes(m.p));
    if (i >= 0) slot.player = pool.splice(i, 1)[0];
  }
  for (const slot of filled) {
    if (slot.label !== "BN" || !pool.length) continue;
    slot.player = pool.shift();
  }
  return filled;
}

function renderRoster() {
  const wrap = $("slots");
  wrap.innerHTML = "";
  for (const f of assignSlots()) {
    const el = document.createElement("div");
    el.className = "slot" + (f.player ? " filled" : "");
    el.innerHTML = '<span class="lbl">' + f.label + "</span>" + (f.player ? esc(f.player.n) : "—");
    wrap.appendChild(el);
  }
  renderPositionCounts();
}

// Every position the league starts, whether or not we hold one — a zero is the
// count worth seeing — plus anything we've drafted that the slots don't name.
// A drafted count is reported against the draft's own cap where it sets one,
// because "3" and "3 of 4" are different states of the same roster.
function positionCounts() {
  const counts = new Map();
  for (const m of MINE) if (m.p) counts.set(m.p, (counts.get(m.p) || 0) + 1);

  const wanted = new Set(SLOTS.filter((sl) => POS_ORDER.includes(sl)));
  // A flex is a slot for three positions, and a league that starts one but
  // names no TE still wants to be told it hasn't drafted a tight end.
  if (SLOTS.includes("FLEX")) for (const pos of FLEXOK) wanted.add(pos);
  for (const pos of counts.keys()) wanted.add(pos);

  const limits = DRAFT?.position_limits ?? {};
  for (const pos of Object.keys(limits)) wanted.add(pos);

  const known = POS_ORDER.filter((pos) => wanted.has(pos));
  const rest = Array.from(wanted).filter((pos) => !POS_ORDER.includes(pos)).sort();
  return known.concat(rest).map((pos) =>
    ({ pos, n: counts.get(pos) || 0, cap: limits[pos] ?? null }));
}

function renderPositionCounts() {
  $("pos-counts").innerHTML = positionCounts().map((c) => {
    const full = c.cap !== null && c.n >= c.cap;
    return '<span class="pos-count ' + esc(c.pos) + (c.n ? "" : " none")
      + (full ? " full" : "")
      + '" title="' + esc(c.pos) + ": " + c.n
      + (c.cap === null ? " drafted" : " of " + c.cap + " allowed") + '">'
      + '<span class="pc-pos">' + esc(c.pos) + "</span>"
      + '<span class="pc-n">' + c.n
      + (c.cap === null ? "" : '<span class="pc-cap">/' + c.cap + "</span>")
      + "</span></span>";
  }).join("");
}

function renderMeta() {
  // Which seat we're drafting from, straight off our first pick — a league
  // whose draft order isn't set yet doesn't claim one at all.
  const first = TURNS.length ? slotLabel(TURNS[0][0]) : null;
  $("headline").innerHTML = first ? "Board from the <em>" + first + "</em>" : "Draft <em>board</em>";

  // Both of these describe the board being priced, not the league it was
  // opened under — a 10-team standard mock run from a 12-team half PPR league
  // is a 10-team standard board, and saying otherwise labels the ADP column
  // with a format it wasn't read from.
  const scoring = draftFormat(LEAGUE, DRAFT);
  const format = SCORING[scoring] || scoring;
  const teams = (DRAFT && DRAFT.teams) || LEAGUE.total_rosters || null;
  $("eyebrow").textContent = [
    teams ? teams + "-Team" : null,
    format,
    title(DRAFT && DRAFT.type),
    DRAFT && DRAFT.rounds ? DRAFT.rounds + " Rounds" : null,
  ].filter(Boolean).join(" · ");
  document.title = "Draft Board — " + LEAGUE.name + " · Fantasy Tracker";

  $("adp-legend").textContent = "ADP = " +
    [teams ? teams + "-team" : null, format,
     "average draft position"].filter(Boolean).join(" ") +
    " · " + PLAYERS.length + " players";

  const graded = PLAYERS.filter((p) => p.graded).length;
  $("source").textContent = "From Sleeper · " + graded + " players graded";
}

/* ---------- live ---------- */

/* One poll: ask Sleeper what has been picked, then price what's left.
 *
 * `refresh` is what separates the two callers. The board prices itself once on
 * load whatever the light is doing, because a board with numbers on it is worth
 * more than one without — and that costs nothing, since the picks it prices
 * against are the ones already fetched. A live tick asks Sleeper again first.
 */
async function pollOnce(refresh) {
  if (!LEAGUE || !DRAFT) return;
  if (refresh && POLLING) return;   // one timer poll in the air at a time

  const seq = ++POLL_SEQ;
  const draftId = DRAFT.draft_id;

  if (refresh) POLLING = true;
  try {
    const picks = refresh ? await sleeper.getDraftPicks(draftId) : LAST_PICKS;
    // Overtaken while it was out, or answering for a draft we've since switched
    // away from: either way it isn't the current state of anything.
    if (seq !== POLL_SEQ || !DRAFT || DRAFT.draft_id !== draftId) return;
    LAST_PICKS = picks;

    const { gone, ours, atPick } = draftState(picks, new Set([USER.user_id]));
    const result = await ask("price", {
      gone: [...gone], ours: [...ours], atPick, draft: DRAFT,
    });
    if (seq !== POLL_SEQ || !DRAFT || DRAFT.draft_id !== draftId) return;

    applyLive(picks, gone, ours, result);
  } finally {
    if (refresh) POLLING = false;
  }
}

let LAST_PICKS = [];

// Patches the rows in place rather than rebuilding the list. A rebuild would
// throw away the scroll position, and mid-draft that is the one thing you are
// holding on to.
function applyLive(picks, gone, ours, result) {
  VALUES = new Map(result.values.map((v) => [v.player_id, v]));
  DRAFTED = gone;
  MINE = picks
    .filter((k) => k.player_id && ours.has(k.player_id))
    .map((k) => {
      const pl = BY_ID.get(k.player_id);
      return { k: k.player_id, n: pl ? pl.name : k.player_id, p: pl ? pl.position : "" };
    });

  // Keep the list in ADP order so the breaks still land where they belong, and
  // mark the three best available choices instead.
  RECOMMENDED = new Set();
  for (const v of result.values) {
    if (!DRAFTED.has(v.player_id)) RECOMMENDED.add(v.player_id);
    if (RECOMMENDED.size === 3) break;
  }

  for (const row of document.querySelectorAll(".row")) {
    const id = row.dataset.player;
    const cell = row.querySelector(".val");
    if (cell) {
      const v = VALUES.get(id);
      cell.textContent = v ? formatEdge(v.value) : "";
      if (v) {
        cell.title = "team-value edge versus the average modeled plan " + formatEdge(v.value) +
          " · best modeled continuation versus that average " + formatEdge(v.best_plan_edge) +
          " · this player's lineup score gain " + v.gain.toFixed(0) +
          (v.graded ? "" : " · ungraded");
      }
    }
    row.classList.toggle("gone", DRAFTED.has(id) && !ours.has(id));
    row.classList.toggle("mine", ours.has(id));
    row.classList.toggle("fav", FAVORITES.has(id));
    row.classList.toggle("recommended", RECOMMENDED.has(id));
  }

  renderRoster();
  LAST_OK = Date.now();
  AT_PICK = result.atPick;
  showWhen();
}

// What the label under the light says. The pick number alone was the thing that
// hid this bug: a number that hadn't moved in a minute looked exactly like one
// that had just arrived. Past STALE_MS it admits its own age.
function showWhen(note) {
  const el = $("live-when");
  if (!el) return;
  if (!LAST_OK) { el.textContent = note || (ARMED ? "waiting" : ""); return; }
  const age = Date.now() - LAST_OK;
  const stale = ARMED && age > STALE_MS ? " · " + Math.round(age / 1000) + "s ago" : "";
  el.textContent = (note ? note + " · " : "") + "pick " + AT_PICK + stale;
}

// Whether the light was on is a preference, not draft state, so it outlives a
// reload. Refreshing mid-draft is something you do — to pick up a new mock, or
// because a phone dropped the tab — and having to remember to switch polling
// back on afterwards is exactly the kind of thing you forget while on the clock.
function liveWanted() {
  try { return localStorage.getItem(LIVE_KEY) === "1"; } catch { return false; }
}

function setLive(on) {
  ARMED = on;
  try { localStorage.setItem(LIVE_KEY, on ? "1" : "0"); } catch { /* storage off */ }
  syncLive();
}

// Makes the timer match ARMED. Called again whenever something that should
// change the answer happens — the tab hiding, a different draft being picked.
function syncLive() {
  const btn = $("live");
  btn.classList.toggle("on", ARMED);
  btn.setAttribute("aria-pressed", ARMED ? "true" : "false");
  showWhen();

  if (LIVE) { clearInterval(LIVE); LIVE = null; }
  if (!ARMED || document.hidden || !DRAFT) return;

  const tick = async () => {
    // Before the fetch, not after: a poll that never comes back would otherwise
    // leave the label frozen at whatever it last said, which is the one thing
    // this is here to stop.
    showWhen();
    try {
      await pollOnce(true);
      btn.classList.remove("err");
    } catch {
      // Keep the light on and keep trying: a draft is exactly when a dropped
      // request should not be the thing that stops the board updating.
      btn.classList.add("err");
      showWhen("retrying");
    }
  };
  tick();
  LIVE = setInterval(tick, POLL_MS);
}

// The board is worth more with prices on it than without, so it prices itself
// once on load whatever the light is doing.
async function primeValues() {
  const btn = $("live");
  try {
    await pollOnce(false);
    btn.classList.remove("err");
  } catch (err) {
    // Nothing to shout about — the board still works, it just has no numbers.
    console.error(err);
    btn.classList.add("err");
  }
}

/* ---------- the session ---------- */

/* Who the board is for, and which board it was showing.
 *
 * A draft runs for hours across a tab that gets backgrounded, a phone that
 * locks, and a browser that decides to reclaim the memory. Coming back to a
 * username field mid-draft — and having to remember which of four mocks you
 * were on — is the failure this exists to prevent.
 *
 * Only the three ids are kept. Everything they point at is refetched, because
 * a remembered draft is not the same thing as a remembered pick list: the
 * picks are the part that must never be stale, and they are the part that is
 * cheapest to ask for.
 */
function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

function saveSession() {
  try {
    if (!USER) { localStorage.removeItem(SESSION_KEY); return; }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      username: USER.username,
      league: LEAGUE ? LEAGUE.league_id : null,
      draft: DRAFT ? DRAFT.draft_id : null,
    }));
  } catch { /* storage off — the board just asks again next time */ }
}

function forgetSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to forget */ }
}

/* ---------- favorites ---------- */

/* The one opinion the board lets you form while looking at it.
 *
 * Everything else on a row is computed — ADP from Sleeper, the value from the
 * model — and a favorite is the exception: the guy you decided you want,
 * for a reason the formula does not have. It changes no number and moves no
 * row. It makes him findable while scrolling past two hundred of them on the
 * clock, which is the whole job.
 *
 * Per league, because a player you want in one is not one you want in another,
 * and in the browser because there is nowhere else to put it — which also
 * means it is yours and goes nowhere.
 */
function readFavorites() {
  try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}") || {}; } catch { return {}; }
}

function loadFavorites() {
  const mine = LEAGUE ? readFavorites()[LEAGUE.league_id] : null;
  FAVORITES = new Set(Array.isArray(mine) ? mine : []);
}

function saveFavorites() {
  try {
    const all = readFavorites();
    if (FAVORITES.size) all[LEAGUE.league_id] = [...FAVORITES];
    else delete all[LEAGUE.league_id];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(all));
  } catch {
    // Out of quota, or storage turned off. The star still lit, so say why it
    // won't be there tomorrow rather than let it look saved.
    toast("couldn't save that favorite — storage is unavailable", true);
  }
}

/* Redrawn where it stands. Rebuilding the list to light one star would throw
 * away the scroll position, which mid-draft is the thing you're holding on to.
 */
function toggleFavorite(playerId) {
  const player = BY_ID.get(playerId);
  if (!player) return;

  const wasFavorite = FAVORITES.has(playerId);
  if (wasFavorite) FAVORITES.delete(playerId); else FAVORITES.add(playerId);
  saveFavorites();

  const old = document.querySelector('.row[data-player="' + CSS.escape(playerId) + '"]');
  if (!old) return;

  // Which part of the row had the keyboard, so favoriting with Enter or F
  // doesn't drop focus back to the top of the page.
  const focused = old.contains(document.activeElement)
    ? (document.activeElement.closest(".star") ? ".star" : ".open") : null;

  const holder = document.createElement("div");
  holder.innerHTML = rowHtml(player);
  const row = holder.firstElementChild;
  old.replaceWith(row);
  if (focused) row.querySelector(focused).focus();
  if (!wasFavorite) row.querySelector(".star").classList.add("bump");
}

/* ---------- folding a turn's stretch of the board ---------- */

const turnKey = (turn) => turn.map((p) => p.pick_no).join("-");
const collapseScope = () => (LEAGUE ? LEAGUE.league_id : "") + ":" + (DRAFT ? DRAFT.draft_id : "");

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch { return {}; }
}

function loadCollapsed() {
  const shut = readCollapsed()[collapseScope()];
  COLLAPSED = new Set(Array.isArray(shut) ? shut : []);
}

function saveCollapsed() {
  try {
    const all = readCollapsed();
    if (COLLAPSED.size) all[collapseScope()] = Array.from(COLLAPSED);
    else delete all[collapseScope()];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  } catch { /* private mode — the fold just won't outlive the tab */ }
}

// Toggled in place: rebuilding the list to hide some rows would throw away the
// scroll position, which is the one thing you're holding on to mid-draft.
function toggleSection(sect) {
  const key = sect.dataset.turn;
  if (!key) return;
  const shut = sect.classList.toggle("collapsed");
  if (shut) COLLAPSED.add(key); else COLLAPSED.delete(key);
  sect.querySelector(".picknum")?.setAttribute("aria-expanded", shut ? "false" : "true");
  saveCollapsed();
}

/* ---------- gestures ---------- */

// Two controls on the board aren't links: the pick number, which folds away the
// stretch of players between that turn and the next, and the star.
function onClick(e) {
  const num = e.target.closest(".picknum");
  if (num) { toggleSection(num.closest(".sect")); return; }

  const star = e.target.closest(".star");
  if (star) {
    e.preventDefault();
    toggleFavorite(star.closest(".row").dataset.player);
  }
}

// The same toggle for anyone who can't reach a 34px target, or who is tabbing
// down the list rather than pointing at it.
function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() !== "f") return;
  const row = e.target.closest?.(".row");
  if (!row) return;
  e.preventDefault();
  toggleFavorite(row.dataset.player);
}

/* ---------- adding a mock draft ---------- */

async function onAddDraft() {
  const text = prompt("Paste the mock draft url:\nhttps://sleeper.com/draft/nfl/<id>");
  if (text === null) return;

  const match = DRAFT_URL_RE.exec(text.trim());
  const draftId = match ? match[1] : (/^\d+$/.test(text.trim()) ? text.trim() : null);
  if (!draftId) { toast("that doesn't look like a sleeper draft url", true); return; }

  const btn = $("add-draft");
  btn.disabled = true;
  try {
    const raw = await sleeper.getDraft(draftId);
    if (!raw) throw new Error("no such draft: " + draftId);
    const draft = draftShape(raw);
    if (!DRAFTS.some((d) => d.draft_id === draft.draft_id)) DRAFTS.push(draft);
    rememberMock(draftId);
    fillDraftPicker(DRAFTS);
    await showDraft(draft.draft_id);
    toast("draft added");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// A mock can't be listed from Sleeper, so the only record that it belongs to
// this league is the one we keep. Per league, since that is the picker it
// showed up in.
const MOCKS_KEY = "draft-board:mocks";

function readMocks() {
  try { return JSON.parse(localStorage.getItem(MOCKS_KEY) || "{}") || {}; } catch { return {}; }
}

function rememberMock(draftId) {
  try {
    const all = readMocks();
    const mine = new Set(all[LEAGUE.league_id] || []);
    mine.add(draftId);
    all[LEAGUE.league_id] = [...mine];
    localStorage.setItem(MOCKS_KEY, JSON.stringify(all));
  } catch { /* storage off — the mock lasts as long as the tab */ }
}

/* ---------- selection ---------- */

async function showDraft(draftId) {
  // Prices belong to one draft's state, so switching drafts drops the old
  // numbers rather than leaving them on screen against the wrong board.
  if (LIVE) { clearInterval(LIVE); LIVE = null; }
  VALUES = new Map();
  RECOMMENDED = new Set();
  LAST_OK = 0;
  AT_PICK = 0;
  LAST_PICKS = [];
  showWhen();

  DRAFT = DRAFTS.find((d) => d.draft_id === draftId) || DRAFTS[0] || null;

  // The pool is priced per draft, not per league, because the draft picks the
  // ADP column — so switching drafts rebuilds it. It is the same projections
  // either way; only which adp_* is read off them changes.
  PLAYERS = buildPool(PROJECTIONS, GRADES, LEAGUE, DRAFT);
  BY_ID = new Map(PLAYERS.map((pl) => [pl.player_id, pl]));

  TURNS = asTurns(myPicks());
  loadCollapsed();

  LAST_PICKS = DRAFT ? await sleeper.getDraftPicks(DRAFT.draft_id) : [];
  const { gone, ours } = draftState(LAST_PICKS, new Set([USER.user_id]));
  DRAFTED = gone;
  MINE = LAST_PICKS.filter((k) => k.player_id && ours.has(k.player_id)).map((k) => {
    const pl = BY_ID.get(k.player_id);
    return { k: k.player_id, n: pl ? pl.name : k.player_id, p: pl ? pl.position : "" };
  });

  buildBoard();
  renderMeta();
  renderRoster();
  syncUrl();

  if (DRAFT) {
    await ask("init", {
      pool: PLAYERS, slots: SLOTS, draft: DRAFT, userIds: [USER.user_id],
    });
    if (ARMED) syncLive(); else await primeValues();
  }
}

async function showLeague(leagueId, wantedDraft) {
  LEAGUE = LEAGUES.find((l) => l.league_id === leagueId) || LEAGUES[0];
  loadFavorites();
  SLOTS = LEAGUE.roster_positions ?? [];

  const listed = await sleeper.getLeagueDrafts(LEAGUE.league_id);
  DRAFTS = listed.map(draftShape);

  // Mocks this league has been shown before. They can't be listed, so they are
  // fetched by id — one at a time, and a mock that has since been deleted is
  // simply dropped rather than breaking the picker.
  for (const id of readMocks()[LEAGUE.league_id] || []) {
    if (DRAFTS.some((d) => d.draft_id === id)) continue;
    try {
      const raw = await sleeper.getDraft(id);
      if (raw) DRAFTS.push(draftShape(raw));
    } catch { /* gone, or Sleeper is down — the rest of the picker still works */ }
  }

  DRAFT = DRAFTS.find((d) => d.draft_id === wantedDraft) || DRAFTS[0] || null;
  fillDraftPicker(DRAFTS);
  await showDraft(DRAFT ? DRAFT.draft_id : "");
}

/* ---------- the start screen ---------- */

function showStart(message) {
  $("start").hidden = false;
  $("app").hidden = true;
  $("start-error").textContent = message || "";
  $("start-error").hidden = !message;
  $("username").focus();
}

function startBusy(busy, note) {
  $("start-go").disabled = busy;
  $("username").disabled = busy;
  $("start-note").textContent = note || "";
}

/* Everything the board knows, from a username.
 *
 * The order matters: the user has to resolve before there is anything to ask
 * for, and a username that isn't a Sleeper account is by far the most likely
 * thing to go wrong — so it is checked first and on its own, and says so
 * plainly rather than failing somewhere deeper as "no leagues".
 */
async function signIn(username, wanted = {}) {
  startBusy(true, "looking you up…");
  try {
    const user = await sleeper.getUser(username);
    if (!user) { showStart(`No Sleeper user called “${username}”.`); startBusy(false); return; }

    USER = { ...user, username };
    const state = await sleeper.getState();
    SEASON = wanted.season || state.season;

    startBusy(true, "finding your leagues…");
    LEAGUES = await sleeper.getUserLeagues(USER.user_id, SEASON);
    if (!LEAGUES.length) {
      showStart(`${user.display_name} isn't in any ${SEASON} leagues on Sleeper.`);
      startBusy(false);
      return;
    }

    startBusy(true, "fetching projections…");
    const [grades, projections] = await Promise.all([loadGrades(), sleeper.getProjections(SEASON)]);
    GRADES = grades.grades;
    PROJECTIONS = projections;
    if (grades.season !== String(SEASON)) {
      toast(`grades are for ${grades.season}, this league is ${SEASON}`, true);
    }

    $("start").hidden = true;
    $("app").hidden = false;
    $("who").textContent = user.display_name;

    ARMED = liveWanted();
    fillSelect($("league-pick"),
      LEAGUES.map((l) => ({ value: l.league_id, label: leagueLabel(l) })),
      wanted.league || LEAGUES[0].league_id);
    $("picker").hidden = false;

    await showLeague(wanted.league || LEAGUES[0].league_id, wanted.draft);
  } catch (err) {
    console.error(err);
    showStart(err.message || "Sleeper didn't answer. Try again in a moment.");
    startBusy(false);
  }
}

/* ---------- boot ---------- */

function wire() {
  $("board").addEventListener("click", onClick);
  $("board").addEventListener("keydown", onKeyDown);
  $("live").addEventListener("click", () => setLive(!ARMED));
  $("add-draft").addEventListener("click", onAddDraft);
  $("league-pick").addEventListener("change", (e) => showLeague(e.target.value, null));
  $("draft-pick").addEventListener("change", (e) => showDraft(e.target.value));
  /* ADP and projections are held for six hours, which is right for a number
   * that moves over days — but only until the evening Sleeper republishes and
   * the board is still showing this morning's. This drops the lot and starts
   * again, and it is deliberately the only thing on the page that clears a
   * cache: everything else expires on its own. */
  $("refresh-data").addEventListener("click", async () => {
    const btn = $("refresh-data");
    btn.disabled = true;
    try {
      await cache.clear();
      toast("fetching fresh projections…");
      location.reload();
    } catch {
      btn.disabled = false;
      toast("couldn't clear the cached data", true);
    }
  });

  $("switch-user").addEventListener("click", () => {
    if (LIVE) { clearInterval(LIVE); LIVE = null; }
    USER = null;
    forgetSession();
    history.replaceState(null, "", location.pathname);
    $("username").value = "";
    showStart();
  });

  $("start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = $("username").value.trim();
    if (username) signIn(username);
  });

  // Polling a draft nobody is watching is noise, but a hidden tab is not a
  // decision to stop — syncLive pauses the timer and leaves ARMED alone, so
  // coming back to the tab picks the draft up again on its own.
  document.addEventListener("visibilitychange", syncLive);
}

/* Where the board comes back to.
 *
 * A link wins over a remembered session, because a link is something someone
 * just chose — following one into the board you were last on rather than the
 * one you were sent to would be the wrong answer every time.
 */
function main() {
  wire();
  const params = new URLSearchParams(location.search);
  const linked = params.get("user");
  const remembered = readSession();

  if (linked) {
    $("username").value = linked;
    signIn(linked, { league: params.get("league"), draft: params.get("draft") });
  } else if (remembered?.username) {
    $("username").value = remembered.username;
    signIn(remembered.username, { league: remembered.league, draft: remembered.draft });
  } else {
    showStart();
  }
}

main();
