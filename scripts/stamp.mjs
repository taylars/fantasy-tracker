/* Stamp every script and stylesheet URL with the deploy's version.
 *
 *   node scripts/stamp.mjs <version> [root]
 *
 * Run by the Pages workflow on the checkout it is about to upload, never on
 * the working tree you edit. It rewrites `js/app.js` to `js/app.js?v=<sha>`
 * everywhere one file names another, and nothing else.
 *
 * Why: Pages serves every file with max-age=600 and no way to change it, and
 * a browser caches each file on its own clock. Straight after a deploy it can
 * hold the new luck.html alongside the previous luck-app.js — new layout, old
 * code — which is exactly how the luck number ended up printed across the
 * Exp column on a page that no longer prints it. With every reference carrying
 * the deploy's version, a fresh page can only ask for that deploy's files, and
 * a page still cached from the last deploy asks for the last deploy's files,
 * which are consistent with it. The two can no longer mix.
 *
 * Data is not stamped: grades.js fetches with cache: "no-store" already.
 *
 * This is the one place the shipped files differ from the repository, and it
 * is a query string — Pages and scripts/start.mjs both ignore it when finding
 * the file, so a stamped tree runs exactly like an unstamped one.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Relative paths to our own scripts and stylesheets only. Absolute URLs
// (Google Fonts, Sleeper) never match — they don't start with js/, css/ or
// ./ — and aren't ours to version.
const PATTERNS = {
  // <script src="js/app.js">, <link href="css/site.css">
  html: [new RegExp(String.raw`(\s(?:src|href)=")((?:js|css)/[\w./-]+\.(?:js|css))(")`, "g")],
  js: [
    // import { x } from "./sleeper.js";  export { y } from "./z.js";
    new RegExp(String.raw`(\bfrom\s*["'])(\.{1,2}/[\w./-]+\.js)(["'])`, "g"),
    // import "./side-effect.js";
    new RegExp(String.raw`(\bimport\s*["'])(\.{1,2}/[\w./-]+\.js)(["'])`, "g"),
    // import("./lazy.js")
    new RegExp(String.raw`(\bimport\(\s*["'])(\.{1,2}/[\w./-]+\.js)(["'])`, "g"),
    // new Worker(new URL("./worker.js", import.meta.url))
    new RegExp(String.raw`(\bnew URL\(\s*["'])(\.{1,2}/[\w./-]+\.js)(["'])`, "g"),
  ],
};

/* One file's text, stamped. Returns the new text and how many references
 * were rewritten, so the caller can tell "nothing to do" from "did nothing".
 */
export function stampText(text, kind, version) {
  let count = 0;
  for (const pattern of PATTERNS[kind]) {
    text = text.replace(pattern, (_, head, ref, tail) => {
      count++;
      return `${head}${ref}?v=${version}${tail}`;
    });
  }
  return { text, count };
}

/* References to our own files that carry no version — what the test uses to
 * prove stamping covered everything, including any reference added later in
 * a shape the patterns above don't know yet.
 */
export function unstamped(text, kind) {
  const loose = kind === "html"
    ? new RegExp(String.raw`\s(?:src|href)="((?:js|css)/[^"]+)"`, "g")
    : new RegExp(String.raw`["'](\.{1,2}/[^"']+\.js(?:\?[^"']*)?)["']`, "g");
  return [...text.matchAll(loose)].map((m) => m[1]).filter((ref) => !ref.includes("?v="));
}

/* Every page at the root and every module under js/. */
export async function stampTree(root, version) {
  const files = [
    ...(await readdir(root)).filter((f) => f.endsWith(".html")).map((f) => [f, "html"]),
    ...(await readdir(path.join(root, "js"))).filter((f) => f.endsWith(".js")).map((f) => [`js/${f}`, "js"]),
  ];

  let total = 0;
  for (const [rel, kind] of files) {
    const file = path.join(root, rel);
    const { text, count } = stampText(await readFile(file, "utf8"), kind, version);
    if (count) await writeFile(file, text);
    total += count;
  }
  return { files: files.length, references: total };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [version, rootArg] = process.argv.slice(2);
  if (!version || !/^[\w.-]+$/.test(version)) {
    console.error("usage: node scripts/stamp.mjs <version> [root]   (version: letters, digits, . _ -)");
    process.exit(1);
  }
  const root = path.resolve(rootArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const { files, references } = await stampTree(root, version);
  // A deploy that stamped nothing is a deploy whose pattern stopped matching,
  // and it would ship exactly the mixing this exists to prevent.
  if (!references) {
    console.error(`stamp: no references found under ${root}`);
    process.exit(1);
  }
  console.log(`stamp: ${references} references in ${files} files -> ?v=${version}`);
}
