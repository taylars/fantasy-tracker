/* The lineup page's wiring, read as text.
 *
 * The page only runs in a browser, so the suite cannot click it. What it can
 * do is hold every event handler to calling a function that exists: a week
 * picker once pointed at a `showWeek` an edit had deleted, and nothing
 * noticed, because loading a week from the url never calls it — only
 * changing the picker does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../js/lineup-app.js", import.meta.url), "utf8");

const defined = new Set([
  ...[...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
  ...[...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].map((m) => m[1]),
]);

test("every event handler calls a function the page defines", () => {
  const handlers = [...source.matchAll(/addEventListener\(\s*"[\w-]+"\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\{([\s\S]*?)\}\s*\)|([^;]+?)\))/g)];
  assert.ok(handlers.length >= 5, "found the handlers");
  for (const [, block, expression] of handlers) {
    const body = block ?? expression;
    for (const [, name] of body.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) {
      if (["if", "for", "while", "switch", "catch", "return", "$", "esc"].includes(name)) continue;
      assert.ok(defined.has(name), `a handler calls ${name}(), which lineup-app.js does not define`);
    }
  }
});

test("every picker the page wires up is on the page", async () => {
  const html = await readFile(new URL("../lineup.html", import.meta.url), "utf8");
  for (const [, id] of source.matchAll(/\$\("([\w-]+)"\)\.addEventListener/g)) {
    assert.ok(html.includes(`id="${id}"`), `lineup.html has no #${id}`);
  }
});
