/* ==========================================================================
   slugs — the one definition of an item's address, for the build side.

   An item lives at emjive.eu/<slug>, flat at the root (no series in the path:
   every page references css/, js/, assets/ and data/ relatively, which only
   resolves from a root-level URL). The slug is the product's name, made
   URL-safe: "Furcula" -> "furcula", "Rib cage" -> "rib-cage".

   js/series.js carries the same rule as `productSlug()` for the browser (the
   classic scripts can't require anything). `npm run validate-data` runs both
   over every product name and fails if they ever disagree — change them
   together.

   Used by: vite.config.js (per-item pages, sitemap, dev/preview routing) and
   scripts/validate-data.js (uniqueness / reserved-name checks).
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Addresses that already mean something, so no item may take them: the pages'
// own routes, plus anything that sits at the top level of the built site (a
// folder or file — /assets, /js, /sitemap.xml ... — computed from the repo, so
// a new top-level folder is covered without touching this list).
const PAGE_ROUTES = [
  "gallery", "archives", "creation-process", "series", "terms", "launch-order",
  "product", "index", "404"
];

function reservedNames(root) {
  const names = new Set(PAGE_ROUTES);
  for (const dir of [root, path.join(root, "public")]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      names.add(entry.toLowerCase());
      names.add(entry.replace(/\.[^.]+$/, "").toLowerCase());
    }
  }
  return names;
}

module.exports = { slugify, reservedNames, PAGE_ROUTES };
