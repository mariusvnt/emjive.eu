#!/usr/bin/env node
/* ==========================================================================
   check-dist — assertions about the BUILT site in dist/, run after
   `npm run build` and before anything is deployed. The deploy mirrors dist/
   over the live site with --delete, so a build that silently lost a folder or
   regressed one of the build fixes in vite.config.js would otherwise go
   straight to production. Everything here is something that has actually
   gone wrong, or that the deploy's own `test -f dist/index.html` can't see.

   What it checks:
     - the files the host needs are present (.htaccess, robots.txt, 404.html,
       sitemap.xml, the icons)
     - nothing that must not be public is in there (dev tool pages, the
       unbundled three-viewer source, HDR sources, sourcemaps, docs)
     - every local href/src in every page resolves to a real file
     - <head> order: the stylesheet comes before the first script, and the
       series.json preload was not inlined into a data: URL (both undone
       by Vite unless vite.config.js's post plugin restores them)
     - indexing: the empty shell pages and the order page are noindex, the
       pages that should be found are not
     - clean URLs: every item has its own page (dist/<slug>.html) carrying its
       own canonical/title, the links use extension-less addresses that map
       onto real files, the sitemap lists those addresses, and .htaccess has
       the rewrite rules that serve them

   Run:  npm run check-dist
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const { slugify } = require("./slugs");

const SITE_ORIGIN = "https://emjive.eu";

const DIST = path.resolve(__dirname, "..", "dist");
const problems = [];
const fail = (message) => problems.push(message);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("check-dist: dist/index.html is missing — run `npm run build` first.");
  process.exit(1);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const files = walk(DIST).map((f) => path.relative(DIST, f).split(path.sep).join("/"));
const fileSet = new Set(files);

/* ---- required ---------------------------------------------------------- */

for (const required of [".htaccess", "robots.txt", "404.html", "sitemap.xml", "favicon.ico", "apple-touch-icon.png"]) {
  if (!fileSet.has(required)) fail("missing from dist/: " + required);
}

/* ---- forbidden --------------------------------------------------------- */

const forbidden = [
  [/^(json-tool|scene-tool|loader-test)\.html$/, "dev-only tool page"],
  [/^js\/(three-viewer|viewer-entry|hdr-worker|stack-scene)\.js$/, "unbundled module source (the built pages load the hashed chunk)"],
  [/\.(exr|map)$/i, "source art / sourcemap"],
  [/^(node_modules|scripts|dev-guidelines|\.git|\.github)\//, "repo-internal folder"],
  [/^(README|CLAUDE)\.md$/, "repo doc"],
  [/^assets\/fonts\//, "font source folder (Vite ships its own hashed copies)"],
  [/^assets\/hand_normal\.webp$/, "dead asset"]
];
for (const file of files) {
  for (const [pattern, why] of forbidden) {
    if (pattern.test(file)) fail("must not be in dist/: " + file + " — " + why);
  }
}

/* ---- pages ------------------------------------------------------------- */

// Root-level pages only. The hero fragments under series/<slug>/ are .html
// too, but they are not documents: they are cloned into index.html at runtime,
// so their paths resolve against THAT page, not against where the file sits.
const pages = files.filter((f) => f.endsWith(".html") && !f.includes("/"));

// Comments are blanked (same length) so a tag mentioned inside one of the
// pages' long explanatory comments is never mistaken for a real one.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));

function resolvesLocally(ref, fromPage) {
  const clean = ref.split("#")[0].split("?")[0];
  if (clean === "") return true; // "#top", "?x=y" — the page itself
  const target = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromPage), clean));
  if (target === "" || target === ".") return fileSet.has("index.html");
  if (fileSet.has(target)) return true;
  // A clean address (/archives, /gallery, /furcula): what public/.htaccess
  // serves as <name>.html, with /gallery being index.html.
  if (clean.startsWith("/") && !target.includes("/") && !target.includes(".")) {
    return target === "gallery" ? fileSet.has("index.html") : fileSet.has(target + ".html");
  }
  return false;
}

const NOINDEX = new Set(["archives.html", "creation-process.html", "series.html", "terms.html", "launch-order.html", "404.html"]);

for (const page of pages) {
  const raw = fs.readFileSync(path.join(DIST, page), "utf8");
  const html = stripComments(raw);
  const head = html.split("</head>")[0];

  if (/<link\b[^>]*\bhref="data:application\/json/.test(head)) {
    fail(page + ": the series.json preload was inlined into a data: URL (see restoreHeadOrderAndPreload in vite.config.js)");
  }

  const firstScript = head.search(/<script\b/);
  const sheet = head.search(/<link\b[^>]*\brel="stylesheet"/);
  if (sheet === -1) fail(page + ": no stylesheet link in <head>");
  else if (firstScript !== -1 && sheet > firstScript) fail(page + ": the stylesheet comes after the first <script> in <head>");

  // The early-discovery hints injectLoadHints() adds (vite.config.js): a page
  // that opts in with data-products="eager" has to carry the products.json
  // preload (the generic href check below then confirms it points at a file).
  const htmlTag = (html.match(/<html\b[^>]*>/) || [""])[0];
  if (htmlTag.includes('data-products="eager"') &&
      !/<link\b[^>]*\brel="preload"[^>]*\bas="fetch"[^>]*\bhref="data\/series\/[^"]+\/products\.json"/.test(head)) {
    fail(page + ": no products.json preload (see injectLoadHints in vite.config.js)");
  }

  const noindex = /<meta\b[^>]*\bname="robots"[^>]*\bcontent="[^"]*noindex/.test(head);
  if (NOINDEX.has(page) && !noindex) fail(page + ": should be noindex");
  if (!NOINDEX.has(page) && noindex) fail(page + ": should not be noindex");

  for (const match of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const ref = match[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(ref)) continue;
    if (!resolvesLocally(ref, page)) fail(page + ": references a file that is not in dist/: " + ref);
  }
}

/* ---- items -------------------------------------------------------------- */

const readJson = (rel) => JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8"));
const catalog = readJson("data/series.json");
const items = [];
for (const series of catalog.series) {
  for (const product of readJson(series.products).products) {
    items.push({ product, series, slug: slugify(product.name) });
  }
}

for (const { product, series, slug } of items) {
  const file = slug + ".html";
  if (!fileSet.has(file)) { fail("no page for item " + product.name + ": dist/" + file + " is missing (emitItemPages in vite.config.js)"); continue; }
  const head = fs.readFileSync(path.join(DIST, file), "utf8").split("</head>")[0];
  const url = SITE_ORIGIN + "/" + slug;
  if (!head.includes('<link rel="canonical" href="' + url + '" />')) fail(file + ": canonical is not " + url);
  if (!head.includes('<meta property="og:url" content="' + url + '" />')) fail(file + ": og:url is not " + url);
  if (!head.includes("<title>" + product.name)) fail(file + ": <title> does not start with the item's name");
  if (!head.includes('href="' + series.products + '"')) fail(file + ": no products.json hint for its series (" + series.products + ")");
}

// Pages that are not items name their own canonical form too: no .html.
for (const page of ["index.html", ...[...NOINDEX].filter((p) => p !== "404.html")]) {
  if (!fileSet.has(page)) continue;
  const head = fs.readFileSync(path.join(DIST, page), "utf8").split("</head>")[0];
  const url = page === "index.html" ? SITE_ORIGIN + "/gallery" : SITE_ORIGIN + "/" + page.replace(/\.html$/, "");
  if (!head.includes('<meta property="og:url" content="' + url + '" />')) fail(page + ": og:url is not " + url);
  if (page === "index.html" && !head.includes('<link rel="canonical" href="' + url + '" />')) fail(page + ": canonical is not " + url);
}

if (fileSet.has(".htaccess")) {
  const rules = fs.readFileSync(path.join(DIST, ".htaccess"), "utf8");
  for (const needle of ["RewriteRule ^gallery$ index.html [L]", "RewriteCond %{REQUEST_FILENAME}.html -f", "RewriteRule ^index\\.html$ /gallery [L,R=301]"]) {
    if (!rules.includes(needle)) fail(".htaccess: the clean-URL rules are missing (" + needle + ")");
  }
}

/* ---- sitemap ------------------------------------------------------------ */

if (fileSet.has("sitemap.xml")) {
  const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urls.length < 2) fail("sitemap.xml lists fewer than two URLs");
  const wanted = [SITE_ORIGIN + "/gallery", ...items.map((i) => SITE_ORIGIN + "/" + i.slug)];
  for (const url of wanted) if (!urls.includes(url)) fail("sitemap.xml does not list " + url);
  for (const url of urls) {
    if (!wanted.includes(url)) fail("sitemap.xml lists an address the site does not use: " + url);
  }
  for (const url of urls) {
    for (const noindexed of NOINDEX) {
      if (url.includes("/" + noindexed)) fail("sitemap.xml lists a noindex page: " + url);
    }
  }
}

/* ---- result ------------------------------------------------------------- */

if (problems.length) {
  console.error("check-dist: " + problems.length + " problem" + (problems.length === 1 ? "" : "s") + "\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("check-dist: ok (" + pages.length + " pages, " + files.length + " files)");
