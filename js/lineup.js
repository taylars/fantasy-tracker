/* Setting a lineup: scoring a projection, simulating it, and filling the slots.
 *
 * js/project.js builds a projected stat line for every player, once a week,
 * offline. This is the half that runs in the page, and everything it does
 * needs the league in front of it:
 *
 *   - the same line is worth different points in two leagues, so points are
 *     computed here from the league's own scoring_settings, never stored
 *   - the floor and the ceiling are percentiles of *points*, which means the
 *     simulation has to be scored under the league's settings too
 *   - which slots exist, and who is allowed in them, is the league's
 *     roster_positions and nothing else
 *
 * The output is a card: who the league currently has starting, who it should
 * have starting, and the swaps between the two with how much each is worth
 * and how often it actually wins.
 *
 * Pure arithmetic. The fetching and drawing are in js/lineup-app.js.
 */

import { scoreStats } from "./pool.js";
import { expectedLine, playProbability, pointsAllowedBuckets, PLAY_PROBABILITY,
         yardsAllowedBand, yardsAllowedBuckets, YARD_SPREAD } from "./project.js";

/* How many simulated games per player. Four thousand puts the sampling error
 * on a 20th percentile at a few hundredths of a point, which is two orders of
 * magnitude below anything the projection itself is sure about, and runs in
 * well under a frame for a whole roster.
 */
export const DRAWS = 4000;

/* A start/sit call is close when the better player is ahead by less than
 * this. Below it the honest answer is "it does not matter", and saying so is
 * worth more than a decimal place.
 */
export const CLOSE_POINTS = 1.5;

/* What a player is worth, in one place, because three different parts of the
 * page have to agree about it: the slot search, the moves, and the totals.
 *
 * Expected points rather than the median, and the reason is arithmetic rather
 * than taste. Medians do not add. The median of a receiver's week is lower
 * than his mean — a right tail of three-touchdown afternoons pulls the mean
 * up and leaves the median where it was — so a lineup's nine medians summed
 * come to six points less than the median of its simulated totals, and a
 * total that is neither the sum of its rows nor the middle of its own range
 * is a number that cannot be checked against anything on screen. Means add
 * exactly: the total is the sum of the rows, a swap's gain is the difference
 * it makes to the total, and the 20th-to-80th band still comes from the
 * simulated totals, where it belongs.
 *
 * It is also the right objective. You are not trying to have a median week,
 * you are trying to beat one other team, and over a season the lineup that
 * maximises expected points wins more of those than the one that maximises
 * the median.
 */
export const worth = (player) => player.mean;

/* Which positions each of Sleeper's slots will take.
 *
 * The flexes are the only interesting ones. BN, IR and TAXI are not slots a
 * lineup is set into, so they are absent rather than empty — a bench spot
 * holds a player but never starts him.
 */
export const SLOT_POSITIONS = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  WRRB_WRT: ["RB", "WR", "TE"],
};

export const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"]);

export function startingSlots(rosterPositions = []) {
  return rosterPositions.filter((slot) => !BENCH_SLOTS.has(slot) && SLOT_POSITIONS[slot]);
}

/* Whether a player is going to be out there at all — the same table the
 * volume normalisation in js/project.js runs on, re-exported so a page has
 * one place to read it from. The simulation draws the coin per week rather
 * than shaving the median: a doubtful player is not a player who scores a
 * quarter of his points, he is one who mostly scores none and occasionally
 * scores all of them, and that is a different floor.
 */
export { playProbability, PLAY_PROBABILITY };

// ------------------------------------------------------------------ random

/* Seeded, so the page is the same page twice.
 *
 * A lineup that moved by a tenth of a point every time it redrew would be
 * unusable — you would never know whether you had changed something or the
 * dice had. The seed is the player and the week, so his floor is his floor
 * all week, and two players' draws are independent of each other.
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normal(random) {
  // Box-Muller. The log's argument is nudged off zero rather than resampled.
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/* Poisson. Knuth's product while the mean is small, a rounded normal once it
 * is not — at a mean of thirty the two are indistinguishable at the precision
 * a projection has, and Knuth's loop is thirty iterations a draw.
 */
function poisson(random, mean) {
  if (!(mean > 0)) return 0;
  if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(random)));
  const limit = Math.exp(-mean);
  let count = 0;
  let product = random();
  while (product > limit && count < 200) {
    count++;
    product *= random();
  }
  return count;
}

function binomial(random, trials, probability) {
  if (trials <= 0 || !(probability > 0)) return 0;
  if (probability >= 1) return trials;
  let hits = 0;
  for (let i = 0; i < trials; i++) if (random() < probability) hits++;
  return hits;
}

/* Marsaglia-Tsang. Used for yardage: a total over n successes is a gamma with
 * n times the shape, which is both the right family (positive, right-skewed)
 * and one draw instead of n.
 */
function gamma(random, shape, scale) {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) return gamma(random, shape + 1, scale) * Math.max(random(), 1e-12) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(random(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v * scale;
  }
  return shape * scale;
}

/* Yards over `count` successes, given a mean per success and how spread that
 * is. Shape and scale are picked so the total has mean count×per and a
 * coefficient of variation of spread/√count — which is what averaging count
 * independent carries does to the spread.
 */
function yards(random, count, per, spread) {
  if (count <= 0 || !(per > 0)) return 0;
  const shape = count / (spread * spread);
  return gamma(random, shape, per * spread * spread);
}

// -------------------------------------------------------------- one draw

/* One simulated game, as a stat line keyed the way scoring_settings is.
 *
 * Counts are Poisson, conversions are binomial on those counts, and yardage
 * is a gamma over the conversions — so a receiver's hundred-yard game comes
 * from catching six balls for sixteen each or four for twenty-five, and the
 * hundred-yard bonus fires on the drawn yards rather than on an expectation
 * of it. That last part is the reason the whole line is drawn rather than
 * scaled: a bonus is a step function, and a step function has no useful mean.
 */
export function drawLine(position, draw, random) {
  if (position === "QB") {
    const attempts = poisson(random, draw.attempts);
    const completions = binomial(random, attempts, draw.cmpRate);
    const passYards = Math.round(yards(random, completions, draw.yardsPerCompletion, YARD_SPREAD.pass));
    const carries = poisson(random, draw.carries);
    const rushYards = Math.round(yards(random, carries, draw.yardsPerCarry, YARD_SPREAD.rush));
    return {
      pass_att: attempts,
      pass_cmp: completions,
      pass_inc: attempts - completions,
      pass_yd: passYards,
      pass_td: poisson(random, draw.attempts * draw.passTdPerAttempt),
      pass_int: poisson(random, draw.attempts * draw.intPerAttempt),
      pass_fd: binomial(random, completions, Math.min(1, draw.firstDownPerCompletion)),
      bonus_pass_yd_300: passYards >= 300 ? 1 : 0,
      bonus_pass_yd_400: passYards >= 400 ? 1 : 0,
      rush_att: carries,
      rush_yd: rushYards,
      rush_td: poisson(random, draw.carries * draw.rushTdPerCarry),
      fum_lost: poisson(random, draw.attempts * draw.fumblesPerAttempt),
    };
  }

  if (position === "K") {
    const attempts = poisson(random, draw.fga);
    const made = binomial(random, attempts, draw.fgRate);
    const xpa = poisson(random, draw.xpa);
    const line = {
      fga: attempts,
      fgm: made,
      fgmiss: attempts - made,
      xpa,
      xpm: binomial(random, xpa, draw.xpRate),
      xpmiss: 0,
    };
    line.xpmiss = xpa - line.xpm;
    // Made kicks dealt out over the distance bands a league might pay for.
    const bands = Object.entries(draw.distance ?? {});
    for (const [key] of bands) line[key] = 0;
    for (let i = 0; i < made; i++) {
      let roll = random();
      for (const [key, share] of bands) {
        roll -= share;
        if (roll <= 0) { line[key] += 1; break; }
      }
    }
    line.fgm_50p = line.fgm_50_59 ?? 0;
    return line;
  }

  if (position === "DEF") {
    const allowed = Math.max(0, Math.round(draw.pointsAllowed
      + (draw.pointsAllowedSpread ?? 9.5) * normal(random)));
    const allowedYards = Math.max(0, Math.round(draw.yardsAllowed
      + (draw.yardsAllowedSpread ?? 75) * normal(random)));
    const line = {
      sack: poisson(random, draw.sack),
      ff: poisson(random, draw.ff),
      int: poisson(random, draw.int),
      fum_rec: poisson(random, draw.fumRec),
      def_td: poisson(random, draw.defTd),
      def_st_td: poisson(random, draw.stTd),
      pts_allow: allowed,
      yds_allow: allowedYards,
    };
    for (const key of Object.keys(pointsAllowedBuckets(draw))) line[key] = 0;
    for (const key of Object.keys(yardsAllowedBuckets(draw))) line[key] = 0;
    line[yardsAllowedBand(allowedYards)] = 1;
    const band = allowed === 0 ? "pts_allow_0"
      : allowed <= 6 ? "pts_allow_1_6"
      : allowed <= 13 ? "pts_allow_7_13"
      : allowed <= 20 ? "pts_allow_14_20"
      : allowed <= 27 ? "pts_allow_21_27"
      : allowed <= 34 ? "pts_allow_28_34"
      : "pts_allow_35p";
    line[band] = 1;
    return line;
  }

  const targets = poisson(random, draw.targets);
  const receptions = binomial(random, targets, draw.catchRate);
  const recYards = Math.round(yards(random, receptions, draw.yardsPerCatch, YARD_SPREAD.rec));
  const carries = poisson(random, draw.carries);
  const rushYards = Math.round(yards(random, carries, draw.yardsPerCarry, YARD_SPREAD.rush));
  return {
    rec_tgt: targets,
    rec: receptions,
    rec_yd: recYards,
    rec_td: poisson(random, draw.targets * draw.recTdPerTarget),
    rec_fd: binomial(random, receptions, Math.min(1, draw.firstDownPerCatch)),
    bonus_rec_yd_100: recYards >= 100 ? 1 : 0,
    bonus_rec_yd_200: recYards >= 200 ? 1 : 0,
    rush_att: carries,
    rush_yd: rushYards,
    rush_td: poisson(random, draw.carries * draw.rushTdPerCarry),
    rush_fd: binomial(random, carries, Math.min(1, draw.firstDownPerCarry)),
    bonus_rush_yd_100: rushYards >= 100 ? 1 : 0,
    bonus_rush_yd_200: rushYards >= 200 ? 1 : 0,
    fum_lost: poisson(random, (receptions + carries) * draw.fumblesPerTouch),
  };
}

const quantile = (sorted, p) => {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};

/* One player's week in points: the median, the fifth of weeks that go worse,
 * and the fifth that go better.
 *
 * `draws` is kept on the result because the only honest way to answer "how
 * often does the other guy beat him" is to count the simulated weeks where he
 * did, and that comparison is the question a start/sit decision actually
 * asks. A two-point edge that wins 52% of the time is a coin toss; a
 * two-point edge that wins 70% of the time is a decision.
 */
export function project(player, scoring, { draws = DRAWS, week = 0 } = {}) {
  const expected = player.draw ? expectedLine(player.pos, player.draw) : null;
  const base = {
    id: player.id,
    name: player.name,
    pos: player.pos,
    team: player.team ?? null,
    opp: player.opp ?? null,
    home: player.home ?? null,
    kickoff: player.kickoff ?? null,
    inj: player.inj ?? null,
    flag: player.flag ?? null,
    games: player.games ?? 0,
    parts: player.parts ?? null,
    plays: playProbability(player.inj),
  };

  if (!player.draw || player.flag === "bye") {
    return { ...base, mean: 0, median: 0, floor: 0, ceiling: 0, line: null, draws: new Float64Array(0) };
  }

  const random = rng(seedOf(`${player.id}:${week}`));
  const samples = new Float64Array(draws);
  let total = 0;
  for (let i = 0; i < draws; i++) {
    // The coin for whether he plays at all, so an injury shows up in the
    // floor rather than as a shaved median.
    const points = base.plays >= 1 || random() < base.plays
      ? scoreStats(drawLine(player.pos, player.draw, random), scoring)
      : 0;
    samples[i] = points;
    total += points;
  }
  const sorted = Float64Array.prototype.slice.call(samples).sort();

  return {
    ...base,
    line: expected,
    expected: scoreStats(expected, scoring) * base.plays,
    mean: total / draws,
    median: quantile(sorted, 0.5),
    floor: quantile(sorted, 0.2),
    ceiling: quantile(sorted, 0.8),
    draws: samples,
  };
}

/* How often one player outscores another over the same simulated weeks.
 *
 * The draws are independent of each other by construction — each player is
 * seeded from his own id — which is the right model for two players on
 * different teams and an approximation for two in the same offence, where a
 * target going to one is a target not going to the other. That correlation
 * would narrow the gap between two team-mates slightly; it is not modelled,
 * and it is the one place these odds are optimistic.
 */
export function beats(a, b) {
  const n = Math.min(a.draws?.length ?? 0, b.draws?.length ?? 0);
  if (!n) return a.median > b.median ? 1 : 0;
  let wins = 0;
  let ties = 0;
  for (let i = 0; i < n; i++) {
    if (a.draws[i] > b.draws[i]) wins++;
    else if (a.draws[i] === b.draws[i]) ties++;
  }
  return (wins + ties / 2) / n;
}

// ------------------------------------------------------------- the lineup

/* The best legal lineup, exactly rather than greedily.
 *
 * Greedy gets this wrong in a way that matters: fill the flex with the best
 * available and a receiver who was the second-best WR can end up on the bench
 * behind a back who was the third-best RB. So the slots are solved together.
 *
 * It is cheap to do properly because of a bound: for any position, only the
 * best few players at it can ever be used, where "few" is the number of slots
 * that would take that position at all. A twelve-slot roster leaves a dozen
 * candidates, and a dozen candidates is a bitmask small enough to search
 * exhaustively — 4096 states, each looked at once.
 */
export const SEARCH_LIMIT = 18;

export function bestLineup(slots, players, { score = worth } = {}) {
  const eligible = (slot, player) => SLOT_POSITIONS[slot]?.includes(player.pos);

  // The candidate set: for each position, as many players as there are slots
  // that would take him. Anyone past that cannot reach the field however the
  // rest of the lineup falls, so he is left out of the search.
  const capacity = {};
  for (const slot of slots) for (const pos of SLOT_POSITIONS[slot] ?? []) capacity[pos] = (capacity[pos] ?? 0) + 1;
  const byPosition = new Map();
  for (const player of players) {
    if (!capacity[player.pos]) continue;
    if (!byPosition.has(player.pos)) byPosition.set(player.pos, []);
    byPosition.get(player.pos).push(player);
  }
  const candidates = [];
  for (const [pos, list] of byPosition) {
    list.sort((a, b) => score(b) - score(a));
    candidates.push(...list.slice(0, capacity[pos]));
  }

  // A normal roster leaves a dozen candidates. Nothing Sleeper can build gets
  // near the limit, but a malformed one should degrade to the greedy answer
  // rather than hang the page.
  if (candidates.length > SEARCH_LIMIT || !slots.length) return greedyLineup(slots, players, score);

  const n = candidates.length;
  const width = 1 << n;
  const fits = slots.map((slot) => candidates.map((player) => eligible(slot, player)));

  /* best[k][used] is the most points the first k slots can score having used
   * exactly that set of candidates. The slot index is carried rather than
   * derived from the popcount, because a slot may be left empty — a roster
   * can be short at a position, and a lineup with a hole in it is still the
   * best lineup available.
   */
  const best = Array.from({ length: slots.length + 1 }, () => new Float64Array(width).fill(-Infinity));
  const took = Array.from({ length: slots.length + 1 }, () => new Int8Array(width).fill(-1));
  best[0][0] = 0;

  for (let k = 0; k < slots.length; k++) {
    const row = fits[k];
    for (let used = 0; used < width; used++) {
      const from = best[k][used];
      if (from === -Infinity) continue;
      // Leave the slot empty.
      if (from > best[k + 1][used]) { best[k + 1][used] = from; took[k + 1][used] = -1; }
      for (let i = 0; i < n; i++) {
        if (used & (1 << i) || !row[i]) continue;
        const next = used | (1 << i);
        const value = from + score(candidates[i]);
        if (value > best[k + 1][next]) { best[k + 1][next] = value; took[k + 1][next] = i; }
      }
    }
  }

  /* The best final state, and on a tie the one that puts more players on the
   * field. The tie is not hypothetical: a roster whose only quarterback is on
   * bye scores the same zero whether he starts or the slot is left empty, and
   * "QB — Caleb Williams, on bye" is a far more useful thing to print than
   * "QB — —", which reads as a bug in the page.
   */
  let state = 0;
  let points = -Infinity;
  let filled = -1;
  for (let used = 0; used < width; used++) {
    const value = best[slots.length][used];
    if (value === -Infinity) continue;
    let bits = 0;
    for (let bit = used; bit; bit >>= 1) bits += bit & 1;
    if (value > points || (value === points && bits > filled)) {
      points = value;
      filled = bits;
      state = used;
    }
  }

  const assignment = slots.map((slot) => ({ slot, player: null }));
  for (let k = slots.length; k > 0; k--) {
    const i = took[k][state];
    if (i >= 0) {
      assignment[k - 1].player = candidates[i];
      state &= ~(1 << i);
    }
  }

  tidy(assignment, score);
  const started = new Set(assignment.filter((a) => a.player).map((a) => a.player.id));
  const bench = players.filter((p) => !started.has(p.id)).sort((a, b) => score(b) - score(a));
  return { slots: assignment, bench, points: Math.max(points, 0) };
}

/* Put the same players in seats that read the way a person would fill them.
 *
 * The search is indifferent to which flex a man sits in — two receivers in a
 * WR slot and a FLEX score the same either way — so it hands back whichever
 * arrangement it happened to find, and that arrangement looked wrong: a
 * ten-point receiver in the flex under a six-point one in the WR slot, with
 * no explanation, because there isn't one. The convention everybody expects
 * is that the named slots take the best men and the flex takes what is left.
 *
 * Only legal swaps between two already-chosen players, so the total cannot
 * change — this is presentation, not optimisation. Swapping is preferred when
 * it moves the better player into the narrower slot, which is exactly that
 * convention written down.
 */
function tidy(assignment, score) {
  const width = (slot) => SLOT_POSITIONS[slot]?.length ?? 99;
  for (let pass = 0; pass < assignment.length; pass++) {
    let moved = false;
    for (let i = 0; i < assignment.length; i++) {
      for (let j = i + 1; j < assignment.length; j++) {
        const a = assignment[i];
        const b = assignment[j];
        if (!a.player || !b.player) continue;
        const legal = SLOT_POSITIONS[a.slot]?.includes(b.player.pos)
          && SLOT_POSITIONS[b.slot]?.includes(a.player.pos);
        if (!legal) continue;
        const narrower = width(a.slot) - width(b.slot);
        const better = score(b.player) - score(a.player);
        // Narrower slot first, then earlier slot, and only when the swap puts
        // the higher score in it.
        const shouldSwap = better > 0 && (narrower < 0 || (narrower === 0 && i < j));
        if (!shouldSwap) continue;
        [a.player, b.player] = [b.player, a.player];
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/* The fallback for a roster too big to search. Same answer on anything
 * laminar, which every real roster shape is.
 */
function greedyLineup(slots, players, score) {
  const eligible = (slot, player) => SLOT_POSITIONS[slot]?.includes(player.pos);
  const left = [...players].sort((a, b) => score(b) - score(a));
  const out = slots.map((slot) => ({ slot, player: null }));
  const order = out
    .map((entry, index) => ({ index, slot: entry.slot, width: SLOT_POSITIONS[entry.slot].length }))
    .sort((a, b) => a.width - b.width || a.index - b.index);
  for (const { index, slot } of order) {
    const pick = left.findIndex((p) => eligible(slot, p));
    if (pick >= 0) out[index].player = left.splice(pick, 1)[0];
  }
  const started = new Set(out.filter((a) => a.player).map((a) => a.player.id));
  return {
    slots: out,
    bench: players.filter((p) => !started.has(p.id)),
    points: out.reduce((total, a) => total + (a.player ? score(a.player) : 0), 0),
  };
}

/* The card the page draws.
 *
 * Three things, in the order they are useful: what the league currently has
 * starting, what it should have starting, and the difference stated as moves.
 * A move is only worth printing if it is a move — the same player in a
 * different flex slot is not — so the comparison is on sets, and each move
 * carries both the points it is worth and how often it actually wins, because
 * those two disagree more often than you would think.
 */
/* When a game kicks off, as epoch milliseconds. The schedule gives kickoffs
 * as Eastern wall-clock times with no offset ("2026-11-15T13:00"), so the
 * offset is New York's on that date — which is the whole reason this is a
 * function and not `new Date(kickoff)`, which would read it as the viewer's
 * own time zone. */
export function kickoffTime(kickoff) {
  if (!kickoff) return null;
  const [date, time = "13:00"] = kickoff.split("T");
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(guess)) return null;
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(new Date(guess)).find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const [, sign = "-", hours = "5", minutes = "0"] = name.match(/GMT([+-])(\d+)(?::(\d+))?/) ?? [];
  const offset = (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);
  return guess - offset * 60 * 1000;
}

/* `points`, when given, is someone else's projection — Map(player id →
 * points under this league's scoring), Sleeper's on the page — and the whole
 * card runs on it instead of ours: the lineup, the changes, the totals. A
 * single number has no range, so floor and ceiling are that number. A player
 * it does not mention is projected at nothing, and so is anyone who will not
 * play, whatever the other projection says.
 *
 * `now` decides who is locked: anyone whose game has kicked off, which is when
 * Sleeper stops letting him be moved. A week already played (`bundle.past`)
 * locks nobody — the point of looking back is to see what the projection
 * would have done with the whole roster. */
export function lineupCard({ bundle, roster, league, week, draws = DRAWS, scoring = null,
                             points = null, now = Date.now() }) {
  const settings = scoring ?? league?.scoring_settings ?? {};
  const slots = startingSlots(league?.roster_positions ?? []);
  const index = new Map(bundle.players.map((p) => [p.id, p]));

  const rostered = (roster?.players ?? []).map((id) => {
    const found = index.get(id);
    return found
      ? project(found, settings, { draws, week: bundle.week })
      : { id, name: null, pos: null, median: 0, floor: 0, ceiling: 0, mean: 0,
          flag: "unknown", draws: new Float64Array(0), plays: 1, parts: null, line: null };
  });
  if (points) {
    for (const p of rostered) {
      if (p.flag === "unknown") continue;
      const theirs = p.flag === "bye" || p.plays === 0 ? 0 : points.get(p.id) ?? 0;
      Object.assign(p, { mean: theirs, median: theirs, floor: theirs, ceiling: theirs,
                         draws: new Float64Array(0), source: "other" });
    }
  }
  const byId = new Map(rostered.map((p) => [p.id, p]));

  // Sleeper's starters array is positional: it lines up with roster_positions,
  // and an empty slot is the string "0".
  const startingIds = (roster?.starters ?? []).filter((id) => id && id !== "0");
  // Index against every starting seat, including ones this page cannot fill
  // (IDP), so a league with a linebacker slot before FLEX still reads the
  // right man into FLEX; the unsupported seats are dropped afterwards.
  const current = (league?.roster_positions ?? [])
    .filter((slot) => !BENCH_SLOTS.has(slot))
    .map((slot, i) => {
      const id = (roster?.starters ?? [])[i];
      return { slot, player: id && id !== "0" ? byId.get(id) ?? null : null };
    })
    .filter(({ slot }) => SLOT_POSITIONS[slot]);

  /* A player whose game is already over is locked: Sleeper will not move him
   * in or out. On the Monday of a week still being played, that is most of
   * the roster. Locked starters keep their seats, locked bench players stay
   * on the bench, and the search runs over the seats and players left. */
  for (const p of rostered) {
    if (bundle.past) break;
    const kicked = kickoffTime(p.kickoff);
    if ((p.team && bundle.teams?.[p.team]?.final) || (kicked != null && kicked <= now)) p.locked = true;
  }
  const fixed = current.map((seat) => Boolean(seat.player?.locked));
  const playable = rostered.filter((p) => p.pos && p.flag !== "unknown" && !p.locked);
  const open = bestLineup(slots.filter((_, i) => !fixed[i]), playable);
  const openSeats = [...open.slots];
  const optimal = {
    slots: current.map((seat, i) => (fixed[i] ? seat : openSeats.shift())),
    bench: [...open.bench, ...rostered.filter((p) => p.locked && p.pos &&
      !current.some((seat) => seat.player?.id === p.id))],
  };

  const currentIds = new Set(current.filter((s) => s.player).map((s) => s.player.id));
  const optimalIds = new Set(optimal.slots.filter((s) => s.player).map((s) => s.player.id));

  /* The difference between the two lineups, as moves a person would make.
   *
   * Only two things are real changes: a player who starts in the best lineup
   * and does not start now, and a player who starts now and does not start in
   * the best lineup. Everything else is a reshuffle — Sleeper cares which of
   * two flex seats a man sits in and nothing else does — so it is dropped
   * rather than printed as a change nobody has to make.
   *
   * Then the two lists are paired, because "sit Swift" and "start Kincaid"
   * are one decision and reading them as two is work. Each man coming out is
   * matched with the best man going in who is actually allowed in his seat,
   * which is why the pairing is by eligibility rather than by order: paired
   * by order, a roster with a quarterback on bye and a wrong tight end read
   * as "start the tight end over the quarterback", a decision that does not
   * exist.
   */
  const outs = current.filter((s) => s.player && !optimalIds.has(s.player.id));
  const ins = optimal.slots.filter((s) => s.player && !currentIds.has(s.player.id)).map((s) => s.player);
  const moves = [];
  for (const { slot, player: out } of outs) {
    const pick = ins.findIndex((p) => SLOT_POSITIONS[slot]?.includes(p.pos));
    const take = pick >= 0 ? pick : (ins.length ? 0 : -1);
    const inbound = take >= 0 ? ins.splice(take, 1)[0] : null;
    moves.push({
      slot,
      in: inbound,
      out,
      gain: (inbound ? worth(inbound) : 0) - worth(out),
      odds: inbound && inbound.draws.length && out.draws.length ? beats(inbound, out) : null,
    });
  }
  // Anyone left going in had no seat to take off anybody — an empty slot in
  // the lineup Sleeper has saved.
  for (const inbound of ins) {
    const slot = optimal.slots.find((s) => s.player?.id === inbound.id)?.slot ?? null;
    moves.push({ slot, in: inbound, out: null, gain: worth(inbound), odds: null });
  }
  moves.sort((a, b) => b.gain - a.gain);

  // Close calls: every started player against the best man on the bench who
  // could take his seat. A thin edge is worth saying out loud, because the
  // page is otherwise printing a decimal place it has no right to.
  const calls = [];
  for (const { slot, player } of optimal.slots) {
    if (!player || player.locked) continue;
    const alternative = optimal.bench
      .filter((p) => SLOT_POSITIONS[slot].includes(p.pos) && p.flag !== "bye" && p.plays > 0 && !p.locked)
      .sort((a, b) => worth(b) - worth(a))[0];
    if (!alternative) continue;
    const gap = worth(player) - worth(alternative);
    if (gap > CLOSE_POINTS) continue;
    const odds = player.draws.length && alternative.draws.length ? beats(alternative, player) : null;
    calls.push({ slot, start: player, over: alternative, gap, odds });
  }
  // One row per man on the bench, not one per slot. A two-flex lineup has the
  // same best alternative for both flexes, and printing him twice says the
  // same thing twice while looking like two separate decisions.
  calls.sort((a, b) => a.gap - b.gap);
  const seen = new Set();
  const deduped = calls.filter((call) => {
    if (seen.has(call.over.id)) return false;
    seen.add(call.over.id);
    return true;
  });

  /* A lineup's total: its rows added up, with its range drawn from the
   * simulated weeks.
   *
   * The floor and the ceiling cannot be added — a team does not have all nine
   * of its bad weeks on the same Sunday, and summing the floors draws a
   * disaster that would need every one of them to — so they come out of the
   * simulated totals, which is the one place a lineup's own distribution
   * exists.
   */
  const total = (entries) => {
    const picked = entries.map((e) => e.player).filter(Boolean);
    const points = picked.reduce((a, p) => a + worth(p), 0);
    // The lineup's own floor and ceiling, not the sum of its players' — a
    // team does not have all nine of its bad weeks at once. Summing the
    // percentiles would make the floor far too low to mean anything.
    // A player with no draws at all — on bye, or not in the bundle — scores a
    // flat zero and is simply left out of the sum. Letting his empty array
    // set the length collapsed the whole lineup's range onto its median, so
    // one man on bye made the floor and the ceiling the same number.
    const drawn = picked.filter((p) => p.draws.length > 0);
    const n = drawn.reduce((m, p) => Math.min(m, p.draws.length), Infinity);
    if (!drawn.length || !Number.isFinite(n)) {
      return { points, floor: points, ceiling: points, median: points };
    }
    const sums = new Float64Array(n);
    for (const p of drawn) for (let i = 0; i < n; i++) sums[i] += p.draws[i];
    const sorted = Float64Array.prototype.slice.call(sums).sort();
    return {
      points,
      floor: quantile(sorted, 0.2),
      ceiling: quantile(sorted, 0.8),
      // The median of the simulated totals: the statistically purer figure,
      // and the one that does not add up to the rows above it.
      median: quantile(sorted, 0.5),
    };
  };

  return {
    week: bundle.week,
    season: bundle.season,
    through: bundle.through_week,
    generated: bundle.generated_at,
    slots,
    current,
    optimal: optimal.slots,
    bench: optimal.bench,
    moves,
    calls: deduped,
    totals: { current: total(current), optimal: total(optimal.slots) },
    // Which scoring keys the league pays for that nothing here projects. A
    // league scoring return yards or two-point conversions is getting a
    // slightly low number for everyone, and it should say so rather than
    // quietly round them off.
    unscored: unprojected(settings, bundle),
    // So a page can score anything else — Sleeper's own projection — the same way.
    scoring: settings,
    missing: rostered.filter((p) => p.flag === "unknown"),
    startingIds,
  };
}

/* Scoring keys a league pays for that no projected line carries.
 *
 * Only keys worth a tenth of a point or more, and only ones that could
 * plausibly happen to a drafted player — a league scoring defensive tackles
 * has IDP slots and is not what this page is for.
 */
const IGNORED_SCORING = /^(?:idp_|def_|st_|pts_allow|yds_allow|bonus_def|bonus_sack|blk_|ff$|tkl|safe$|int_ret|fum_ret|sack_yd)/;

function unprojected(scoring, bundle) {
  const projected = new Set();
  for (const player of bundle.players) for (const key of Object.keys(player.line ?? {})) projected.add(key);
  return Object.entries(scoring)
    .filter(([key, value]) => Math.abs(value) >= 0.1 && !projected.has(key) && !IGNORED_SCORING.test(key))
    .map(([key]) => key)
    .sort();
}
