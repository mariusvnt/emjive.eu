// Shared helpers for the Node tooling (scripts/ and vite.config.js): the repo's
// paths and constants, file and argument plumbing, catalog lookups and drift
// checks, the glTF reader, and the dev tools' loopback server. Kept here
// instead of copied into each script.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

/* ---- paths and constants ---- */

const ROOT = path.resolve(__dirname, "..");
const SERIES_JSON_PATH = path.join(ROOT, "data", "series.json");

// The host of every page's og:url and canonical.
const SITE_ORIGIN = "https://emjive.eu";

// The smartphone query for responsive images; must match js/loader.js,
// css/style.css and series/<slug>/hero.css (validate-data checks).
const PHONE_QUERY = "(max-width: 640px) and (max-aspect-ratio: 3/5)";

// The size, in mm, models are drawn at and their geometry measured from; must
// match js/helpers.js (validate-data checks).
const REFERENCE_SIZE_MM = 62;

// The share of the change in a ring's outside width its length along the
// finger follows when sized (scripts/ring-size.js); must match js/helpers.js
// (validate-data checks) and the toolbox's sizer.
const AXIAL_STRETCH_SHARE = 0.5;

// The sizes a model is measured over: every "size-range" lies within
// (validate-data checks).
const SIZE_SPAN_MM = { min: 40, max: 80 };
// The sizes a model's axis-aligned box is measured at: the span's ends and
// the reference (js/helpers.js interpolates between them).
const MEASURED_SIZES_MM = [SIZE_SPAN_MM.min, REFERENCE_SIZE_MM, SIZE_SPAN_MM.max];

/* ---- files ---- */

// A repo-relative path, or an absolute one.
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, file), "utf8"));
}

// Repo-relative with forward slashes, for messages and data paths.
function repoPath(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

// Every file under dir, recursively.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(2) + " MB";
}

/* ---- arguments and reports ---- */

// The value of --name=value among args, or undefined.
function argValue(args, name) {
  return (args.find((a) => a.startsWith("--" + name + "=")) || "").split("=")[1];
}

// Prints the problems and exits 1 if there are any.
function exitOnProblems(tool, problems) {
  if (!problems.length) return;
  console.error(tool + ": " + problems.length + " problem" + (problems.length === 1 ? "" : "s") + "\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

/* ---- catalog ---- */

function findSeriesEntry(seriesIndex, seriesSlug) {
  return (seriesIndex.series || []).find((s) => s.slug === seriesSlug) || null;
}

// A product name as a folder name (not the URL slug: see scripts/slugs.js).
function folderSlug(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, "-");
}

// A product's asset folder, from its name and category (the <name>_<category>
// convention), not from wherever its files sit.
function productFolder(seriesSlug, name, category) {
  return "assets/series/" + seriesSlug + "/products/" + folderSlug(name) + "_" + category;
}

// A measured "geometry" (or its "print") volume at a size, cm3, as
// js/helpers.js volumeAt() computes it.
function volumeAt(geometry, mm) {
  const d = mm - REFERENCE_SIZE_MM;
  return geometry["volume-cm3"] + (geometry["volume-cm3-per-size-mm"] || 0) * d + (geometry["volume-cm3-per-size-mm2"] || 0) * d * d;
}

// The same for the surface area, cm2, as js/helpers.js areaAt() computes it.
function areaAt(geometry, mm) {
  if (!geometry || !(geometry["area-cm2"] > 0)) return null;
  const d = mm - REFERENCE_SIZE_MM;
  return geometry["area-cm2"] + (geometry["area-cm2-per-size-mm"] || 0) * d + (geometry["area-cm2-per-size-mm2"] || 0) * d * d;
}

// One piece's production cost in euros, from a "production-costs" entry, as
// js/helpers.js productionCost() computes it.
function productionCost(rates, volumeCm3, areaCm2) {
  if (!rates || !(volumeCm3 > 0) || !(areaCm2 >= 0)) return null;
  if (rates["max-volume-cm3"] !== undefined && volumeCm3 > rates["max-volume-cm3"]) return null;
  const cost = Math.max(rates.minimum, rates.base + rates["per-cm2"] * areaCm2 + rates["per-cm3"] * volumeCm3) + rates["after-minimum"];
  return Math.round((cost + Number.EPSILON) * 100) / 100;
}

// The selling price rounded up to whole euros, 0 when unknown, as js/helpers.js
// salePrice() computes it from the series index.
function salePrice(index, geometry, metal, mm) {
  const printed = geometry && (geometry.print || geometry);
  const pricing = index && index.pricing;
  if (!printed || !pricing) return 0;
  const cost = productionCost((index["production-costs"] || {})[metal], volumeAt(printed, mm), areaAt(printed, mm));
  return cost === null ? 0 : Math.ceil(cost * (1 + pricing.margin) * (1 + pricing.vat) - 1e-9);
}

// Every design's geometry of a product, as js/helpers.js designGeometries() lists them.
function designGeometries(product) {
  const list = (product.designs && product.designs.list) || [];
  return [product.geometry, ...list.map((d) => d.geometry)].filter(Boolean);
}

// A product's lowest and highest price over every metal, design and size of
// its "size-range", in whole euros, as js/selection.js priceSpan() computes
// them; null when nothing is priced (TBD).
function priceSpan(product, index) {
  const range = product["size-range"];
  let low = Infinity;
  let high = 0;
  for (const metal of index.metals || []) {
    for (const geometry of designGeometries(product)) {
      const from = salePrice(index, geometry, metal, range.min);
      if (!(from > 0)) continue;
      low = Math.min(low, from);
      high = Math.max(high, salePrice(index, geometry, metal, range.max));
    }
  }
  return high > 0 ? { low, high } : null;
}

function isSwatchCamera(camera) {
  return !!camera && typeof camera === "object" &&
    ["rotation", "tilt", "roll"].every((k) => typeof camera[k] === "number" && isFinite(camera[k])) &&
    (camera.frame === undefined || (typeof camera.frame === "number" && camera.frame > 0 && camera.frame <= 1));
}

// Catalog drift that fails silently on the site, as messages: a series
// category outside the global vocabulary gives a dead filter button, a
// product outside its series' categories vanishes under any filter, an
// unknown HDRI or a malformed swatch field falls back to a default.
// productsBySlug: series slug -> parsed products.json, for the series to check products of.
function catalogDrift(seriesIndex, productsBySlug) {
  const warnings = [];
  const categories = Object.keys(seriesIndex.categories || {});
  const hdris = Object.keys(seriesIndex.hdris || {});
  for (const entry of seriesIndex.series || []) {
    for (const cat of entry.categories || []) {
      if (!categories.includes(cat)) {
        warnings.push('series "' + entry.slug + '" declares category "' + cat + '" which isn\'t in data/series.json\'s top-level "categories"');
      }
    }
    const data = productsBySlug[entry.slug];
    for (const product of (data && data.products) || []) {
      if (!(entry.categories || []).includes(product.category)) {
        warnings.push("[" + entry.slug + "] " + product.name + ' is category "' + product.category + "\", which that series doesn't declare — it won't be reachable by any filter");
      }
    }
    if (!entry.hdri || !hdris.includes(entry.hdri)) {
      warnings.push('series "' + entry.slug + '" declares hdri "' + entry.hdri + '" which isn\'t in data/series.json\'s top-level "hdris"');
    }
  }
  const swatchHdri = seriesIndex["swatch-hdri"];
  if (swatchHdri && !hdris.includes(swatchHdri)) {
    warnings.push('top-level "swatch-hdri" is "' + swatchHdri + '" which isn\'t in data/series.json\'s top-level "hdris"');
  }
  const blur = seriesIndex["swatch-blur"];
  if (blur !== undefined && !(typeof blur === "number" && isFinite(blur) && blur >= 0)) {
    warnings.push('top-level "swatch-blur" is ' + JSON.stringify(blur) + ", not a number of pixels (0 or more) - the swatch will render with no blur");
  }
  const camera = seriesIndex["swatch-camera"];
  if (camera !== undefined && !isSwatchCamera(camera)) {
    warnings.push('top-level "swatch-camera" is ' + JSON.stringify(camera) + ", not { rotation, tilt, roll } of numbers with an optional frame in (0, 1] - the swatch will render with the default camera");
  }
  return warnings;
}

/* ---- models ---- */

// A glTF reader/writer with every extension and the Draco decoder, plus the
// encoder for { encoder: true }. ESM-only packages, so loaded on demand.
async function gltfIO(options) {
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const draco3d = (await import("draco3dgltf")).default;
  const dependencies = { "draco3d.decoder": await draco3d.createDecoderModule() };
  if (options && options.encoder) dependencies["draco3d.encoder"] = await draco3d.createEncoderModule();
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies(dependencies);
}

/* ---- dev servers ---- */

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".css": "text/css"
};

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// A repo file, never one outside ROOT; `index` stands for "/".
function serveStatic(req, res, index) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" && index) urlPath = "/" + index;
  const filePath = path.join(ROOT, urlPath);
  const normalizedFile = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
  const normalizedRoot = path.resolve(ROOT).replace(/\\/g, "/").toLowerCase();
  if (!normalizedFile.startsWith(normalizedRoot)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found: " + urlPath);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

// These servers write and delete repo files: loopback only, Host must be a
// loopback name (DNS rebinding), and non-GET requests must come from this
// origin (cross-site writes).
const LOOPBACK = "127.0.0.1";
function isLocalRequest(req, port) {
  const host = String(req.headers.host || "");
  const allowed = ["localhost:" + port, LOOPBACK + ":" + port];
  if (!allowed.includes(host)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  return !origin || allowed.some((h) => origin === "http://" + h);
}

// A dev tool's server: routes ({ "POST /api/x": async (req, res) => ... }),
// else the repo's files, with `page` at "/".
function startToolServer({ name, port, page, routes }) {
  const server = http.createServer((req, res) => {
    if (!isLocalRequest(req, port)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const handler = routes[req.method + " " + req.url.split("?")[0]];
    if (handler) {
      handler(req, res).catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: String((err && err.message) || err) });
      });
      return;
    }
    serveStatic(req, res, page);
  });
  server.listen(port, LOOPBACK, () => {
    console.log(name + " — http://" + LOOPBACK + ":" + port + "/" + page);
  });
  return server;
}

module.exports = {
  ROOT,
  SERIES_JSON_PATH,
  SITE_ORIGIN,
  PHONE_QUERY,
  REFERENCE_SIZE_MM,
  AXIAL_STRETCH_SHARE,
  SIZE_SPAN_MM,
  MEASURED_SIZES_MM,
  readJson,
  repoPath,
  walk,
  mb,
  argValue,
  exitOnProblems,
  findSeriesEntry,
  folderSlug,
  productFolder,
  volumeAt,
  areaAt,
  productionCost,
  salePrice,
  priceSpan,
  isSwatchCamera,
  catalogDrift,
  gltfIO,
  readJsonBody,
  sendJson,
  serveStatic,
  startToolServer
};
