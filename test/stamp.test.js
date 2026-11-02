/* Deploy-time version stamping, run against a copy of the real pages.
 *
 * The claim worth pinning down is coverage: after stamping, no page or module
 * names another of our files without the version on it. A reference that
 * slips through is a file a browser can serve from an older deploy, and a
 * mixed deploy is the bug this exists to prevent — it drew a stale luck number
 * across the Exp column. So the test stamps the actual repository files rather
 * than fixtures, and a new import written in a shape the stamper doesn't know
 * fails here instead of on the live site.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampText, stampTree, unstamped } from "../scripts/stamp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function stampedCopy(version) {
  const dir = await mkdtemp(path.join(tmpdir(), "stamp-"));
  for (const f of await readdir(ROOT)) if (f.endsWith(".html")) await cp(path.join(ROOT, f), path.join(dir, f));
  await cp(path.join(ROOT, "js"), path.join(dir, "js"), { recursive: true });
  const result = await stampTree(dir, version);
  return { dir, result };
}

test("every reference between our own files carries the version", async () => {
  const { dir, result } = await stampedCopy("abc123");
  try {
    assert.ok(result.references > 0);
    const leftovers = [];
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".html")) continue;
      leftovers.push(...unstamped(await readFile(path.join(dir, f), "utf8"), "html").map((r) => `${f}: ${r}`));
    }
    for (const f of await readdir(path.join(dir, "js"))) {
      leftovers.push(...unstamped(await readFile(path.join(dir, "js", f), "utf8"), "js").map((r) => `js/${f}: ${r}`));
    }
    assert.deepEqual(leftovers, [], "unversioned references would let a browser mix deploys");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the pages and modules that reach each other are all stamped", async () => {
  const { dir } = await stampedCopy("abc123");
  try {
    const luck = await readFile(path.join(dir, "luck.html"), "utf8");
    assert.match(luck, /src="js\/luck-app\.js\?v=abc123"/);
    assert.match(luck, /src="js\/nav\.js\?v=abc123"/);
    assert.match(luck, /href="css\/site\.css\?v=abc123"/);

    const app = await readFile(path.join(dir, "js", "luck-app.js"), "utf8");
    assert.match(app, /from "\.\/luck\.js\?v=abc123"/);
    assert.match(app, /from "\.\/sleeper\.js\?v=abc123"/);

    // The board's worker is reached through new URL(), not an import.
    const board = await readFile(path.join(dir, "js", "app.js"), "utf8");
    assert.match(board, /new URL\("\.\/worker\.js\?v=abc123", import\.meta\.url\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("other people's URLs are left alone", () => {
  const html = '<link href="https://fonts.googleapis.com/css2?family=Archivo" rel="stylesheet">' +
               '<a href="luck.html" data-nav>Luck</a><script src="js/app.js"></script>';
  const { text, count } = stampText(html, "html", "v1");
  assert.equal(count, 1);
  assert.match(text, /fonts\.googleapis\.com\/css2\?family=Archivo"/);
  assert.match(text, /href="luck\.html"/); // a page link, not an asset: it must stay bookmarkable
  assert.match(text, /src="js\/app\.js\?v=v1"/);

  const js = 'import x from "node:fs"; const u = new URL("https://api.sleeper.app/v1");';
  assert.equal(stampText(js, "js", "v1").count, 0);
});

test("stamping twice does not stack versions", () => {
  const once = stampText('import { a } from "./a.js";', "js", "v1").text;
  assert.equal(stampText(once, "js", "v2").text, once);
});

test("the working tree itself is never stamped", async () => {
  // The stamp belongs to the upload, not the repository. Committed, a
  // version would point every later deploy's pages at one old commit's files.
  for (const f of ["index.html", "luck.html", "js/app.js", "js/luck-app.js"]) {
    assert.doesNotMatch(await readFile(path.join(ROOT, f), "utf8"), /\?v=/, f);
  }
});
