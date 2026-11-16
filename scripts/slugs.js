// An item's URL slug (emjive.eu/<slug>), for the build side.
// Mirrors productSlug() in js/series.js; validate-data checks they agree.

const fs = require("node:fs");
const path = require("node:path");

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Names no item may take: the page routes plus every top-level entry of the built site.
const PAGE_ROUTES = [
  "gallery", "archives", "who-are-we", "intent", "3d-printing", "environment", "series", "terms", "legal-notice", "privacy", "launch-order",
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
