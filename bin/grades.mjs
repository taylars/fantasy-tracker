#!/usr/bin/env node
/* Edit data/historical/<season>/grades.json directly. No generated grade copies. */
import { readdir } from "node:fs/promises";
import { indexedSeasons, validateGradeCohort } from "../js/grades.js";
import { loadLocalGrades, readProjectJson } from "./lib/grades.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: grades check [--all | --season YEAR]\n       grades queue [--season YEAR] [--top 200] [--regrade]\nEdit the canonical season grades.json directly; queue prints JSON without writing.");
  process.exit(0);
}
const command = args.shift();
const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (["--all", "--regrade", "--check"].includes(arg)) options[arg.slice(2)] = true;
  else if (["--season", "--top"].includes(arg) && args[i + 1]) options[arg.slice(2)] = args[++i];
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!["check", "queue"].includes(command)) throw new Error("Use grades check or grades queue; grade files are now edited directly.");
const index = await readProjectJson("data/historical/index.json");
const years = indexedSeasons(index);
if (command === "check") {
  if (options.all && options.season) throw new Error("Choose --all or --season");
  if (options.all) {
    const dirs = (await readdir(new URL("../data/historical/", import.meta.url), { withFileTypes: true }))
      .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name)).map(d => d.name).sort();
    if (JSON.stringify(dirs) !== JSON.stringify([...years].sort())) throw new Error("Historical season index is stale");
  }
  for (const season of options.all ? years : [options.season ?? years[0]]) {
    // A captured-but-ungraded season is a known state, not a broken one: the
    // backtest runs it with neutral defaults. Only --all tolerates it, so
    // asking for one season by name still fails loudly when it has no grades.
    let document;
    try {
      document = await loadLocalGrades(season);
    } catch (error) {
      if (!options.all || error?.code !== "ENOENT") throw error;
      console.log(`${season}: ungraded (no grades.json)`);
      continue;
    }
    validateGradeCohort(document, await readProjectJson(`data/historical/${season}/draft.json`));
    console.log(`${season}: validated ${Object.keys(document.grades).length} canonical grades`);
  }
} else {
  const document = await loadLocalGrades(options.season);
  const draft = await readProjectJson(`data/historical/${document.season}/draft.json`);
  const top = Number(options.top ?? 200);
  if (!Number.isSafeInteger(top) || top < 1) throw new Error("--top must be a positive integer");
  const players = draft.players.filter(p => ["QB", "RB", "WR", "TE"].includes(p.position))
    .map(p => ({ player_id: p.player_id, name: p.name, position: p.position, team: p.team,
      adp: Math.min(...[p.adp.std, p.adp.half_ppr, p.adp.ppr].filter(Number.isFinite)) }))
    .sort((a, b) => a.adp - b.adp).slice(0, top)
    .filter(p => options.regrade || !document.grades[p.player_id]);
  console.log(JSON.stringify({ season: document.season, players }, null, 2));
}
