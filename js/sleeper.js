/* Read-only client for the Sleeper API.
 *
 * Docs: https://docs.sleeper.com/ — that's the source of truth, not this file.
 *
 * Runs in a browser and under Node alike: it uses nothing but `fetch`, which
 * both have had for years. That is deliberate. The board is the main caller,
 * but the grading workflow reads the same endpoints from the command line, and
 * two clients drifting apart is how the board and the research end up
 * disagreeing about who a player even is.
 *
 * Everything here is a public GET: no auth, no writes. You can read a draft but
 * cannot submit picks, set a queue, or autodraft. Stay under 1000 calls/minute.
 *
 * Gotchas worth knowing before you build on this:
 *   - There is no push API. Poll /draft/{id}/picks every 2-3s during a draft
 *     (3s = 20 calls/min, comfortably under the limit) and poll the draft
 *     object every ~30s to catch status flipping to paused/complete.
 *   - **The draft endpoints sit behind Cloudflare with `s-maxage=86400`.** Poll
 *     them plainly and you get an edge copy that can be a day old. Request
 *     `Cache-Control: no-cache` and `Pragma: no-cache` are both ignored. A
 *     unique query parameter is what gets through to the origin, which is what
 *     `fresh` adds. Sleeper's own app uses websockets and never notices this.
 *   - `draft_order` and `slot_to_roster_id` are null until the order is set.
 *   - `picked_by` is "" on autopicks — fall back to `roster_id`.
 *   - A commissioner can undo a pick, so diff on the set of `pick_no` values
 *     rather than on picks.length if you want to survive that.
 *   - Keeper leagues show picks with `is_keeper: true` before the draft starts.
 *   - Projections and ADP live on api.sleeper.app/projections/..., which is NOT
 *     in the public docs and can change without notice. getProjections wraps it.
 */

const BASE_URL = "https://api.sleeper.app/v1";
const PROJECTIONS_URL = "https://api.sleeper.app/projections";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

// Query parameter used to miss the CDN — see the Cloudflare note above. The
// name is arbitrary; Sleeper ignores parameters it doesn't know.
const CACHE_BUSTER = "_";

// The six positions the board drafts. Everything else Sleeper projects (IDP,
// returners) is noise here.
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

export class SleeperError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SleeperClient {
  /* `cache` is optional and has the shape {get(key), set(key, value, ttlMs)},
   * with `get` returning undefined on a miss or an expiry. It is injected
   * rather than built here because the two callers cache in different places —
   * IndexedDB in the browser, the filesystem under Node — and neither import
   * belongs in a module the other one loads. Without one, nothing is cached.
   */
  constructor({ timeout = 10000, retries = 3, cache = null } = {}) {
    this.timeout = timeout;
    this.retries = retries;
    this.cache = cache;
  }

  /* GET a url, retrying on 429/5xx. Returns null for a 404 — Sleeper uses it
   * for unknown users and leagues, which is a normal miss rather than an error.
   */
  async request(url, { fresh = false } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (attempt) await sleep(2 ** attempt * 1000); // 2s, 4s

      // Re-stamped per attempt, not once up front: a retry is asking again
      // because the last answer never arrived, and reusing that attempt's
      // buster can land on whatever it managed to cache.
      //
      // The buster is the wall-clock second rather than a random value: fine
      // enough for any polling cadence worth using, and coarse enough that two
      // polls landing in the same second still share one cache entry.
      const target = new URL(url);
      if (fresh) target.searchParams.set(CACHE_BUSTER, String(Math.floor(Date.now() / 1000)));

      try {
        const response = await fetch(target, {
          signal: AbortSignal.timeout(this.timeout),
        });
        if (response.status === 404) return null;
        if (RETRY_STATUSES.has(response.status)) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (err) {
        lastError = err;
      }
    }

    throw new SleeperError(`GET ${url} failed: ${lastError?.message ?? lastError}`);
  }

  /* A request whose answer is worth keeping. `ttlMs` is how long the cached
   * copy stays good for; a caller that needs the current state should not be
   * going through here at all.
   */
  async cached(key, ttlMs, build) {
    if (!this.cache) return build();

    const hit = await this.cache.get(key);
    if (hit !== undefined) return hit;

    const fresh = await build();
    // A miss that fetched nothing is not worth remembering: caching a null
    // would hold a typo'd username as "no such user" for as long as the ttl.
    if (fresh !== null && fresh !== undefined) await this.cache.set(key, fresh, ttlMs);
    return fresh;
  }

  get(path, options) {
    return this.request(`${BASE_URL}${path}`, options);
  }

  // ------------------------------------------------------------------- users

  /* Look up a user by username or user_id → {user_id, display_name, ...}.
   *
   * Cached for a day. A username maps to a user_id once and essentially never
   * again, and this is the request standing between someone reopening the board
   * and seeing it.
   */
  getUser(usernameOrId, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    return this.cached(`user:${usernameOrId}`, ttlMs,
      () => this.get(`/user/${encodeURIComponent(usernameOrId)}`));
  }

  /* Every league the user is in for a season. Each carries its draft_id.
   *
   * Cached briefly rather than not at all. Joining a league mid-session is
   * rare, reopening the board is not, and ten minutes is short enough that a
   * new league is one reload away.
   */
  async getUserLeagues(userId, season, sport = "nfl", { ttlMs = 10 * 60 * 1000 } = {}) {
    return (await this.cached(`leagues:${userId}:${sport}:${season}`, ttlMs,
      () => this.get(`/user/${userId}/leagues/${sport}/${season}`))) ?? [];
  }

  /* Every draft the user is in for a season, skipping the league lookup. */
  async getUserDrafts(userId, season, sport = "nfl") {
    return (await this.get(`/user/${userId}/drafts/${sport}/${season}`)) ?? [];
  }

  // ----------------------------------------------------------------- leagues

  /* League settings, scoring, roster positions, and the current draft_id. */
  getLeague(leagueId) {
    return this.get(`/league/${leagueId}`);
  }

  /* Managers in the league → user_id, display_name, and team metadata. */
  async getLeagueUsers(leagueId) {
    return (await this.get(`/league/${leagueId}/users`)) ?? [];
  }

  /* Rosters → roster_id, owner_id, and the player_ids on each team. */
  async getLeagueRosters(leagueId) {
    return (await this.get(`/league/${leagueId}/rosters`)) ?? [];
  }

  /* One week's fixtures and scores → a row per roster, paired by matchup_id.
   *
   * Every week of the season answers from the day the league is made: the
   * fixtures are set, and `points` is 0.0 until the games are played. So an
   * empty-looking week is a week that hasn't happened, not a failed request —
   * see playedWeeks in js/luck.js, which is what decides a week is over.
   *
   * `points` is the week's final score once it is; mid-Sunday it is whatever
   * has been scored so far, so a week in progress is worth nothing but a
   * scoreboard. Cached for five minutes: a finished week never changes again,
   * and a live one is not what this is for.
   */
  async getMatchups(leagueId, week, { ttlMs = 5 * 60 * 1000 } = {}) {
    return (await this.cached(`matchups:${leagueId}:${week}`, ttlMs,
      () => this.get(`/league/${leagueId}/matchups/${week}`))) ?? [];
  }

  /* All drafts for a league, newest first (dynasty leagues have several).
   *
   * A minute, which is long enough to make switching between leagues feel
   * instant and short enough that a draft created while the board is open shows
   * up without a hard reload. The draft's own state never comes from here —
   * getDraft and getDraftPicks are both fresh by default.
   */
  async getLeagueDrafts(leagueId, { ttlMs = 60 * 1000 } = {}) {
    return (await this.cached(`drafts:${leagueId}`, ttlMs,
      () => this.get(`/league/${leagueId}/drafts`))) ?? [];
  }

  // ------------------------------------------------------------------ drafts

  /* Draft metadata: status, type, settings, draft_order, slot_to_roster_id.
   *
   * status is one of pre_draft / drafting / paused / complete; type is
   * snake / linear / auction. settings carries teams, rounds, pick_timer,
   * reversal_round, and the slots_* roster construction.
   *
   * Fresh by default: `status` is the field worth having, and a cached copy of
   * it is a draft that looks like it hasn't started yet.
   */
  getDraft(draftId, fresh = true) {
    return this.get(`/draft/${draftId}`, { fresh });
  }

  /* Picks made so far, ordered by pick_no. Empty before the draft starts.
   *
   * Each pick embeds a `metadata` dict (name, position, team, injury_status),
   * so drafted players can be identified without joining the player file.
   *
   * Fresh by default, and this is the endpoint that most needs it: Sleeper lets
   * Cloudflare hold it for a day, so a plain poll can sit on the same edge copy
   * while the draft moves on without you. There is no such thing as a usefully
   * stale pick list — the whole point of asking is what has happened since.
   */
  async getDraftPicks(draftId, fresh = true) {
    return (await this.get(`/draft/${draftId}/picks`, { fresh })) ?? [];
  }

  // ------------------------------------------------------------- projections

  /* Season projections for every drafted position, including the ADP set.
   *
   * Undocumented: this hangs off api.sleeper.app/projections rather than the
   * /v1 base every other method here uses, and Sleeper makes no promises about
   * it. Treat a shape change as expected rather than exceptional.
   *
   * This one response is the board's entire player pool. Each record carries
   * the player himself — name, team, position, injury status — alongside a
   * `stats` object holding both the projected line (pass_yd, rec, rush_td...)
   * and every adp_* format, keyed the same way a league's scoring_settings is.
   * That is why the board never fetches /players/nfl: the full player file is
   * 14 MB to answer questions this 3 MB response already answers.
   *
   * ADP moves over days, never over a draft, so it is cached hard. Its ttl is
   * the only reason a board opened twice in an evening costs one request.
   */
  getProjections(season, { sport = "nfl", seasonType = "regular", positions = POSITIONS,
                           orderBy = "adp_half_ppr", ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    const url = new URL(`${PROJECTIONS_URL}/${sport}/${season}`);
    url.searchParams.set("season_type", seasonType);
    url.searchParams.set("order_by", orderBy);
    // Positions repeat as position[]=QB&position[]=RB.
    for (const position of positions) url.searchParams.append("position[]", position);

    return this.cached(
      `projections:${sport}:${season}:${seasonType}:${positions.join(",")}`,
      ttlMs,
      async () => (await this.request(url.toString())) ?? [],
    );
  }

  /* The week as Sleeper sees it right now → {at, tags, projections}.
   *
   * One request to the weekly projections feed: about a quarter of a megabyte
   * compressed for every QB, RB, WR, TE, kicker and defence. `tags` is each player's
   * live `injury_status` (the same as the fourteen-megabyte player file has),
   * as Map(player_id → tag or null). `projections` is Sleeper's own projected
   * stat line for each player it projects, as Map(player_id → stats), with its
   * pre-scored `pts_*` totals and ADP fields dropped — a line is scored here,
   * under the league's own settings, the same as ours.
   *
   * Kept five minutes, because the reason to ask at all is that injury tags
   * change on a Sunday morning.
   */
  async getWeekReport(season, week, { sport = "nfl", seasonType = "regular",
                                       positions = ["QB", "RB", "WR", "TE", "K", "DEF"],
                                       ttlMs = 5 * 60 * 1000 } = {}) {
    const url = new URL(`${PROJECTIONS_URL}/${sport}/${season}/${week}`);
    url.searchParams.set("season_type", seasonType);
    for (const position of positions) url.searchParams.append("position[]", position);

    const report = await this.cached(`week-report:${sport}:${season}:${week}:${positions.join(",")}`, ttlMs, async () => {
      const rows = await this.request(url.toString());
      if (!Array.isArray(rows)) return null;
      const projections = {};
      for (const row of rows) {
        const stats = Object.entries(row.stats ?? {})
          .filter(([key, value]) => typeof value === "number" && value !== 0 && !/^(?:adp_|pos_adp_|rank_|pts_)/.test(key));
        if (stats.length > 1) projections[row.player_id] = Object.fromEntries(stats);
      }
      return {
        at: new Date().toISOString(),
        tags: Object.fromEntries(rows.map((row) => [row.player_id, row.player?.injury_status ?? null])),
        projections,
      };
    });
    return report ? {
      at: report.at,
      tags: new Map(Object.entries(report.tags)),
      projections: new Map(Object.entries(report.projections)),
    } : null;
  }

  /* Every player Sleeper knows, keyed by player_id. Fourteen megabytes.
   *
   * The board never calls this, and that is the whole design: the projections
   * response already carries each player's name, team, position and injury
   * status, so a browser has no reason to download the full file to draw a
   * list. What only lives here is `age` and `depth_chart_order`, which nothing
   * on the board reads but a researcher grading a player wants to see.
   *
   * So this is for the command line, where a 14 MB response cached for a day is
   * a fair price for context a person is about to spend an hour thinking about.
   * Never call it in a loop, and never from the page.
   */
  async getAllPlayers(sport = "nfl", { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    return (await this.cached(`players:${sport}`, ttlMs,
      () => this.get(`/players/${sport}`))) ?? {};
  }

  /* Current season and week → {season, week, season_type, ...}. */
  getState(sport = "nfl") {
    return this.cached(`state:${sport}`, 60 * 60 * 1000, () => this.get(`/state/${sport}`));
  }
}

/* Return [round, draftSlot] for a 1-based overall pick number.
 *
 * Sleeper has no current-pick field, so this is derived. Reversal rounds are
 * fiddly; verify against the first round of real picks before trusting it.
 */
export function onTheClock(pickNo, teams, draftType, reversalRound = 0) {
  const round = Math.ceil(pickNo / teams);
  const index = (pickNo - 1) % teams;
  if (draftType === "linear") return [round, index + 1];

  let forward = round % 2 === 1;
  if (reversalRound && round >= reversalRound) forward = !forward;
  return [round, forward ? index + 1 : teams - index];
}

/* Which overall pick a slot owns in a given round — the inverse of onTheClock. */
export function pickNumber(round, slot, teams, draftType, reversalRound = 0) {
  let forward = draftType !== "snake" || round % 2 === 1;
  if (draftType === "snake" && reversalRound && round >= reversalRound) forward = !forward;
  return (round - 1) * teams + (forward ? slot : teams - slot + 1);
}
