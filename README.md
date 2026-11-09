# Fantasy Tracker

Three pages for a Sleeper league, all running in your browser, joined by one
header, published at <https://taylars.github.io/fantasy-tracker/>.

A draft board that runs entirely in your browser. Type a Sleeper username and
it prices every available player against the roster you hold, the picks you
have left, and what waiting until your next turn would get you instead.

Then, once the season is running, two more off the same username: a
[set-lineup page](#setting-a-lineup), which projects every player on your
roster for the coming week and tells you what to change, and a
[luck table](#the-luck-table) — how much of each team's record is the team,
and how much is the schedule it was handed.

No server, no database, no install. All three read Sleeper directly from the
page. The lineup page also reads one static file of projections per week,
built by the deploy every morning rather than committed, which is the only
thing here that is not computed live.

## Try it

Open the published board, or run it locally:

```bash
npm start
```

Then <http://localhost:8000> for the board,
<http://localhost:8000/lineup.html> for this week's lineup (run
`npm run lineup` once first — the projections are not in the repository), or
<http://localhost:8000/luck.html> for the luck table. That is a static file
server and nothing else —
what runs locally is exactly what GitHub Pages serves, because there is no
server side to any of it.

A server is needed at all only because ES modules and workers are subject to
the same-origin policy, and a `file://` page has no origin to share. Opening
`index.html` from disk will not work.

## Layout

| | |
|---|---|
| `index.html` | the draft board |
| `lineup.html` | setting a lineup: this week's projections, and the best one |
| `luck.html` | the luck table: what the schedule did to the standings |
| `css/site.css` · `js/nav.js` | the header both pages share, and its links |
| `js/sleeper.js` | read-only Sleeper API client |
| `js/pool.js` | Sleeper's shapes turned into priced players |
| `js/value.js` | the value formula: lineup coverage, baselines, plan search |
| `js/worker.js` | the formula, off the main thread |
| `js/app.js` | the board page: start screen, pickers, rendering, live polling |
| `js/project.js` | the weekly projection model: volume, opportunity, efficiency, matchup |
| `js/lineup.js` | scoring a projection, simulating it, and filling the slots |
| `js/lineup-app.js` | the lineup page: start screen, the card, the breakdowns |
| `js/luck.js` | the luck metric: all-play records and schedule luck |
| `js/luck-app.js` | the luck page: start screen, league picker, the table |
| `js/cache-idb.js` · `js/cache-fs.js` | the response cache, one per environment |
| `data/historical/<year>/grades.json` | canonical researched grades, one file per season |
| `bin/board.mjs` | the board on the command line |
| `bin/lineup.mjs` | building and checking the weekly bundles, start/sit on the terminal, the backtest |
| `bin/lib/nfl.mjs` | the two free sources behind the bundle |
| `bin/lib/bundle.mjs` | what a bundle must look like before it is published |
| `data/lineup/` | generated, not committed: each offered week's projections and the index naming them |
| `bin/grades.mjs` | offline grade validation and research queue |
| `bin/fixture.mjs` | freezing today's pool as the test fixture |
| `scripts/start.mjs` | the local static server behind `npm start` |
| `test/` | what the board should recommend, against a frozen pool |

Everything is plain ES modules with no build step and no dependencies. `js/`
runs unchanged in a browser and under Node, which is what lets the command-line
tools and the page share one implementation of the model rather than two.

## The board

`index.html` has no data in it and nothing to set up. It asks for a Sleeper
username, and everything else follows: the leagues that username is in, the
draft, the seat you hold in it, the picks already made, and every player Sleeper
publishes an ADP for.

### Signing in

The start screen is one field. A username that isn't a Sleeper account says so;
one that is in no leagues this season says that instead, rather than failing
somewhere deeper as an empty board. Both are the ordinary way to get this wrong
and neither should look like a bug.

Nothing is signed in to. A Sleeper username is public and reading one needs no
credential, so there is nothing to store anywhere but your own browser.

### Coming back

A draft runs for hours across a tab that gets backgrounded, a phone that locks,
and a browser that decides to reclaim the memory. Coming back to a username
field mid-draft is the failure this is built to prevent, so the board remembers
where it was:

| what | where | why there |
|---|---|---|
| username, league, draft | `localStorage` | three ids, needed before anything can be fetched |
| favorites | `localStorage`, per league | an opinion, and the only one the board stores |
| ADP and projections | IndexedDB, 6h | 3 MB; moves over days, not over a draft |
| user, leagues, draft lists | IndexedDB, 24h / 10m / 1m | the round trips between opening the board and seeing it |
| which stretches are folded | `localStorage`, per draft | a view preference, not draft state |
| whether the light was on | `localStorage` | you should not have to remember to switch polling back on |
| mock draft ids | `localStorage`, per league | Sleeper cannot list them; this is the only record |

Only ids are kept. **Picks are never cached** — a remembered draft is not a
remembered pick list, and the picks are both the part that must never be stale
and the part that is cheapest to ask for.

The address bar carries `?user=&league=&draft=` as well, so a board is
bookmarkable and shareable. A link wins over a remembered session, because a
link is something you just chose.

**Not you?** in the masthead forgets everything and goes back to the field.
**refresh player data** in the footer drops the cached projections and refetches
them, for the evening Sleeper republishes ADP and the board is still showing
this morning's.

### The list

One vertical list of every player with an ADP, best first, broken wherever one
of your own picks falls. Tapping a row opens that player on Sleeper. Nothing
about the layout is written down anywhere:

- **The order** is the ADP format of the draft on screen — `adp_std` in a
  standard mock, `adp_half_ppr` in a half-PPR league. The draft is asked first
  because a mock started cold belongs to no league and can be scored
  differently from the league you opened it under; the league's own
  `scoring_settings` are the fallback for a board with no draft yet. Sleeper
  reports "not drafted" as an ADP of 999 rather than a null, so that value is
  filtered out by value.
- **The breaks** are derived from the draft. Its `draft_order` says which slot
  is yours, and the slot plus `teams`, `rounds` and `type` gives every pick you
  own. Consecutive pick numbers are one trip to the board, so a snake turn
  merges into a single break (`24 · 25`) rather than two. A break sits in front
  of the first player already going later than its first pick, which works
  because ADP is measured in pick numbers. A draft whose order isn't set yet
  gets no breaks. Press the pick number to fold that stretch away.
- **Who's gone** is the draft's picks and nothing else. A player taken by
  someone else is struck through; one taken by you is marked as yours and fills
  a roster slot. Autopicks come through with no `picked_by`, so they count as
  gone rather than as yours.
- **The value** is the green number, and the three best available are outlined.

### Favorites

Tap a row's star, or press **F** with it focused. The row lifts out of the list
and the star fills.

That is all it does. It changes no number and moves no row — a favorite is on
the list either way, at whatever ADP puts him. Everything else on a row is
computed, and this is the exception: the player you decided you want, for a
reason the formula doesn't have. Making him findable while scrolling past two
hundred rows on the clock is the whole job.

Favorites are per league, and live in your browser. There is nowhere else to
put them, which also means they are yours and go nowhere.

### Pricing

The value column is `js/value.js`, run in a Web Worker. Pricing a board is a
few hundred milliseconds of arithmetic — a plan search four picks deep,
branching over six positions — which is not long, but far too long to spend on
the thread keeping the page scrollable, and it happens again every three
seconds while a draft is live. The worker holds the player pool; each poll
sends it only the picks.

The board prices itself once on load whatever the live button is doing, because
a board with numbers on it is worth more than one without, and that first
pricing costs no requests at all.

### Going live

A board priced when the page loaded is wrong by the time it matters: a pick
made thirty seconds ago changes what everything is worth. The **Live** button
polls the draft every three seconds and re-prices against it. Rows are patched
where they stand rather than rebuilt, so the scroll position survives — mid-draft
that's the thing you're holding onto.

**Sleeper's draft endpoints sit behind Cloudflare with `s-maxage=86400`, and
that is the thing most likely to make the board look stuck.** Poll them plainly
and you can be handed an edge copy that is hours old: verified against a real
draft, the same `x-request-id` came back over and over with
`cf-cache-status: HIT` and `age` climbing past 6800 seconds. Polling faster
changes nothing when the CDN keeps answering with the same body, which is why
the first attempt at fixing this — just shortening the interval — didn't help.
`Cache-Control: no-cache` and `Pragma: no-cache` are both ignored; a unique
query parameter is what reaches the origin, and that is what `fresh` adds. It is
the default on `getDraft` and `getDraftPicks`, because there is no such thing as
a usefully stale pick list. It costs about 100ms a request — an origin round
trip instead of an edge one — which is a trade worth making every time.
Sleeper's own app uses websockets and never notices any of this.

Three seconds is 20 polls a minute, well under Sleeper's limit of 1000. It
started at ten and that was too slow to be live — bots in a mock pick every
couple of seconds, so a tick could open with most of a round already gone, and
the board would show it without ever looking broken.

Three details worth knowing. Only one poll is ever in the air: a request that
outlasts its interval doesn't get another fired on top of it, and a reply
overtaken by a newer one is dropped rather than allowed to paint the board back
to a pick that has already happened. The light stays on through a failed request
and turns amber instead — a dropped connection during a draft should not be the
thing that stops the board updating — and once what's on screen is more than
fifteen seconds old the label says how old, so a board that has quietly fallen
behind looks different from one that just updated. Polling stops on its own when
the tab is hidden, or when you switch leagues or drafts.

### Mock drafts

Mock drafts **cannot be enumerated through the API**. A live mock appears in
neither `/user/{id}/drafts` nor the source league's `/drafts`, and no
undocumented variant returns it. So the board can't list one for you: press
**+** next to the draft picker and paste the url it hands out
(`https://sleeper.com/draft/nfl/<draft_id>`).

That id is the one thing about a mock nothing else can tell us, so the browser
remembers it against the league it was pasted in from and re-fetches it on the
next visit. A mock that has since been deleted is dropped from the picker rather
than breaking it.

## Setting a lineup

`lineup.html` is the page for a Sunday morning. One username, the same
leagues, and for the league and week you pick: every player on your roster
projected, the best legal lineup off that roster, and the changes
between it and whatever Sleeper currently has saved, each with how many
points it is worth.

Nothing on it is a provider's projection. The board prices players off
Rotowire's season line because a draft has no season to build one from; a
lineup in week 10 has nine weeks of evidence sitting right there, and a
start/sit call turns on exactly the things a season projection has already
averaged away — who is getting the snaps *now*, who the defence is, and
whether the game is a shootout or a grind.

```
points = team volume × player opportunity × efficiency × matchup
```

Each row opens onto those four. A total can tell you a receiver is worth nine
points; the decomposition can tell you it is because his snap share halved.
[docs/lineup-model.md](docs/lineup-model.md) is the derivation, the backtest
and the ablations.

### Why this one page has a build step

Every other number on this site is computed in the browser from what Sleeper
answers. This one cannot be: it needs every completed week of player stats —
snaps, targets, red-zone looks, nine megabytes — joined against a schedule
with spreads and totals on it, from a second provider. That is not a thing to
do in a browser on a phone.

So it is done ahead of time, by the deploy. Every push to `main` and every
morning at 4am Eastern, the Pages workflow builds the projections, checks
them, and publishes them with the site. Nothing generated is committed. To get
a local copy:

```bash
npm run lineup                      # build the offered weeks into data/lineup/
node bin/lineup.mjs check           # what the deploy checks before publishing
node bin/lineup.mjs build --week 11 # or one particular week
```

**Only weeks with betting lines are offered**, because the implied total is
what every projection hangs off. That is the week a lineup is being set for
once the books have priced it, plus — on a Monday — the week still being
played, with everyone whose game has kicked off locked where Sleeper has them.
Before the coming week's lines are up, the page says so rather than guessing.

**Every finished week is offered too**, from week 2, to look back at projected
against actual. Each is built only from the weeks before it — the backtest's
no-lookahead rule — so it is the projection the page would have shown at the
time. Sleeper keeps no history of injury tags, so a finished week is tagged by
who actually played (`tagByAttendance` in `js/project.js`): anyone who did not
is Out. The page shows the lineup you had that week (from the league's
matchups), its projected and actual points with the actual marked on each
range, and what the projected best lineup would actually have scored.

**What is published is rates, not projections.** Everything that takes nine
weeks of stats to work out — each player's share, efficiency and matchup, each
team's volume off the line — is in the file. The last step is not: who plays,
and where an absent player's targets, carries and touchdowns go. That depends
on injury news, which moves by the hour, so the page does it. It downloads the
week's file (about three quarters of a megabyte) and asks Sleeper for a handful of
small things: who you are, your leagues, their rosters, the week's matchups
for actual points, and the week's projections feed. That last one carries every player's live injury
tag, and the page finishes the projections against those tags with
`finalizeWeek` in `js/project.js` — the same function the command line,
the backtest and the publishing check run, so there is one model, not two.

**A dropdown picks the projection: Simulated or Sleeper's.** Simulated is
this model. Sleeper's comes from the same feed — Sleeper's projected stat line
for every player, scored under the league's settings exactly as ours is — and
the whole card runs on whichever is picked: the best lineup, the changes, the
totals. Sleeper's is one number per player, so it has no range. If Sleeper's
feed does not answer, the page falls back to the build's injury tags and says
so.

**Actual points sit beside the projection** for anyone whose game has kicked
off, from the league's own matchups (so already under its scoring). From
kickoff a player is locked, as he is in Sleeper, and the page will not
suggest moving him.

**A build that fails its check is not published.** `bin/lib/bundle.mjs` holds
each bundle to ranges a real week sits well inside — a line on every game,
every team's targets adding up to its dropbacks, the average defence and
kicker projecting like a defence and a kicker — and the workflow stops if any
is out. The site then keeps serving the last build that passed, which is a
day-old lineup rather than a wrong one. The offseason is not a failure: the
build writes an index that says why there is nothing to show, and the page
prints it.

The two sources are both free and need no key:

| | |
|---|---|
| `api.sleeper.app/stats/nfl/<season>/<week>` | one request per week, carrying the player, his position, the team he played for *that* week, who he played, and a stat line with snaps and red-zone looks on it |
| `nflverse/nfldata/.../games.csv` | the schedule with spreads and totals, including for games not yet played |

The Sleeper url is a different endpoint from the `/v1/stats/...` one in the
docs, which answers with a bare map keyed by player id and no team on it. The
team per week is what makes a traded player and a defensive matchup both work,
so it is worth the undocumented url.

### On the command line

```bash
node bin/lineup.mjs show "Puka Nacua" "Jaxon Smith-Njigba"   # start which?
node bin/lineup.mjs show --user taylars --start              # the whole lineup
npm run lineup:backtest                                      # how wrong is it?
node bin/lineup.mjs backtest --from 4 --no-matchup           # does a layer help?
```

`show` prints the component breakdown under each player, because "nine points"
is not an argument and "his snap share went from 82% to 46%" is. Two names
also get the head-to-head: how often one outscores the other over the same
simulated weeks.

### How good is it

`backtest` projects each completed week from the weeks before it and nothing
else — the bundle is rebuilt per week, which is slow and is the point, since
any shortcut leaks the answer — then scores it against what players actually
scored, with Sleeper's own weekly projection for the same rows alongside.

Over 2026 weeks 4–9, on startable players, mean absolute error in half PPR:
**5.13 against Sleeper's 4.91**. Better than Sleeper at quarterback (5.77 to
5.81), within a quarter of a point at every other position, about four tenths
behind overall. A provider with paid data and a staff being slightly better at
this is the expected result; the reason to run this anyway is that you can see
what it is made of and argue with it.

The tables, the per-layer ablations, and what is known to be wrong with it are
in [docs/lineup-model.md](docs/lineup-model.md).

## The luck table

`luck.html` is the other half of the same idea, after the draft: one username,
the same leagues, and every score in them. It answers the question a 3-4 record
does not — whether the record is the team or the schedule.

The score is **record luck**: wins against the *all-play* record, what you'd
have if you played the whole league every week rather than the one team you
were drawn against. Scoring 140 and losing counts against you; scoring 80 and
winning counts for you. It is built from the weekly scores and nothing else.

**Schedule luck** — what the opponents you drew scored against what the league
scored that week — is shown but not scored. It used to be half the score, and
it counted luck that changed nothing: score 20 above the week and your
opponent's +10 or −10 is the same win, yet one read as a hard draw and the
other a soft one. In a league where the two disagreed, a team that drew hot
opponents but lost only 0.18 wins to them scored −49 on the blend; on record
luck alone it is −7. Schedule luck stays in the week by week and the summary
sentence, as the explanation rather than the number.

Record luck is standardised within the league onto a score from −100 to +100,
where 0 is that league's average and ±100 is two standard deviations. The
scale is *relative to the league on purpose*: luck is zero-sum, so a stolen win
only exists against the eleven other records it was taken from. It follows
that the scores average to zero and the expected wins add up to the wins
actually handed out — both worth checking if you change the arithmetic.

The table orders by current place and shows the place the all-play record
earns beside it, so the gap between the two columns is the whole story. Click a
team for the week by week, where a week you lost having outscored at least
two-thirds of the league is marked `robbed` and a week you won having outscored
a third of it or less is marked `gifted` — 8 of 11 and 3 of 11 in a 12-team
league. Thirds rather than halves on purpose: at half, finishing 6th of 12 and
losing to the 3rd-best score counted as robbed, which is a good opponent on a
middling week, not a theft. Each score in the list carries its ± against that
week's league average, yours and your opponent's both.

**Only finished weeks count, and that is decided by the calendar rather than by
the scores.** Sleeper serves a row for every week of the season from the day
the league is created, at 0.0 points, so "every team has a score" looks like a
finished week — but an hour into Sunday afternoon every roster has somebody on
the field and every score is above zero. Read that way, the table ran a game
ahead of the league's own standings. `state.week` is the week being played, so
the last finished week is the one before it. Playoff weeks never count either:
only part of the league is in the bracket.

## ADP and projections

Everything the board knows about players comes from
`api.sleeper.app/projections/nfl/<season>`, which is **not in Sleeper's public
docs** and can change without warning — `getProjections` is the only thing that
touches it.

One response, about 3 MB, carries all six drafted positions: each player's name,
team, position and injury status, the ADP set for every scoring format, and a
Rotowire projected stat line keyed the same way a league's `scoring_settings`
is. That is the whole player pool.

**The 14 MB `/players/nfl` file is never fetched by the board**, because
everything it would answer is already in the response above. Only
`bin/grades.mjs queue` pulls it, for `age` and `depth_chart_order` — two fields
nothing on the board reads but a researcher wants in front of them.

Points are not stored anywhere, because the same projection is worth different
amounts in different leagues. `scoreStats` applies the league's own
`scoring_settings`, with receptions swapped to whatever the draft on screen is
scored at — `scoringFor` — so a standard mock prices a receiver the way that
room does without giving up the league's finer rules. Sleeper's precomputed
`pts_half_ppr` is not used for either half of that: it is a generic preset that
docks an interception 1 point where a league may say 2, enough to misrank every
quarterback by up to 14 points, and six draftable players have no `pts_*` at
all, so reading it would price two of them by a different rule than the players
either side of them. Deep bench players come back with an ADP but no stat line,
and are omitted rather than scored zero.

A projection carries no `depth_chart_order`, which the model once used to spot a
healthy starting quarterback. It uses projected pass attempts instead, which is
a cleaner signal and already in the response: Sleeper projects attempts for 77
quarterbacks and the split is not close — 31 at 300+, 42 under 100, four in
between.

## What a player is worth

The board sorts by ADP, which is what the rest of the league thinks.
`js/value.js` is what you think:

```bash
node bin/board.mjs --user <name>          # the board, best first
node bin/board.mjs --user <name> --plan   # take a back now, or wait a round?
node bin/board.mjs --user <name> --json   # the whole ranked board
```

It prices a player three ways at once — against the lineup you already hold,
against the baseline his position can actually be replaced at, and against what
waiting until your next pick would get you instead:

```
value = gain(player) - wait(position)
```

That last comparison is value-based drafting with a next-available baseline,
which is a decades-old idea. The parts specific to this board are that a season
is priced as seventeen weeks of coverage rather than a starting lineup — so the
third running back is the man who plays the games the first two miss — and that
the replacement baseline turns on whether a position can genuinely be streamed.
Only kickers and defenses can: the gap between the last starting kicker and the
best one on the wire is 0 points, where for a running back it is 102.

[docs/value-formula.md](docs/value-formula.md) is the derivation, with the
numbers and what it was checked against.
[docs/drafting-goals.md](docs/drafting-goals.md) is why these are the right
questions.

## Grades

`data/historical/<year>/grades.json` is the only source of truth for grades.
Edit these files directly; there is no batch merger or generated grade copy.
Each file contains `{season, grades: {player_id: {...}}}`, with name, position,
team, offense, position_security, exp_games, upside, note, sources, and graded_at.
Historical cutoff/evidence metadata stays in the same document.

The app, CLI board, and fixture generator select the greatest numeric season in
`data/historical/index.json` (currently 2026). They never merge in older grades,
including for a player missing from the latest year. A missing or malformed newest
file is an error, not a fallback. URLs are relative for GitHub Pages project paths.
Historical backtests explicitly load their own season instead; 2025 must never
receive 2026 grades. Draft snapshots store ADP/projections and a grade-file reference,
not another copy of the grades.

```bash
npm run grades -- check --all         # validate all canonical files offline
npm run grades -- queue              # print ungraded top-200 snapshot players
npm run grades -- queue --regrade    # print the full research cohort
npm run grades -- check --season 2025
```

To add a year, create its historical draft and grades files and register the year
in `data/historical/index.json`. The validation step detects an out-of-date index.
The grading rubric is in `.claude/skills/grade-players/SKILL.md`. Retrospective
2025 evidence limitations are documented in `data/historical/2025/GRADING.md`.
Researched expected-games values are used exactly; the healthy-QB floor applies
only when no grade exists.

## Tests

The behavior-level test is a [2025 historical backtest](docs/backtest-2025.md):
complete simulated drafts are scored against actual Weeks 1–17 results. Run the
quick 12-team comparison with `npm run backtest`, or the full team-count × draft
format × roster × scoring × opponent matrix with `npm run backtest -- --matrix`.
The matrix logs each configuration, draft progress (at most every five seconds),
elapsed time, and a rough ETA to stderr. A draft must finish before progress can
advance; this is not a background timer. Add `--quiet` to suppress progress.
Use `node bin/backtest.mjs --matrix --json > matrix.json` to save clean JSON while
watching progress in the terminal. Matrix runs accept one `--seed=N`; `--seeds`
is supported only by the normal backtest.
The historical inputs are frozen under `data/historical/<season>/`: one
`draft.json` plus a separate JSON file for every completed week. Tests never
fetch.

The thing worth testing here is not that the arithmetic runs — it is that the
board recommends the right player. So a test is an argument about ordering:
plant a player whose answer is already known, and check where the ranking puts
him.

```bash
npm test                                      # everything
npm test -- test/recommends.test.js           # just that file
npm test -- --test-name-pattern "strictly better"
npm test -- --watch
```

Arguments after `--` go directly to Node's test runner, for selecting a file,
matching a test name, or watching for changes.

The suite runs against `test/fixtures/pool.json` — a real pool, priced under a
real league, written down on a day that has passed. Sleeper's ADP and
projections move daily and grades move whenever someone researches a batch, so
a test that fetched either would pass or fail for reasons that have nothing to
do with the formula. Regenerating the fixture is deliberately a thing you do
by hand:

```bash
node bin/fixture.mjs --user <sleeper username>
```

`test/scenario.js` is where a situation gets built. It takes the seat, the
players already gone, the roster we hold, and anything the test wants to plant,
and hands back the board:

```js
const draft = scenario({
  roster: ["Jahmyr Gibbs"],
  plant: [player({ name: "Ringer Reynolds", position: "TE",
                   adp: 40, points: 210 })],
});
assert.ok(draft.recommends("Ringer Reynolds"));
```

A recommendation is the top three, not the top one. That is how the answer gets
used — you are picking off a shortlist while the clock runs — and the first
three rows are routinely a point or two apart, so which of them lands first
turns on a tiebreak rather than on anything a strategy has an opinion about.
`recommends` asks whether the board is pointing at a player at all; `picks()`
is the shortlist itself; `pick` is there for the few claims that really are
about the top of the board.

`rank` and `value` say where anyone else landed, and `top()` prints the
shortlist so a failure says what it got instead. Planted players are built by
`player()` or by `like()`, which copies a real one and moves a single number —
that is how "just better than the best man on the board" gets written without
restating his whole line.

`test/lineup.test.js` and `test/luck.test.js` are the exceptions to all of
this, because both are arithmetic rather than a judgment. A lineup is either
the best legal one off a roster or it isn't, and "isn't" is a wrong answer
rather than a differently-tuned one — so the numbers there are pinned. The
claim worth the most is that the slot search is exact: filling the narrow
slots first with the best eligible player is the obvious way to do it and it
is wrong, on a roster shape most leagues don't have, which is exactly the kind
of bug that ships. It also pins the Monday case: a player whose game is over
is never moved in or out. `test/project.test.js` runs the model over a two-team,
three-week season small enough to work out on paper, and pins one thing
exactly — that `td` on a defensive row is touchdowns *allowed*. Reading it as
a defensive score put fourteen points a week on every defence in the league,
and it looked like a plausible number all the way to the lineup it ruined.
`test/bundle.test.js` breaks a healthy bundle one way at a time — no line, a
defence scoring like that, a team short of its targets — and holds the
publishing check to catching each.

The luck suite runs on a four-team, two-week league
small enough that every expected win, schedule-luck total and luck score in
the file was worked out on paper first. Pinning those numbers down is the
point. It also holds the one case that actually bit — a week in progress, where
every score is above zero and none of them are final.

What these should not do is pin the current numbers down. Values move whenever
the formula is tuned, and a suite that failed on every tuning would be deleted
within a week. The claims worth writing are the ones that have to survive it: a
strictly better player is taken over the man he is better than, a strictly worse
one is not, and a position the roster has already filled stops being the answer.

## Deploying

GitHub Pages serves the repository as-is. There is no build step, so the
workflow in `.github/workflows/pages.yml` uploads the checkout and publishes it.

Two things this depends on, both easy to break later:

- **Paths must stay relative.** A project site lives at
  `<user>.github.io/<repo>/`, so `data/historical/index.json` resolves and
  `/data/historical/index.json` would 404.
- **`.nojekyll` must stay.** Without it Pages runs Jekyll, which silently drops
  files and directories beginning with `_`.

- **`data/lineup/` is built by the deploy, not committed.** The workflow
  runs on every push and every morning at 4am Eastern (two UTC crons, one
  per side of daylight saving, with a job that lets through the right one).
  GitHub turns scheduled workflows off after sixty days without a commit, so
  after a quiet offseason it may need switching back on under Actions.

- **Script and stylesheet URLs are stamped at deploy.** Pages caches every
  file for ten minutes, each on its own clock, so straight after a deploy a
  browser could pair the new `luck.html` with the previous `luck-app.js` — new
  layout, old code. The workflow runs `scripts/stamp.mjs` on the checkout it
  uploads, tagging every reference with `?v=<commit>`, so a page only ever
  loads its own deploy's files. The repository is never stamped, and
  `test/stamp.test.js` fails if a new import slips past the stamper.

Pages cannot set HTTP headers, which costs nothing here: the board never serves
a cross-origin request, it only makes them, and Sleeper sends the permissive
headers itself.
