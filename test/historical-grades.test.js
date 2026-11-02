import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateGrades, validateGradeCohort } from "../js/grades.js";

const document = JSON.parse(readFileSync(new URL("../data/historical/2025/grades.json", import.meta.url)));
const draft = JSON.parse(readFileSync(new URL("../data/historical/2025/draft.json", import.meta.url)));
const first = Object.keys(document.grades)[0];

test("canonical historical grades reject invalid evidence metadata and grades", () => {
  validateGrades(document);
  validateGradeCohort(document, draft);
  for (const mutate of [
    g => { g.sources[0].published_at = "2025-08-30"; },
    g => { g.sources[0].published_at = "not-a-date"; },
    g => { g.sources[0].updated_at = "2026-01-01"; },
    g => { g.team = "UNKNOWN"; },
    g => { g.exp_games = 18; },
    g => { g.exp_games = NaN; },
    g => { g.evidence_status = undefined; },
    g => { g.offense = g.offense === 2 ? -2 : 2; },
  ]) {
    const changed = structuredClone(document);
    mutate(changed.grades[first]);
    assert.throws(() => validateGrades(changed));
  }
  const missing = structuredClone(document);
  delete missing.grades[first];
  assert.throws(() => validateGradeCohort(missing, draft), /cohort/);
  const extra = structuredClone(document);
  extra.grades.unknown = structuredClone(document.grades[first]);
  assert.throws(() => validateGradeCohort(extra, draft), /cohort/);
  const duplicate = structuredClone(draft);
  duplicate.players[0].grade = document.grades[first];
  assert.throws(() => validateGradeCohort(document, duplicate), /Duplicate grades/);
});

test("grade queue uses the same three ADP formats as cohort validation", () => {
  const queue = JSON.parse(execFileSync(process.execPath,
    ["bin/grades.mjs", "queue", "--season", "2025", "--regrade"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" }));
  const expected = draft.players.filter(p => document.selection.positions.includes(p.position))
    .sort((a, b) => Math.min(a.adp.std, a.adp.half_ppr, a.adp.ppr) - Math.min(b.adp.std, b.adp.half_ppr, b.adp.ppr))
    .slice(0, document.selection.count).map(p => p.player_id);
  assert.deepEqual(queue.players.map(p => p.player_id), expected);
});

test("historical team corrections require dated evidence and retain the archived team", () => {
  const changed = structuredClone(document);
  const grade = changed.grades[first];
  const archivedTeam = grade.team;
  grade.team = changed.offense_normalization.ranked_teams.find(t => t !== archivedTeam);
  const rank = changed.offense_normalization.ranked_teams.indexOf(grade.team);
  grade.offense = rank < 3 ? 2 : rank < 10 ? 1 : rank < 22 ? 0 : rank < 29 ? -1 : -2;
  assert.throws(() => validateGradeCohort(changed, draft), /cohort/);
  grade.archived_team = archivedTeam;
  grade.team_source = structuredClone(grade.sources[0]);
  assert.doesNotThrow(() => validateGradeCohort(changed, draft));
  grade.team_source.published_at = "2026-01-01";
  assert.throws(() => validateGradeCohort(changed, draft), /post-cutoff/);
  grade.team_source = structuredClone(grade.sources[0]);
  grade.archived_team = "WRONG";
  assert.throws(() => validateGradeCohort(changed, draft), /cohort/);
  grade.archived_team = archivedTeam;
  grade.team = null;
  grade.offense = 0;
  assert.doesNotThrow(() => validateGradeCohort(changed, draft));
  grade.offense = 1;
  assert.throws(() => validateGradeCohort(changed, draft), /normalization/);
});
