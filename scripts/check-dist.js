#!/usr/bin/env node
// Assertions about the built site in dist/, before deploy (which mirrors dist/
// with --delete): required host files, nothing private, every local href/src
// resolves, <head> order and the studies.json preload, noindex pages, link
// preview images, per-item pages, clean URLs and the sitemap.

const fs = require("node:fs");
const path = require("node:path");
const { slugify } = require("./slugs");
const { ROOT, SITE_ORIGIN, readJson, walk, exitOnProblems } = require("./helpers");

const DIST = path.join(ROOT, "dist");
const problems = [];
const fail = (message) => problems.push(message);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("check-dist: dist/index.html is missing — run `npm run build` first.");
  process.exit(1);
}

const files = walk(DIST).map((f) => path.relative(DIST, f).split(path.sep).join("/"));
const fileSet = new Set(files);

/* ---- required ---------------------------------------------------------- */

for (const required of [".htaccess", "robots.txt", "404.html", "sitemap.xml", "favicon.ico", "apple-touch-icon.png", "preview.jpg", "logo.png"]) {
  if (!fileSet.has(required)) fail("missing from dist/: " + required);
}
// The item pages' template only (emitItemPages in vite.config.js).
if (fileSet.has("product.html")) fail("dist/product.html ships: it should be deleted once the item pages are written");

/* ---- forbidden --------------------------------------------------------- */

const forbidden = [
  [/^(json-tool|scene-tool|loader-test)\.html$/, "dev-only tool page"],
  [/^js\/(three-viewer|viewer-entry|hdr-worker|stack-scene)\.js$/, "unbundled module source (the built pages load the hashed chunk)"],
  [/\.(exr|map)$/i, "source art / sourcemap"],
  [/\.stl$/i, "print model (for the printer, not for visitors; vite.config.js leaves them out)"],
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

// Root-level pages only: studies/<slug>/ hero fragments are cloned into
// index.html, so their paths resolve against it.
const pages = files.filter((f) => f.endsWith(".html") && !f.includes("/"));

// Blanked to the same length so tags mentioned in comments aren't matched.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));

function resolvesLocally(ref, fromPage) {
  const clean = ref.split("#")[0].split("?")[0];
  if (clean === "") return true; // "#top", "?x=y" — the page itself
  const target = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromPage), clean));
  if (target === "" || target === ".") return fileSet.has("index.html");
  if (fileSet.has(target)) return true;
  // A clean address (/archives, /furcula), served by public/.htaccess as
  // <name>.html. /gallery and /index only redirect to /, so a link names / instead.
  if (clean.startsWith("/") && !target.includes("/") && !target.includes(".")) {
    return target !== "gallery" && target !== "index" && fileSet.has(target + ".html");
  }
  return false;
}

const NOINDEX = new Set(["who-are-we.html", "intent.html", "3d-printing.html", "environment.html", "studies.html", "terms.html", "legal-notice.html", "privacy.html", "launch-order.html", "404.html"]);

// The links the law asks for from every page: in the shared footer, and on the
// homepage also in the wheel view's legal strip.
const LEGAL_LINKS = ["/legal-notice", "/terms", "/privacy"];
function hasLegalLinks(block) {
  return LEGAL_LINKS.every((href) => block.includes('href="' + href + '"'));
}

for (const page of pages) {
  const raw = fs.readFileSync(path.join(DIST, page), "utf8");
  const html = stripComments(raw);
  const head = html.split("</head>")[0];

  if (/<link\b[^>]*\bhref="data:application\/json/.test(head)) {
    fail(page + ": the studies.json preload was inlined into a data: URL (see restoreHeadOrderAndPreload in vite.config.js)");
  }

  const firstScript = head.search(/<script\b/);
  const sheet = head.search(/<link\b[^>]*\brel="stylesheet"/);
  if (sheet === -1) fail(page + ": no stylesheet link in <head>");
  else if (firstScript !== -1 && sheet > firstScript) fail(page + ": the stylesheet comes after the first <script> in <head>");

  // Every script relies on window.EmjiveHelpers; modules run after the classic ones.
  const classic = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/\btype="module"/.test(tag));
  if (classic.length && !/\bsrc="js\/helpers\.js"/.test(classic[0])) fail(page + ": js/helpers.js is not its first classic <script>");

  // A page with data-products="eager" must carry the products.json preload
  // (injectLoadHints in vite.config.js).
  const htmlTag = (html.match(/<html\b[^>]*>/) || [""])[0];
  if (htmlTag.includes('data-products="eager"') &&
      !/<link\b[^>]*\brel="preload"[^>]*\bas="fetch"[^>]*\bhref="data\/studies\/[^"]+\/products\.json"/.test(head)) {
    fail(page + ": no products.json preload (see injectLoadHints in vite.config.js)");
  }

  if (page !== "404.html") {
    const footer = /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html);
    if (!footer || !hasLegalLinks(footer[1])) fail(page + ": no shared footer with the legal links");
    if (page === "index.html") {
      const strip = /<nav class="legal-strip"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
      if (!strip || !hasLegalLinks(strip[1])) fail(page + ": no legal strip with the legal links");
    }
  }

  const noindex = /<meta\b[^>]*\bname="robots"[^>]*\bcontent="[^"]*noindex/.test(head);
  if (NOINDEX.has(page) && !noindex) fail(page + ": should be noindex");
  if (!NOINDEX.has(page) && noindex) fail(page + ": should not be noindex");

  // Absolute (crawlers don't resolve relative ones) and present in dist/.
  // 404.html has no social tags.
  if (page !== "404.html") {
    for (const attr of ['property="og:image"', 'name="twitter:image"']) {
      const tag = head.match(new RegExp("<meta " + attr + ' content="([^"]*)"'));
      if (!tag) { fail(page + ": no " + attr + " tag"); continue; }
      const src = tag[1];
      if (!src.startsWith(SITE_ORIGIN + "/") || !fileSet.has(src.slice(SITE_ORIGIN.length + 1))) fail(page + ": preview picture (" + attr + ") is not a file of this site in dist/: " + src);
    }
  }

  for (const match of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const ref = match[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(ref)) continue;
    if (!resolvesLocally(ref, page)) fail(page + ": references a file that is not in dist/: " + ref);
  }
}

/* ---- items -------------------------------------------------------------- */

const catalog = readJson("data/studies.json");
const items = [];
for (const study of catalog.studies) {
  for (const product of readJson(study.products).products) {
    items.push({ product, study, slug: slugify(product.name) });
  }
}

for (const { product, study, slug } of items) {
  const file = slug + ".html";
  if (!fileSet.has(file)) { fail("no page for item " + product.name + ": dist/" + file + " is missing (emitItemPages in vite.config.js)"); continue; }
  const html = fs.readFileSync(path.join(DIST, file), "utf8");
  const head = html.split("</head>")[0];
  const url = SITE_ORIGIN + "/" + slug;
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!ld) fail(file + ": no structured data (emitItemPages in vite.config.js)");
  else {
    let data = null;
    try { data = JSON.parse(ld[1]); } catch (e) { fail(file + ": its structured data is not valid JSON"); }
    if (data && (data["@type"] !== "Product" || data.name !== product.name || data.url !== url)) {
      fail(file + ": its structured data is not this item's Product");
    }
  }
  if (!head.includes('<link rel="canonical" href="' + url + '" />')) fail(file + ": canonical is not " + url);
  if (!head.includes('<meta property="og:url" content="' + url + '" />')) fail(file + ": og:url is not " + url);
  if (!head.includes("<title>em·ji·ve: " + product.name.toLowerCase())) fail(file + ": <title> is not the brand and the item's name");
  if (!head.includes('href="' + study.products + '"')) fail(file + ": no products.json hint for its study (" + study.products + ")");
}

// Non-item pages' canonical form has no .html.
for (const page of ["index.html", "archives.html", ...[...NOINDEX].filter((p) => p !== "404.html")]) {
  if (!fileSet.has(page)) continue;
  const head = fs.readFileSync(path.join(DIST, page), "utf8").split("</head>")[0];
  const url = page === "index.html" ? SITE_ORIGIN + "/" : SITE_ORIGIN + "/" + page.replace(/\.html$/, "");
  if (!head.includes('<meta property="og:url" content="' + url + '" />')) fail(page + ": og:url is not " + url);
  if (page === "index.html" && !head.includes('<link rel="canonical" href="' + url + '" />')) fail(page + ": canonical is not " + url);
}

// The gallery's static grid and site data (emitGalleryContent in vite.config.js).
if (fileSet.has("index.html")) {
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const grid = (/<div class="product-grid" id="productGrid">([\s\S]*?)<\/section>/.exec(html) || ["", ""])[1];
  for (const { study, slug } of items) {
    if (study.slug === catalog.featured && !grid.includes('<a class="grid-item__name" href="/' + slug + '">')) {
      fail("index.html: the static grid has no link to /" + slug);
    }
  }
  const types = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    try { return (JSON.parse(m[1])["@graph"] || []).map((node) => node["@type"]); } catch (e) { return []; }
  });
  for (const type of ["Organization", "WebSite"]) if (!types.includes(type)) fail("index.html: no " + type + " structured data");
}

if (fileSet.has(".htaccess")) {
  const rules = fs.readFileSync(path.join(DIST, ".htaccess"), "utf8");
  for (const needle of ["RewriteRule ^index$ https://%{HTTP_HOST}/ [L,R=301]", "RewriteRule ^gallery$ https://%{HTTP_HOST}/#gallery [NE,L,R=301]", "RewriteCond %{REQUEST_FILENAME}.html -f", "RewriteRule ^index\\.html$ https://%{HTTP_HOST}/ [L,R=301]"]) {
    if (!rules.includes(needle)) fail(".htaccess: the clean-URL rules are missing (" + needle + ")");
  }
}

/* ---- sitemap ------------------------------------------------------------ */

if (fileSet.has("sitemap.xml")) {
  const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (urls.length < 2) fail("sitemap.xml lists fewer than two URLs");
  const wanted = [SITE_ORIGIN + "/", SITE_ORIGIN + "/archives", ...items.map((i) => SITE_ORIGIN + "/" + i.slug)];
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

exitOnProblems("check-dist", problems);
console.log("check-dist: ok (" + pages.length + " pages, " + files.length + " files)");
