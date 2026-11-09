# The weekly projection

What `js/project.js` does, why each layer is there, and what it is worth
against the number you can already see in the Sleeper app.

The draft board next door prices a player off a provider's season projection,
because a draft needs one number per player and there is no season to build it
from yet. A lineup in week 10 is the opposite problem: nine weeks of evidence
are sitting right there, and a start/sit call turns on exactly the things a
season projection has already averaged away — who is getting the snaps *now*,
who the defence is, and whether the game is a shootout or a grind.

So nothing here is ESPN's number or Sleeper's. The only thing a provider is
needed for is the spread and the total.

## The shape

```
points = team volume × player opportunity × efficiency × matchup
```

Four claims multiplied together, each of which can be wrong on its own. That
is why the page prints them separately: a total can tell you a receiver is
worth nine points, and the decomposition can tell you it is because his snap
share halved.

### Team volume

An offence's pace and its pass rate, both its own recent form regressed to the
league after four games, then moved by the game:

- **Implied total** is the total and the spread rearranged — half the total
  each, then the spread split between them. It is the single most useful
  number on the page.
- **Game script** moves the pass rate half a point per point of expected
  margin, capped at eight points of rate either way. Trailing teams throw. The
  cap is reached by a fourteen-point spread, past which the relationship
  flattens and the cap is nearer the truth than the line is.
- **Expected touchdowns** come from the implied total at the rate this season
  has actually been scoring them — about 9.3 points per offensive touchdown in
  2026, computed from the season rather than assumed.

### Player opportunity

```
expected targets = team dropbacks × snap share × targets per pass snap
```

A game's pass snaps are its snaps split by the team's pass rate that week,
which is the closest a free source gets to participation data. Measuring
targets **per pass snap** rather than per snap is also what discounts a
blocking tight end, by measurement rather than by a special case: his pass
snaps are fewer and his rate per pass snap is unremarkable. Carries work the
same way against run snaps.

Form is an eight-game window with a three-game half-life, so last week counts
double the game four weeks ago. Longer and a back who just took over the
backfield still reads as a backup; shorter and one quiet afternoon in a
committee looks like a benching.

### Efficiency

Catch rate, yards per catch and yards per carry are the player's own blended
with his position's, by the conjugate form `(seen + prior × k) / (chances + k)`
— so `k` reads as "how many chances before the player outweighs his position".
A receiver needs about 45 targets, which is a 60/40 blend over a full season
and nearer 25/75 in week 5, which is the right answer in week 5.

Touchdown rates get the heaviest hand: a target becomes a touchdown a
twentieth of the time, so ten games is a handful of events and a receiver with
three of them is not a touchdown machine. Red-zone share nudges the rate at
half weight, clamped.

### Matchup

Per bucket — WR, TE, RB receiving, RB rushing, QB passing — three factors:
targets allowed per dropback, yards allowed per target, touchdowns allowed per
target. Each is **schedule-adjusted**: for every game, the denominator is what
*that offence* normally produces, so a defence is measured against its own
schedule rather than against the league. Eight games against the two worst
offences in football is the most common way a defence looks elite.

Then regressed toward neutral at `g / (g + 8)` and clamped. With nine games the
regression alone pulls a 1.4 down to 1.2.

The defensive **volume** factor is deliberately not applied to a quarterback's
attempts. How often a team throws is the offence's decision and the
scoreboard's, both already in the game script; a defence that has faced a lot
of passes mostly faced teams that were behind.

Not modelled: man/zone coverage splits, and the slot proxy the model could
build from pass location and air yards. Position is the bucket, so a slot
receiver reads as a receiver, which is most of the way there.

## The two things that are solved per team, not per player

Both of these look like fixes and are not — they are the places the model has
to stop being a player at a time.

**Touchdowns add up to the team's.** Each player's rate is his own history
nudged by his red-zone share, and nothing in that arithmetic knows about the
other ten men in the huddle. A backfield where both backs score often, in an
offence the spread says will score three times, came out projecting five
touchdowns between them. Rates decide the shares; the implied total decides
the total.

**Targets and carries add up to the ball the team has.** Every rate here is
conditional on the player being on the field. Project a whole team that way
and the totals come to about seven-eighths of its actual targets, because an
eighth are owed to players who will not be out there — the back on injured
reserve, the receiver who is a late scratch. Those targets do not vanish on
Sunday. They go to whoever is. So the team's expected dropbacks and rushes are
divided among the players expected to play, in proportion to the rates they
earned, and a receiver whose team-mate is out gets a bigger share without
anyone guessing at a depth chart.

Both run at the last moment rather than in the build — `finalizeWeek`, in the
page, against Sleeper's injury tags as of the page load. They are the only
part of the model that depends on who is hurt, and they are arithmetic over
eight hundred players, so moving them costs nothing and means a receiver ruled
out at 11am moves his team-mates' targets by 11:05 rather than by tomorrow's
build. The backtest runs the same function against the tags as they were.

Quarterback attempts are left out of that second one. Their denominator is
already the team's own attempts, so there is nothing to redistribute, and
normalising them took attempts off the starter to make room for a backup whose
share had not decayed out of the window yet — one relief appearance in week 2
cost the starter a tenth of his attempts in week 10, and it made the
quarterback bias four times worse.

## The simulation

A projected stat line is not a projection of points: the same line is worth
different amounts in two leagues, so `js/lineup.js` scores it with the
league's own `scoring_settings`, the same division the draft board already
makes.

Four thousand weeks per player. Counts are Poisson, conversions are binomial
on those counts, and yardage is a gamma over the conversions — so a
hundred-yard game comes from catching six balls for sixteen each or four for
twenty-five, and the hundred-yard **bonus fires on the drawn yards**. That is
the reason the whole line is drawn rather than scaled: a bonus is a step
function, and a step function has no useful mean.

Seeded per player and week, so the page is the same page twice. A lineup that
moved by a tenth of a point every redraw would be unusable.

An injury is a coin, not a haircut. A doubtful player is not one who scores a
quarter of his points; he is one who mostly scores none and occasionally
scores all of them, which is a different floor. Questionable is not discounted
at all — most questionable players play, the tag says nothing about how well,
and discounting it would quietly bench half a roster in November.

### Why the page prints the mean

Medians do not add. A lineup's nine medians summed come to about six points
less than the median of its simulated totals, because every player's right
tail pulls his mean above his median. A total that matched neither the rows
above it nor the middle of its own range is a number that cannot be checked
against anything on screen, so the headline is expected points and the
20th-to-80th band comes from the simulated totals, where a lineup's own
distribution actually exists.

It is also the right objective: you are trying to beat one other team, and the
lineup that maximises expected points wins more of those over a season than
the one that maximises the median.

## Validation

`node bin/lineup.mjs backtest --from 2 --to 8` projects each completed week
using only the weeks before it — the bundle is rebuilt from scratch per week,
which is slow and is the point, because any shortcut leaks the answer. Scored
in half PPR against what players actually scored, with Sleeper's own weekly
projection for the same players as the benchmark.

Two rules keep the comparison fair:

- **The pool is anyone either projection had at six points or more** —
  roughly the bench line at every position. Counting everyone who took a snap
  would let four hundred players who were always going to score two dominate
  the average; counting only the players *this* model liked would let it pick
  its own exam.
- **Each week is tagged by who played**, as the page does for a finished week.
  Sleeper keeps no history of injury tags, and today's would put a player hurt
  this week out of week 4 too, handing his week-4 targets to his team-mates.
  Knowing the inactives is what a projection has by kickoff, and Sleeper's own
  is updated for them as well.

2026, weeks 2–8 (week 9's Monday game not yet played), 1,505 player-weeks:

| pos | n | MAE | bias | Sleeper MAE |
|---|---|---|---|---|
| QB | 214 | 6.36 | −0.79 | **5.74** |
| RB | 303 | 5.56 | −0.69 | **5.48** |
| WR | 434 | 5.55 | −0.00 | **5.15** |
| TE | 192 | 5.18 | +0.46 | **4.71** |
| K | 202 | **3.23** | −0.21 | 3.28 |
| DEF | 160 | 4.36 | −0.09 | **4.35** |
| all | 1505 | 5.18 | −0.23 | **4.91** |

Sleeper is better overall, by 0.27 points a player-week (95% interval 0.16 to
0.39). The model is level at kicker, defence and running back, and furthest
behind at quarterback.

### Week by week

Whether the gap closes as the season fills in, on the same players each week:

| week | n | MAE | Sleeper MAE | gap | model closer |
|---|---|---|---|---|---|
| 2 | 240 | 5.30 | 4.92 | +0.39 | 49% |
| 3 | 229 | 5.17 | 4.94 | +0.23 | 47% |
| 4 | 229 | 4.96 | 4.49 | +0.46 | 41% |
| 5 | 216 | 5.68 | 5.15 | +0.52 | 40% |
| 6 | 200 | 4.60 | 4.68 | −0.08 | 54% |
| 7 | 194 | 5.13 | 4.96 | +0.17 | 48% |
| 8 | 197 | 5.40 | 5.24 | +0.16 | 48% |

It looks like it does. Weeks 2–5 average a gap of 0.40 (interval 0.24 to
0.56), clearly behind; weeks 6–8 average 0.08 (−0.09 to 0.25), statistically
level. The narrowing is mostly receivers and tight ends: a WR gap of 0.64
early is nothing from week 6, and TE goes from 0.68 to 0.13. That is the shape
you would expect — every rate here starts out regressed to its position, and
by week 6 five games of snaps and targets outweigh the prior, while Sleeper
had last season to lean on from week 1. Quarterback stays behind throughout.

Read it with the error bars, though. The early-to-late narrowing is 0.32 ±
0.23, real but not by a wide margin, and a straight-line trend over the seven
weeks (−0.05 a week ± 0.06) cannot rule out flat. Three weeks of "level" is a
hint, not a result; the season's second half will say.

### Ablation

`--no-matchup` runs the whole model with every defence read as exactly
average:

| | matchup on | matchup off |
|---|---|---|
| QB | **6.36** | 6.44 |
| RB | 5.56 | **5.50** |
| WR | 5.55 | **5.53** |
| TE | **5.18** | 5.23 |
| all | 5.18 | 5.18 |

Over weeks 2–8 the matchup layer does nothing on balance: it helps
quarterbacks and tight ends a little and costs backs and receivers about as
much. Early weeks are mostly regressed to neutral by design, so this is worth
re-running later in the season before deciding either way.

## Known limitations

- Seven weeks is a short backtest. Nothing here is validated across seasons.
- Early in a season the matchup factors are almost entirely regressed toward
  neutral, which is correct and also means the layer does nothing until about
  week 6.
- Slot versus outside alignment is not modelled at all, and neither is
  man/zone coverage — there is no free source for the second.
- Two players in the same offence are simulated independently, so a head-to-head
  figure between team-mates is slightly too confident: a target going to one is
  a target not going to the other.
- A traded player's older games stay attributed to the offence he was in, which
  is right, but his *rates* are blended across both.
- Injury tags on the page are live, but a player's *rates* are as of the
  morning build: a back who took over the backfield in a game that ended an
  hour ago is not in them until tomorrow.
