/* One grade document per season. Live consumers select the newest indexed year;
 * historical consumers must explicitly request their own year. Never merge years.
 */
export const HISTORY_ROOT = "data/historical/";

export function seasonName(value) {
  const year = String(value);
  if (!/^\d{4}$/.test(year)) throw new Error(`Invalid grade season: ${year}`);
  return year;
}

export function indexedSeasons(index) {
  if (!Array.isArray(index?.seasons) || !index.seasons.length)
    throw new Error("No historical grade seasons indexed");
  const years = index.seasons.map(seasonName);
  if (new Set(years).size !== years.length) throw new Error("Duplicate grade season");
  return years.sort((a, b) => Number(b) - Number(a));
}

function checkSource(source, cutoff) {
  const url = typeof source === "string" ? source : source?.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("Invalid grade source URL");
  if (!cutoff) return;
  if (!source.title || typeof source.published_at !== "string") throw new Error("Missing dated grade source");
  for (const date of [source.published_at, source.updated_at].filter(v => v !== undefined)) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) ||
        !Number.isFinite(Date.parse(date)) || date.slice(0, 10) > cutoff.slice(0, 10))
      throw new Error(`Invalid or post-cutoff grade source: ${date}`);
  }
}

export function validateGrades(document, expectedSeason = document?.season) {
  if (!document || seasonName(document.season) !== seasonName(expectedSeason))
    throw new Error(`Grade season mismatch: expected ${expectedSeason}, got ${document?.season}`);
  if (!document.grades || typeof document.grades !== "object" || Array.isArray(document.grades))
    throw new Error("Missing grades map");
  const cutoff = document.cutoff;
  if (cutoff && (!Number.isFinite(Date.parse(cutoff)) || !cutoff.startsWith(`${document.season}-`)))
    throw new Error("Invalid grade cutoff");
  const offense = new Map();
  const rankTeams = document.offense_normalization?.ranked_teams;
  if (rankTeams) {
    if (rankTeams.length !== 32 || new Set(rankTeams).size !== 32) throw new Error("Invalid offense normalization");
    checkSource(document.offense_normalization.source, cutoff);
  }
  for (const [id, grade] of Object.entries(document.grades)) {
    if (!id || !grade?.name || !["QB", "RB", "WR", "TE"].includes(grade.position))
      throw new Error(`Invalid grade identity: ${id}`);
    for (const [field, low, high] of [["offense", -2, 2], ["position_security", -2, 2], ["upside", 0, 3], ["exp_games", 0, 17]]) {
      if (!Number.isFinite(grade[field]) || grade[field] < low || grade[field] > high)
        throw new Error(`${id}: ${field} must be ${low}..${high}`);
    }
    if (!grade.note || !Array.isArray(grade.sources) || !grade.sources.length) throw new Error(`${id}: missing grade evidence`);
    for (const source of grade.sources) checkSource(source, cutoff);
    if (cutoff) {
      if (grade.as_of !== cutoff) throw new Error(`${id}: grade cutoff mismatch`);
      if (!["researched", "conservative_default"].includes(grade.evidence_status)) throw new Error(`${id}: missing evidence_status`);
      checkSource(grade.offense_source, cutoff);
    }
    if (grade.team) {
      if (offense.has(grade.team) && offense.get(grade.team) !== grade.offense)
        throw new Error(`${grade.team}: contradictory offense grades`);
      offense.set(grade.team, grade.offense);
    }
    if (rankTeams) {
      // A documented free agent has no cutoff-date offense to rank.
      if (grade.team === null && grade.offense === 0 && grade.team_source && cutoff) {
        checkSource(grade.team_source, cutoff);
        continue;
      }
      const rank = rankTeams.indexOf(grade.team);
      const normalized = rank < 3 ? 2 : rank < 10 ? 1 : rank < 22 ? 0 : rank < 29 ? -1 : -2;
      if (rank < 0 || grade.offense !== normalized) throw new Error(`${id}: offense normalization mismatch`);
    }
  }
  return document;
}

export async function loadGrades({ season, readJson, fetchImpl = globalThis.fetch } = {}) {
  const read = readJson ?? (async path => {
    const response = await fetchImpl(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`Couldn't load ${path} (${response.status})`);
    return response.json();
  });
  const selected = season == null
    ? indexedSeasons(await read(`${HISTORY_ROOT}index.json`))[0]
    : seasonName(season);
  // A missing/broken newest file is an error, never an excuse to use older grades.
  return validateGrades(await read(`${HISTORY_ROOT}${selected}/grades.json`), selected);
}

export function validateGradeCohort(document, draft) {
  validateGrades(document, draft.season);
  if (draft.players.some(p => "grade" in p)) throw new Error("Duplicate grades embedded in draft snapshot");
  if (draft.grades_source !== `${HISTORY_ROOT}${document.season}/grades.json`)
    throw new Error("Draft points to noncanonical grades");
  if (!document.selection) return;
  const wanted = draft.players.filter(p => document.selection.positions.includes(p.position))
    .sort((a, b) => Math.min(a.adp.std, a.adp.half_ppr, a.adp.ppr) - Math.min(b.adp.std, b.adp.half_ppr, b.adp.ppr))
    .slice(0, document.selection.count);
  if (Object.keys(document.grades).length !== wanted.length) throw new Error("Grade cohort count mismatch");
  for (const player of wanted) {
    const grade = document.grades[player.player_id];
    if (!grade || grade.position !== player.position)
      throw new Error(`Grade cohort mismatch: ${player.player_id}`);
    if (grade.team !== player.team) {
      // Preserve the fetched archive while recording a sourced preseason correction.
      if (!document.cutoff || !Object.hasOwn(grade, "archived_team") ||
          grade.archived_team !== player.team || !grade.team_source)
        throw new Error(`Grade cohort mismatch: ${player.player_id}`);
      checkSource(grade.team_source, document.cutoff);
    }
  }
}
