/* Setting the lineup: the slot search, the simulation, and the card.
 *
 * This file is the exception the luck suite already is — arithmetic rather
 * than judgment, so the numbers are pinned. A lineup is either the best legal
 * one off a roster or it isn't, and "isn't" is a wrong answer rather than a
 * differently-tuned one.
 *
 * The claim worth the most is the one about the search being exact. Filling
 * the narrow slots first with the best eligible player is the obvious way to
 * do this and it is wrong, in a way that only shows up on a roster shape
 * most leagues don't have — which is exactly the kind of bug that ships. The
 * case is written down below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beats, bestLineup, drawLine, kickoffTime, lineupCard, playProbability, project, rng,
  startingSlots, worth,
} from "../js/lineup.js";

const SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1,
  rush_yd: 0.1, rush_td: 6,
  rec: 0.5, rec_yd: 0.1, rec_td: 6,
  fum_lost: -2,
};

/* A player as the bundle carries him: identity, a draw, and the parts that
 * produced it. `targets` and `yardsPerCatch` are the two dials worth turning
 * in a test — everything else is held still so a difference is traceable.
 */
function player(id, pos, { targets = 6, yardsPerCatch = 11, catchRate = 0.65,
                           recTd = 0.05, carries = 0, inj = null, flag = null,
                           team = "AAA", opp = "BBB" } = {}) {
  if (flag === "bye") return { id, name: id, pos, team, inj, flag, games: 5 };
  return {
    id, name: id, pos, team, opp, home: true, inj, games: 5,
    parts: { targets, snap_share: 0.8 },
    draw: {
      targets, catchRate, yardsPerCatch, recTdPerTarget: recTd,
      carries, yardsPerCarry: 4.3, rushTdPerCarry: 0.03,
      firstDownPerCatch: 0.5, firstDownPerCarry: 0.2, fumblesPerTouch: 0.005,
    },
  };
}

const priced = (p, draws = 2000) => project(p, SCORING, { draws, week: 10 });

/* ---------- the simulation ---------- */

test("the same player twice is the same player", () => {
  // A lineup that moved by a tenth of a point every time it redrew would be
  // unusable: you would never know whether you had changed something or the
  // dice had.
  const a = priced(player("x", "WR"));
  const b = priced(player("x", "WR"));
  assert.equal(a.mean, b.mean);
  assert.equal(a.floor, b.floor);
  assert.equal(a.ceiling, b.ceiling);
});

test("two players draw independently of each other", () => {
  const a = priced(player("a", "WR"));
  const b = priced(player("b", "WR"));
  assert.notEqual(a.mean, b.mean, "same parameters, different seeds");
  // ...but not by much, because they are the same player under two names.
  assert.ok(Math.abs(a.mean - b.mean) < 0.6);
});

test("more targets is more points, and a wider week", () => {
  const few = priced(player("few", "WR", { targets: 4 }));
  const many = priced(player("many", "WR", { targets: 11 }));
  assert.ok(many.mean > few.mean);
  assert.ok(many.ceiling - many.floor > few.ceiling - few.floor);
  assert.ok(few.floor < few.mean && few.mean < few.ceiling);
});

test("a hundred-yard bonus is drawn, never averaged", () => {
  // The expected line carries zero for it on purpose: "0.4 of a bonus" is not
  // a thing that happens, and a step function has no useful mean. It has to
  // turn up in the draws instead, or a league that pays for one is quietly
  // scoring every receiver low.
  const big = player("big", "WR", { targets: 12, yardsPerCatch: 16 });
  const random = rng(1);
  let bonuses = 0;
  for (let i = 0; i < 400; i++) bonuses += drawLine("WR", big.draw, random).bonus_rec_yd_100;
  assert.ok(bonuses > 20, `a 125-yard receiver cleared 100 in ${bonuses} of 400 weeks`);
  assert.ok(bonuses < 400);
});

test("an injury is a coin, not a haircut", () => {
  const fit = priced(player("fit", "WR"));
  const doubtful = priced(player("doubtful", "WR", { inj: "Doubtful" }));
  const out = priced(player("out", "WR", { inj: "Out" }));
  const questionable = priced(player("q", "WR", { inj: "Questionable" }));

  assert.equal(playProbability("Out"), 0);
  assert.equal(playProbability("Questionable"), 1);

  assert.equal(out.mean, 0);
  assert.ok(questionable.mean > 0);
  // Doubtful is a quarter of the weeks played, so the floor is a zero rather
  // than a quarter of a normal floor.
  assert.ok(doubtful.mean < fit.mean / 2);
  assert.equal(doubtful.floor, 0);
  assert.ok(doubtful.ceiling > 0);
});

test("a bye is nothing at all", () => {
  const resting = priced(player("bye", "WR", { flag: "bye" }));
  assert.equal(resting.mean, 0);
  assert.equal(resting.floor, 0);
  assert.equal(resting.ceiling, 0);
  assert.equal(resting.draws.length, 0);
});

test("head to head odds are counted over the same weeks", () => {
  const a = priced(player("a", "WR", { targets: 11 }));
  const b = priced(player("b", "WR", { targets: 4 }));
  const odds = beats(a, b);
  assert.ok(odds > 0.6 && odds < 1, `a clear favourite is not a certainty: ${odds}`);
  // Mirror image, and a player against himself ties every week — which a
  // tie counted as half a win makes exactly a coin toss, as it should.
  assert.ok(Math.abs(beats(b, a) + odds - 1) < 1e-9);
  assert.equal(beats(a, a), 0.5);
});

/* ---------- the slot search ---------- */

test("the best lineup is found where filling the narrow slots first fails", () => {
  /* Two different two-position flexes, which is the smallest shape where
   * greedy is wrong. REC_FLEX takes a receiver or a tight end; WRRB_FLEX
   * takes a receiver or a back. Both are equally narrow, so greedy fills the
   * first with the best eligible man — the receiver — and the second with the
   * back, for 19. The answer is to put the tight end in the first and the
   * receiver in the second, for 20.
   */
  const slots = ["REC_FLEX", "WRRB_FLEX"];
  const wr = { id: "wr", pos: "WR", mean: 15, median: 15 };
  const te = { id: "te", pos: "TE", mean: 5, median: 5 };
  const rb = { id: "rb", pos: "RB", mean: 4, median: 4 };

  const best = bestLineup(slots, [wr, te, rb]);
  assert.equal(best.points, 20);
  assert.equal(best.slots[0].player.id, "te");
  assert.equal(best.slots[1].player.id, "wr");
  assert.deepEqual(best.bench.map((p) => p.id), ["rb"]);
});

test("the flex takes what the named slots leave", () => {
  // Presentation rather than arithmetic: the same players either way, but a
  // ten-point receiver in the flex under a six-point one in the WR slot
  // reads as a bug, and there is no explanation to give because there isn't
  // one.
  const slots = ["WR", "WR", "FLEX"];
  const players = [
    { id: "wr1", pos: "WR", mean: 16, median: 16 },
    { id: "wr2", pos: "WR", mean: 12, median: 12 },
    { id: "wr3", pos: "WR", mean: 8, median: 8 },
  ];
  const best = bestLineup(slots, players);
  assert.deepEqual(best.slots.map((s) => s.player.id), ["wr1", "wr2", "wr3"]);
});

test("a slot nobody can fill is left empty rather than failing", () => {
  const best = bestLineup(["QB", "RB", "K"], [
    { id: "qb", pos: "QB", mean: 18, median: 18 },
    { id: "rb", pos: "RB", mean: 12, median: 12 },
  ]);
  assert.equal(best.slots[2].player, null);
  assert.equal(best.points, 30);
});

test("bench slots are not slots a lineup is set into", () => {
  assert.deepEqual(startingSlots(["QB", "RB", "FLEX", "BN", "BN", "IR", "TAXI"]),
    ["QB", "RB", "FLEX"]);
});

/* ---------- the card ---------- */

const LEAGUE = {
  roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN", "BN"],
  scoring_settings: SCORING,
};

function card(roster, players) {
  return lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "2099-01-01T00:00:00Z", players },
    roster, league: LEAGUE, draws: 2000,
  });
}

/* A roster good enough to fill the shape, so a test can change one thing. */
function squad(extra = []) {
  return [
    player("qb", "QB"), player("rb1", "RB", { carries: 18, targets: 3 }),
    player("rb2", "RB", { carries: 12, targets: 3 }),
    player("wr1", "WR", { targets: 10 }), player("wr2", "WR", { targets: 8 }),
    player("te1", "TE", { targets: 5 }), player("flexer", "WR", { targets: 6 }),
    ...extra,
  ];
}

// A quarterback's draw is shaped differently from a receiver's.
function quarterback(id, attempts = 33) {
  return {
    id, name: id, pos: "QB", team: "AAA", opp: "BBB", home: true, inj: null, games: 5,
    parts: { attempts },
    draw: {
      attempts, cmpRate: 0.65, yardsPerCompletion: 11.4, passTdPerAttempt: 0.045,
      intPerAttempt: 0.025, carries: 3, yardsPerCarry: 4.6, rushTdPerCarry: 0.05,
      firstDownPerCompletion: 0.5, fumblesPerAttempt: 0.008,
    },
  };
}

test("a lineup already right is left alone", () => {
  const players = squad().map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = {
    players: players.map((p) => p.id),
    starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "flexer"],
  };
  const result = card(roster, players);
  assert.deepEqual(result.moves, []);
  assert.ok(result.totals.current.points > 0);
  assert.equal(result.totals.current.points.toFixed(2), result.totals.optimal.points.toFixed(2));
});

test("a better man on the bench is one move, not two", () => {
  const players = [...squad(), player("sub", "WR", { targets: 14 })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = {
    players: players.map((p) => p.id),
    starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "flexer"],
  };
  const result = card(roster, players);

  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].in.id, "sub");
  assert.equal(result.moves[0].out.id, "flexer");
  assert.ok(result.moves[0].gain > 0);
  assert.ok(result.moves[0].odds > 0.5);
});

test("a change is worth exactly what it changes the total by", () => {
  // The page prints both, so they have to agree. Medians do not add, which is
  // why `worth` is the mean and not the middle week.
  const players = [...squad(), player("sub", "WR", { targets: 14 })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = {
    players: players.map((p) => p.id),
    starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "flexer"],
  };
  const result = card(roster, players);
  const change = result.totals.optimal.points - result.totals.current.points;
  const claimed = result.moves.reduce((total, move) => total + move.gain, 0);
  assert.ok(Math.abs(change - claimed) < 1e-6);
  // And the total is its own rows added up.
  const rows = result.optimal.reduce((total, s) => total + (s.player ? worth(s.player) : 0), 0);
  assert.ok(Math.abs(rows - result.totals.optimal.points) < 1e-6);
});

test("moving a man between two flex seats is not a change", () => {
  const league = { ...LEAGUE, roster_positions: ["WR", "FLEX", "FLEX", "BN"] };
  const players = [
    player("a", "WR", { targets: 10 }), player("b", "WR", { targets: 8 }),
    player("c", "WR", { targets: 6 }), player("d", "WR", { targets: 1 }),
  ];
  const result = lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players },
    // The right three men, in seats the search would have ordered differently.
    roster: { players: ["a", "b", "c", "d"], starters: ["a", "c", "b"] },
    league, draws: 1000,
  });
  assert.deepEqual(result.moves, []);
});

test("an IDP seat does not shift who Sleeper has in the seats after it", () => {
  // Sleeper's starters line up with every starting seat, linebacker included.
  const league = { ...LEAGUE, roster_positions: ["WR", "LB", "FLEX", "BN"] };
  const players = [player("a", "WR", { targets: 10 }), player("b", "WR", { targets: 8 })];
  const result = lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players },
    roster: { players: ["a", "b", "lb"], starters: ["a", "lb", "b"] },
    league, draws: 500,
  });
  assert.deepEqual(result.current.map((s) => [s.slot, s.player?.id]), [["WR", "a"], ["FLEX", "b"]]);
  assert.deepEqual(result.moves, []);
});

test("a player whose game is over stays where he is", () => {
  // Monday night: wr1's game is final and he sits on the bench; the search
  // must not start him, and must not bench a starter whose game is final.
  const players = [...squad(), player("late", "WR", { targets: 2 })].map((p) =>
    p.id === "wr1" || p.id === "te1" ? { ...p, team: "DONE" } : { ...p, team: "MNF" });
  const roster = {
    players: players.map((p) => p.id),
    starters: ["qb", "rb1", "rb2", "late", "wr2", "te1", "rb2"].map((id, i) => (i === 6 ? "0" : id)),
  };
  const result = lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players,
              teams: { DONE: { final: true }, MNF: { final: false } } },
    roster, league: LEAGUE, draws: 500,
  });
  const started = result.optimal.map((s) => s.player?.id);
  assert.ok(!started.includes("wr1"), "a finished game cannot be put into the lineup");
  assert.equal(result.optimal[5].player?.id, "te1", "a finished starter keeps his seat");
  assert.ok(result.moves.every((m) => !m.in?.locked && !m.out?.locked));
});

test("nobody starts a player who is out", () => {
  const players = [...squad(), player("sub", "WR", { targets: 20, inj: "Out" })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = {
    players: players.map((p) => p.id),
    starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "sub"],
  };
  const result = card(roster, players);
  assert.ok(!result.optimal.some((s) => s.player?.id === "sub"),
    "twenty targets are worth nothing if he is not out there");
  assert.equal(result.moves[0].out.id, "sub");
});

test("a player with no week behind him is named rather than silently dropped", () => {
  const players = squad().map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = {
    players: [...players.map((p) => p.id), "stranger"],
    starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "flexer"],
  };
  const result = card(roster, players);
  assert.deepEqual(result.missing.map((p) => p.id), ["stranger"]);
  assert.ok(!result.optimal.some((s) => s.player?.id === "stranger"));
});

test("a league scoring something nothing projects is told so", () => {
  const players = squad().map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const result = lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players },
    roster: { players: players.map((p) => p.id), starters: [] },
    league: { ...LEAGUE, scoring_settings: { ...SCORING, rec_2pt: 2, idp_tkl: 1 } },
    draws: 500,
  });
  assert.ok(result.unscored.includes("rec_2pt"));
  // An IDP league is not what this page is for, and saying so about every
  // defensive key would bury the one that matters.
  assert.ok(!result.unscored.includes("idp_tkl"));
});

test("a starter less than a point and a half ahead of the bench is a close call", () => {
  const players = [...squad(), player("nearly", "WR", { targets: 5.8 })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const result = card(
    { players: players.map((p) => p.id), starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "flexer"] },
    players,
  );
  const call = result.calls.find((c) => c.over.id === "nearly");
  assert.ok(call, "a bench receiver six tenths behind the flex is a close call");
  assert.ok(call.gap > 0 && call.gap < 1.5);
  // One row per man on the bench, however many slots he could have taken.
  assert.equal(new Set(result.calls.map((c) => c.over.id)).size, result.calls.length);
});

test("the card can run on someone else's projection instead of ours", () => {
  // Sleeper's numbers on the page: the lineup, the changes and the totals all
  // follow them, and a player who is out is still zero whatever they say.
  const players = [...squad(), player("sub", "WR", { targets: 1 }), player("hurt", "WR", { targets: 1, inj: "Out" })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p));
  const roster = { players: players.map((p) => p.id), starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "rb2"] };
  const theirs = new Map(players.map((p) => [p.id, 5]));
  theirs.set("sub", 30);
  theirs.set("hurt", 40);
  const result = lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players },
    roster, league: LEAGUE, draws: 500, points: theirs,
  });
  const started = result.optimal.map((s) => s.player?.id);
  assert.ok(started.includes("sub"), "thirty points on their numbers starts him");
  assert.ok(!started.includes("hurt"), "an Out player is zero whoever projects him");
  const sub = result.optimal.find((s) => s.player?.id === "sub").player;
  assert.equal(sub.mean, 30);
  assert.equal(sub.floor, sub.ceiling, "a single number has no range");
  assert.equal(result.totals.optimal.points, result.optimal.reduce((t, s) => t + (s.player?.mean ?? 0), 0));
});

test("a player is locked from kickoff, read as Eastern time", () => {
  // 1pm Eastern on 15 November 2026 is 18:00 UTC; on 13 September it is 17:00.
  assert.equal(kickoffTime("2026-11-15T13:00"), Date.UTC(2026, 10, 15, 18, 0));
  assert.equal(kickoffTime("2026-09-13T13:00"), Date.UTC(2026, 8, 13, 17, 0));

  const players = [...squad()].map((p) => (p.pos === "QB" ? quarterback("qb") : p))
    .map((p) => (p.id === "wr1" ? { ...p, kickoff: "2026-11-15T13:00" } : { ...p, kickoff: "2026-11-16T20:15" }));
  const roster = { players: players.map((p) => p.id), starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "0"] };
  const at = (now) => lineupCard({
    bundle: { season: "2099", week: 10, through_week: 9, generated_at: "x", players },
    roster, league: LEAGUE, draws: 300, now,
  });
  const before = at(Date.UTC(2026, 10, 15, 17, 59));
  const after = at(Date.UTC(2026, 10, 15, 18, 1));
  assert.ok(!before.optimal.find((s) => s.player?.id === "wr1").player.locked);
  assert.ok(after.optimal.find((s) => s.player?.id === "wr1").player.locked);
});

test("looking back at a finished week locks nobody", () => {
  // Every game is over, so by kickoff time everyone would be locked and the
  // card could suggest nothing. A past week is about what the projection would
  // have done with the whole roster.
  const players = [...squad(), player("sub", "WR", { targets: 20 })]
    .map((p) => (p.pos === "QB" ? quarterback("qb") : p))
    .map((p) => ({ ...p, kickoff: "2026-11-01T13:00" }));
  const roster = { players: players.map((p) => p.id), starters: ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "rb2"] };
  const result = lineupCard({
    bundle: { season: "2099", week: 8, through_week: 7, generated_at: "x", players, past: true },
    roster, league: LEAGUE, draws: 300, now: Date.UTC(2026, 11, 1),
  });
  assert.ok(result.optimal.every((s) => !s.player?.locked));
  assert.ok(result.optimal.some((s) => s.player?.id === "sub"), "the projection still gets to pick");
});
