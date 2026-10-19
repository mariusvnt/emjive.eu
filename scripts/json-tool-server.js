#!/usr/bin/env node
// Dev server for json-tool.html (npm run json-tool): edits data/series.json's
// globals, series and products, and files dropped hand-owned assets (model,
// x-ray, photos) into the right folders. Text surgery lives in
// scripts/json-tool-blocks.js.
//
// Never: runs auto-render; writes the auto-render-owned maps (icons,
// fallback-img, wheel-poster, hand-poster); touches js/three-viewer.js or
// css/style.css for metals; edits "geometry" (measure-models.js's); writes
// the swatch scene (scene-tool's).

"use strict";

const fs = require("fs");
const path = require("path");
const blocks = require("./json-tool-blocks");
const {
  ROOT, SERIES_JSON_PATH, readJson, repoPath, findSeriesEntry, folderSlug, productFolder, catalogDrift,
  readJsonBody, sendJson, startToolServer
} = require("./helpers");

const PORT = 5201;

const MODEL_EXTS = [".glb", ".gltf"];
const IMAGE_EXTS = [".png", ".webp", ".jpg", ".jpeg"];

// ---- helpers ----

// Base64 inflates ~33%: room for a model plus a batch of photos.
const MAX_BODY_BYTES = 60 * 1024 * 1024;

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

function extOf(filename) {
  return path.extname(String(filename || "")).toLowerCase();
}

// Guards recursive deletes: slugs and categories come from hand-editable JSON,
// so "/" or ".." could otherwise escape ROOT.
function isSafeSlugSegment(s) {
  return typeof s === "string" && /^[a-z0-9-]+$/.test(s);
}

// Every series' parsed products.json, keyed by series slug.
function loadAllProductsData(seriesIndex) {
  const bySlug = {};
  for (const s of seriesIndex.series || []) {
    const absPath = path.join(ROOT, s.products);
    bySlug[s.slug] = { absPath, data: readJson(absPath) };
  }
  return bySlug;
}

// Next id within one series (ids restart per series), keeping the existing zero-padding.
function nextProductId(productsData) {
  const ids = (productsData.products || []).map((p) => String(p.id));
  const numeric = ids.map((id) => parseInt(id, 10)).filter((n) => Number.isFinite(n));
  const max = numeric.length ? Math.max.apply(null, numeric) : 0;
  const width = ids.reduce((w, id) => Math.max(w, id.length), 2);
  return String(max + 1).padStart(width, "0");
}

// ---- asset path safety ----
// Every write/delete must match one of these shapes and never an
// auto-render-owned filename.

const PRODUCT_ASSET_PATH_RE = /^assets\/series\/[a-z0-9-]+\/products\/[a-z0-9-]+_[a-z0-9-]+\/[^/]+$/;
// A product folder, checked before a recursive delete.
const PRODUCT_ASSET_FOLDER_RE = /^assets\/series\/[a-z0-9-]+\/products\/[a-z0-9-]+_[a-z0-9-]+$/;
const HDRI_ASSET_PATH_RE = /^assets\/hdri\/[^/]+\.hdr$/i;
const AUTO_RENDER_OWNED_RE = /_(icon|fallback-img|wheel-poster|hand-poster)[_.]/;

function isAllowedAssetDestPath(destPath) {
  if (typeof destPath !== "string" || !destPath) return false;
  if (destPath.includes("..") || destPath.startsWith("/") || /^[a-zA-Z]:/.test(destPath)) return false;
  const normalized = toPosix(destPath);
  if (AUTO_RENDER_OWNED_RE.test(path.basename(normalized))) return false;
  return PRODUCT_ASSET_PATH_RE.test(normalized) || HDRI_ASSET_PATH_RE.test(normalized);
}

function writeBase64File(destPath, contentBase64) {
  if (!isAllowedAssetDestPath(destPath)) throw new Error("destPath not allowed: " + destPath);
  const absPath = path.join(ROOT, destPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from(String(contentBase64 || ""), "base64"));
}

function moveAssetFile(oldRel, newRel, moved, warnings) {
  const oldAbs = path.join(ROOT, oldRel);
  const newAbs = path.join(ROOT, newRel);
  if (!fs.existsSync(oldAbs)) {
    warnings.push("expected file missing, could not move: " + oldRel);
    return;
  }
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  try {
    fs.renameSync(oldAbs, newAbs);
    moved.push({ from: oldRel, to: newRel });
  } catch (err) {
    warnings.push("failed to move " + oldRel + " to " + newRel + ": " + err.message);
  }
}

// ---- GET /api/data: the series index, every series' products and manifest
// with its next product id, and drift warnings ----

async function handleGetData(req, res) {
  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesData = {};
  const productsBySlug = {};
  for (const s of seriesIndex.series || []) {
    const productsData = readJson(s.products);
    const manifestData = fs.existsSync(path.join(ROOT, s.manifest)) ? readJson(s.manifest) : null;
    seriesData[s.slug] = { products: productsData, manifest: manifestData, nextProductId: nextProductId(productsData) };
    productsBySlug[s.slug] = productsData;
  }
  const driftWarnings = catalogDrift(seriesIndex, productsBySlug);
  sendJson(res, 200, { seriesIndex, seriesData, driftWarnings });
}

// ---- global parameters ----

async function handleGlobalFeatured(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (body.featured === undefined) return sendJson(res, 400, { error: "featured is required" });

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  if (!findSeriesEntry(seriesIndex, body.featured)) return sendJson(res, 400, { error: "unknown series: " + body.featured });

  const patched = blocks.updateTopLevelScalarInText(text, "featured", '"' + blocks.esc(body.featured) + '"');
  if (!patched) return sendJson(res, 404, { error: 'could not find "featured" in data/series.json' });

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  sendJson(res, 200, { ok: true });
}

// Series declaring the category and products using it; removal is blocked while any exist.
function findCategoryUsages(seriesIndex, key) {
  const usages = [];
  const productsBySlug = loadAllProductsData(seriesIndex);
  for (const s of seriesIndex.series || []) {
    if ((s.categories || []).includes(key)) usages.push('series "' + s.slug + '" declares it');
    const pd = productsBySlug[s.slug];
    for (const p of (pd && pd.data.products) || []) {
      if (p.category === key) usages.push('[' + s.slug + '] ' + p.name + " uses it");
    }
  }
  return usages;
}

async function handleGlobalCategory(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const key = String(body.key || "").trim();
  if (!key) return sendJson(res, 400, { error: "key is required" });

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  const exists = Object.prototype.hasOwnProperty.call(seriesIndex.categories || {}, key);

  if (body.mode === "remove") {
    if (!exists) return sendJson(res, 404, { error: "unknown category: " + key });
    const usages = findCategoryUsages(seriesIndex, key);
    if (usages.length) {
      return sendJson(res, 409, { error: 'category "' + key + '" is still in use — ' + usages.join("; ") + " — update those first" });
    }
    const patched = blocks.removeObjectEntryInText(text, '"categories": {', key);
    if (!patched) return sendJson(res, 500, { error: 'could not patch "categories" in data/series.json' });
    fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
    return sendJson(res, 200, { ok: true });
  }

  const sizes = Array.isArray(body.sizes) ? body.sizes : [];
  const unit = body.unit || "";
  const valueText = '{ "sizes": [' + sizes.map((s) => '"' + blocks.esc(s) + '"').join(", ") + '], "unit": "' + blocks.esc(unit) + '" }';

  let patched;
  if (body.mode === "edit") {
    if (!exists) return sendJson(res, 404, { error: "unknown category: " + key });
    patched = blocks.updateObjectEntryInText(text, '"categories": {', key, valueText);
  } else {
    if (exists) return sendJson(res, 409, { error: "category already exists: " + key });
    patched = blocks.insertBeforeObjectClose(text, '"categories": {', '    "' + key + '": ' + valueText);
  }
  if (!patched) return sendJson(res, 500, { error: 'could not patch "categories" in data/series.json' });
  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  sendJson(res, 200, { ok: true });
}

function findHdriUsages(seriesIndex, key) {
  const usages = [];
  for (const s of seriesIndex.series || []) {
    if (s.hdri === key) usages.push('series "' + s.slug + '" uses it');
  }
  return usages;
}

async function handleGlobalHdri(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const key = String(body.key || "").trim();

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  const exists = Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, key);

  if (body.mode === "remove") {
    if (!exists) return sendJson(res, 404, { error: "unknown hdri: " + key });
    const usages = findHdriUsages(seriesIndex, key);
    if (usages.length) {
      return sendJson(res, 409, { error: 'hdri "' + key + '" is still in use — ' + usages.join("; ") + " — update those first" });
    }
    const hdriPath = seriesIndex.hdris[key];
    const patched = blocks.removeObjectEntryInText(text, '"hdris": {', key);
    if (!patched) return sendJson(res, 500, { error: 'could not patch "hdris" in data/series.json' });
    fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
    if (hdriPath && HDRI_ASSET_PATH_RE.test(hdriPath)) {
      const absPath = path.join(ROOT, hdriPath);
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    }
    return sendJson(res, 200, { ok: true });
  }

  const hdriPath = body.path;
  if (!key || !hdriPath) return sendJson(res, 400, { error: "key and path are required" });
  if (!HDRI_ASSET_PATH_RE.test(hdriPath)) return sendJson(res, 400, { error: "path must look like assets/hdri/<file>.hdr" });

  let patched;
  if (body.mode === "edit") {
    if (!exists) return sendJson(res, 404, { error: "unknown hdri: " + key });
    patched = blocks.updateObjectEntryInText(text, '"hdris": {', key, '"' + blocks.esc(hdriPath) + '"');
  } else {
    if (exists) return sendJson(res, 409, { error: "hdri key already exists: " + key });
    patched = blocks.insertBeforeObjectClose(text, '"hdris": {', '    "' + key + '": "' + blocks.esc(hdriPath) + '"');
  }
  if (!patched) return sendJson(res, 500, { error: 'could not patch "hdris" in data/series.json' });
  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  sendJson(res, 200, { ok: true });
}

async function handleGlobalMetal(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const metal = String(body.metal || "").trim();
  if (!metal || !/^[a-z0-9-]+$/.test(metal)) return sendJson(res, 400, { error: "metal must be a lowercase kebab-case name" });

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  const exists = (seriesIndex.metals || []).includes(metal);

  if (body.mode === "remove") {
    if (!exists) return sendJson(res, 404, { error: "unknown metal: " + metal });
    const newMetals = (seriesIndex.metals || []).filter((m) => m !== metal);
    if (!newMetals.length) return sendJson(res, 409, { error: "cannot remove the last remaining metal" });

    const productsBySlug = loadAllProductsData(seriesIndex);
    const usedAsDefault = [];
    for (const s of seriesIndex.series || []) {
      for (const p of (productsBySlug[s.slug] && productsBySlug[s.slug].data.products) || []) {
        if (p["default-metal"] === metal) usedAsDefault.push("[" + s.slug + "] " + p.name);
      }
    }
    if (usedAsDefault.length) {
      return sendJson(res, 409, {
        error: 'metal "' + metal + '" is the default metal for: ' + usedAsDefault.join(", ") + " — change their default metal first"
      });
    }

    let patched = blocks.removeFromInlineStringArray(text, '"metals": [', metal);
    if (!patched) return sendJson(res, 500, { error: 'could not patch "metals" in data/series.json' });
    // validate-data rejects entries for metals not in the list.
    patched = blocks.removeObjectEntryInText(patched, '"metal-costs": {', metal) || patched;
    patched = blocks.removeObjectEntryInText(patched, '"metal-composition": {', metal) || patched;
    patched = blocks.removeObjectEntryInText(patched, '"metal-shaders": {', metal) || patched;
    fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");

    // Re-render every product block against the new metals list, which drops the
    // removed metal's keys everywhere.
    for (const s of seriesIndex.series || []) {
      const entry = productsBySlug[s.slug];
      let pText = fs.readFileSync(entry.absPath, "utf8");
      let changed = false;
      for (const p of entry.data.products || []) {
        const blockText = blocks.renderProductBlock(p, newMetals);
        const next = blocks.replaceProductBlockInText(pText, p.id, blockText);
        if (next) {
          pText = next;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(entry.absPath, pText, "utf8");
    }

    return sendJson(res, 200, {
      ok: true,
      reminder:
        'Removed "' + metal + '" from data/series.json\'s metals list and from every product\'s per-metal-specs/icons/' +
        "fallback-img/wheel-poster, and its metal-costs, metal-composition and metal-shaders entries. Still worth doing " +
        "by hand if you want a full cleanup (harmless if left, just dead code): remove the " +
        '.product-metals__option[data-metal="' + metal + '"] rule from css/style.css.'
    });
  }

  if (exists) return sendJson(res, 409, { error: "metal already exists: " + metal });

  let patched = blocks.appendToInlineStringArray(text, '"metals": [', metal);
  if (!patched) return sendJson(res, 500, { error: 'could not patch "metals" in data/series.json' });
  // A neutral starting shader, tuned afterwards in scene-tool.
  patched = blocks.insertBeforeObjectClose(patched, '"metal-shaders": {',
    '    "' + metal + '": { "color": [128, 128, 128], "metalness": 1, "roughness": 0.2 }') || patched;
  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");

  sendJson(res, 200, {
    ok: true,
    reminder:
      'Added "' + metal + '" to data/series.json\'s metals list, with a neutral grey under "metal-shaders" to tune in ' +
      'scene-tool. Still needed by hand: a .product-metals__option[data-metal="' + metal + '"] rule in css/style.css ' +
      "— this tool does not touch it — plus a \"" + metal + '" entry under data/series.json\'s "metal-costs" ' +
      "(density, price per gram, production cost per cm3; `npm run validate-data` fails without it), a \"" + metal +
      '" entry under "metal-composition" and one under "metal-technology". ' +
      "Existing products won't have a \"" + metal +
      '" entry under per-metal-specs until you re-save them here, either.'
  });
}

// ---- series ----

async function handleSeriesEdit(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const fields = body.fields || {};
  if (!seriesSlug) return sendJson(res, 400, { error: "seriesSlug is required" });
  if (fields.slug !== undefined) {
    return sendJson(res, 400, { error: "slug cannot be changed here — it would require moving every asset path in this series" });
  }

  let text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  if (!findSeriesEntry(seriesIndex, seriesSlug)) return sendJson(res, 404, { error: "unknown series: " + seriesSlug });

  const patches = [];
  if (fields.name !== undefined) patches.push(["name", '"' + blocks.esc(fields.name) + '"']);
  if (fields.year !== undefined) patches.push(["year", '"' + blocks.esc(fields.year) + '"']);
  if (fields.hdri !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, fields.hdri)) {
      return sendJson(res, 400, { error: "unknown hdri: " + fields.hdri });
    }
    patches.push(["hdri", '"' + blocks.esc(fields.hdri) + '"']);
  }
  if (fields.categories !== undefined) {
    const arr = Array.isArray(fields.categories) ? fields.categories : [];
    patches.push(["categories", "[" + arr.map((c) => '"' + blocks.esc(c) + '"').join(", ") + "]"]);
  }

  for (const [fieldName, valueText] of patches) {
    const patched = blocks.updateSeriesFieldInText(text, seriesSlug, fieldName, valueText);
    if (!patched) return sendJson(res, 500, { error: 'could not find "' + fieldName + '" on series "' + seriesSlug + '"' });
    text = patched;
  }

  fs.writeFileSync(SERIES_JSON_PATH, text, "utf8");
  sendJson(res, 200, { ok: true });
}

async function handleSeriesAdd(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const slugValue = String(body.slug || "").trim();
  const name = String(body.name || "").trim();
  const year = String(body.year || "").trim();
  const categories = Array.isArray(body.categories) ? body.categories : [];
  const hdri = body.hdri || "";

  if (!/^[a-z0-9-]+$/.test(slugValue)) return sendJson(res, 400, { error: "slug must be lowercase kebab-case" });
  if (!name) return sendJson(res, 400, { error: "name is required" });
  if (!year) return sendJson(res, 400, { error: "year is required" });

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  if (findSeriesEntry(seriesIndex, slugValue)) return sendJson(res, 409, { error: "series already exists: " + slugValue });
  if (hdri && !Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, hdri)) {
    return sendJson(res, 400, { error: "unknown hdri: " + hdri });
  }

  const dataDir = path.join(ROOT, "data", "series", slugValue);
  const heroDir = path.join(ROOT, "series", slugValue);
  const assetsSeriesDir = path.join(ROOT, "assets", "series", slugValue);
  if (fs.existsSync(dataDir) || fs.existsSync(heroDir) || fs.existsSync(assetsSeriesDir)) {
    return sendJson(res, 409, { error: "series folders already exist for slug: " + slugValue });
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(assetsSeriesDir, "hero"), { recursive: true });
  fs.mkdirSync(path.join(assetsSeriesDir, "products"), { recursive: true });
  fs.mkdirSync(heroDir, { recursive: true });

  const productsRelPath = "data/series/" + slugValue + "/products.json";
  const manifestRelPath = "data/series/" + slugValue + "/manifest.json";
  // New files: plain JSON.stringify is fine.
  fs.writeFileSync(path.join(ROOT, productsRelPath), JSON.stringify({ series: slugValue, products: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(ROOT, manifestRelPath),
    JSON.stringify({ series: slugValue, title: name, subtitle: "", year, intro: "", sections: [], credits: [] }, null, 2) + "\n",
    "utf8"
  );

  const created = [productsRelPath, manifestRelPath];
  const bonesHeroDir = path.join(ROOT, "series", "bones");
  ["hero.html", "hero.css", "hero.js"].forEach((f) => {
    const src = path.join(bonesHeroDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(heroDir, f));
      created.push("series/" + slugValue + "/" + f);
    }
  });

  const seriesBlockText = blocks.renderSeriesBlock({
    slug: slugValue,
    name,
    year,
    categories,
    products: productsRelPath,
    hdri,
    manifest: manifestRelPath,
    hero: {
      fragment: "series/" + slugValue + "/hero.html",
      css: "series/" + slugValue + "/hero.css",
      js: "series/" + slugValue + "/hero.js",
      preload: []
    }
  });
  const patched = blocks.insertBeforeArrayClose(text, '"series": [', seriesBlockText);
  if (!patched) return sendJson(res, 500, { error: 'could not find "series": [ in data/series.json' });
  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");

  sendJson(res, 200, {
    ok: true,
    slug: slugValue,
    created,
    reminders: [
      "hero.html/css/js were copied verbatim from series/bones/ — edit them by hand before this series is presentable.",
      "hero.preload was left empty — add real asset paths once hero art exists.",
      "This series' products array starts empty — use the Products tab to add its first product."
    ]
  });
}

// Deletes a series' data, hero bundle and assets, and its block. Refused for
// the featured or last series.
async function handleSeriesRemove(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const slugValue = body.slug;
  if (!slugValue) return sendJson(res, 400, { error: "slug is required" });
  if (!isSafeSlugSegment(slugValue)) return sendJson(res, 400, { error: "unsafe slug: " + slugValue });

  const text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  const seriesIndex = JSON.parse(text);
  const entry = findSeriesEntry(seriesIndex, slugValue);
  if (!entry) return sendJson(res, 404, { error: "unknown series: " + slugValue });
  if (seriesIndex.featured === slugValue) {
    return sendJson(res, 409, { error: 'series "' + slugValue + '" is the featured series — change Featured to another series first' });
  }
  if ((seriesIndex.series || []).length <= 1) {
    return sendJson(res, 409, { error: "cannot remove the last remaining series" });
  }

  const deleted = [];
  [
    path.join(ROOT, "data", "series", slugValue),
    path.join(ROOT, "series", slugValue),
    path.join(ROOT, "assets", "series", slugValue)
  ].forEach((dir) => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(repoPath(dir));
    }
  });

  const patched = blocks.removeSeriesBlockInText(text, slugValue);
  if (!patched) return sendJson(res, 500, { error: 'could not locate series "' + slugValue + '" in data/series.json' });
  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");

  sendJson(res, 200, { ok: true, deleted });
}

// ---- products ----

async function handleProductAdd(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const name = String(body.name || "").trim();
  const category = body.category;
  if (!seriesSlug) return sendJson(res, 400, { error: "seriesSlug is required" });
  if (!name || !category) return sendJson(res, 400, { error: "name and category are required" });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);

  const folder = productFolder(seriesSlug, name, category);
  const collision = (productsData.products || []).find((p) => productFolder(seriesSlug, p.name, p.category) === folder);
  if (collision) {
    return sendJson(res, 409, { error: 'a product already uses folder ' + folder + ' ("' + collision.name + '") — pick a different name/category' });
  }

  const assets = { model: "", icons: {}, "fallback-img": {}, "wheel-poster": {}, xray: "", "hand-poster": "", photos: [] };
  metals.forEach((m) => {
    assets.icons[m] = "";
    assets["fallback-img"][m] = "";
    assets["wheel-poster"][m] = "";
  });

  const written = [];
  try {
    if (body.modelFile && body.modelFile.filename) {
      const ext = extOf(body.modelFile.filename);
      if (!MODEL_EXTS.includes(ext)) return sendJson(res, 400, { error: "model file must be .glb or .gltf" });
      const dest = folder + "/" + folderSlug(name) + "_gltf" + ext;
      writeBase64File(dest, body.modelFile.contentBase64);
      assets.model = dest;
      written.push(dest);
    }
    if (body.xrayFile && body.xrayFile.filename) {
      const ext = extOf(body.xrayFile.filename);
      if (!IMAGE_EXTS.includes(ext)) return sendJson(res, 400, { error: "xray file must be a png/webp/jpg image" });
      const dest = folder + "/" + folderSlug(name) + "_xray" + ext;
      writeBase64File(dest, body.xrayFile.contentBase64);
      assets.xray = dest;
      written.push(dest);
    }
    const photoFiles = Array.isArray(body.photoFiles) ? body.photoFiles : [];
    photoFiles.forEach((f, i) => {
      const ext = extOf(f.filename) || ".png";
      const dest = folder + "/" + name + "_photo" + (i + 1) + ext;
      writeBase64File(dest, f.contentBase64);
      assets.photos.push({ src: dest, description: "" });
      written.push(dest);
    });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const product = {
    id: nextProductId(productsData),
    name,
    category,
    description: body.description || "",
    "default-metal": body.defaultMetal || metals[0] || "",
    "per-metal-specs": body.perMetalSpecs || {},
    "size-range": body.sizeRange || { min: 40, max: 80 },
    "hero-hand-visibility": body.heroHandVisibility || { visible: false, x: 50, y: 50, scale: 6, rotation: 0 },
    "3d-viewer-camera-default": body.cameraDefault || { rotation: 0, tilt: 75, zoom: 105 },
    assets
  };

  const blockText = blocks.renderProductBlock(product, metals);
  const patched = blocks.insertBeforeArrayClose(text, '"products": [', blockText);
  if (!patched) return sendJson(res, 500, { error: 'could not find "products": [ in ' + seriesEntry.products });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, {
    ok: true,
    id: product.id,
    folder,
    written,
    reminder:
      "Run `npm run auto-render` to generate icons/fallback-img/wheel-posters/hand-posters for this product, and " +
      "`npm run measure-models` to measure its weight, size and cost (`npm run validate-data` fails until you do)."
  });
}

async function handleProductEdit(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  if (!seriesSlug || !productId) return sendJson(res, 400, { error: "seriesSlug and productId are required" });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId + " in " + seriesEntry.products });

  const fields = body.fields || {};
  const nextName = fields.name !== undefined ? String(fields.name).trim() : current.name;
  const nextCategory = fields.category !== undefined ? fields.category : current.category;
  if (!nextName || !nextCategory) return sendJson(res, 400, { error: "name and category cannot be empty" });

  const oldFolder = productFolder(seriesSlug, current.name, current.category);
  const newFolder = productFolder(seriesSlug, nextName, nextCategory);
  const collision = (productsData.products || []).find(
    (p) => String(p.id) !== String(productId) && productFolder(seriesSlug, p.name, p.category) === newFolder
  );
  if (collision) {
    return sendJson(res, 409, { error: 'a different product already uses folder ' + newFolder + ' ("' + collision.name + '")' });
  }

  // Merge onto the on-disk product so untouched fields (the auto-render-owned
  // maps above all) survive the re-render.
  const merged = Object.assign({}, current, { name: nextName, category: nextCategory });
  if (fields.description !== undefined) merged.description = fields.description;
  if (fields.defaultMetal !== undefined) merged["default-metal"] = fields.defaultMetal;
  if (fields.perMetalSpecs !== undefined) merged["per-metal-specs"] = fields.perMetalSpecs;
  if (fields.heroHandVisibility !== undefined) merged["hero-hand-visibility"] = fields.heroHandVisibility;
  if (fields.cameraDefault !== undefined) merged["3d-viewer-camera-default"] = fields.cameraDefault;
  merged.assets = Object.assign({}, current.assets);

  const moved = [];
  const warnings = [];
  if (oldFolder !== newFolder) {
    ["model", "wireframe", "stl", "xray"].forEach((key) => {
      const oldRel = merged.assets[key];
      if (oldRel) {
        const newRel = newFolder + "/" + path.basename(oldRel);
        moveAssetFile(oldRel, newRel, moved, warnings);
        merged.assets[key] = newRel;
      }
    });
    merged.assets.photos = (merged.assets.photos || []).map((p) => {
      const newRel = newFolder + "/" + path.basename(p.src);
      moveAssetFile(p.src, newRel, moved, warnings);
      return { src: newRel, description: p.description };
    });
    // The other designs' files move too; their renders are auto-render's to redo.
    if (merged.designs) {
      merged.designs = Object.assign({}, merged.designs, {
        list: (merged.designs.list || []).map((d) => {
          const next = Object.assign({}, d);
          ["model", "wireframe", "stl"].forEach((key) => {
            if (!next[key]) return;
            const newRel = newFolder + "/" + path.basename(next[key]);
            moveAssetFile(next[key], newRel, moved, warnings);
            next[key] = newRel;
          });
          return next;
        })
      });
    }
    warnings.push(
      "folder changed from " + oldFolder + " to " + newFolder +
      " — run `npm run auto-render` to regenerate icons/fallback-img/wheel-posters/hand-posters there; stale renders were left behind in the old folder."
    );
  }

  const written = [];
  try {
    if (body.modelFile && body.modelFile.filename) {
      const ext = extOf(body.modelFile.filename);
      if (!MODEL_EXTS.includes(ext)) return sendJson(res, 400, { error: "model file must be .glb or .gltf" });
      const dest = newFolder + "/" + folderSlug(nextName) + "_gltf" + ext;
      writeBase64File(dest, body.modelFile.contentBase64);
      merged.assets.model = dest;
      written.push(dest);
      warnings.push("model replaced — run `npm run measure-models` to refresh its weight, size and cost.");
    }
    if (body.xrayFile && body.xrayFile.filename) {
      const ext = extOf(body.xrayFile.filename);
      if (!IMAGE_EXTS.includes(ext)) return sendJson(res, 400, { error: "xray file must be a png/webp/jpg image" });
      const dest = newFolder + "/" + folderSlug(nextName) + "_xray" + ext;
      writeBase64File(dest, body.xrayFile.contentBase64);
      merged.assets.xray = dest;
      written.push(dest);
    }
    const photoFiles = Array.isArray(body.photoFiles) ? body.photoFiles : [];
    let photoIndex = (merged.assets.photos || []).length;
    photoFiles.forEach((f) => {
      photoIndex += 1;
      const ext = extOf(f.filename) || ".png";
      const dest = newFolder + "/" + nextName + "_photo" + photoIndex + ext;
      writeBase64File(dest, f.contentBase64);
      merged.assets.photos.push({ src: dest, description: "" });
      written.push(dest);
    });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId + " in " + seriesEntry.products });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true, folder: newFolder, moved, written, warnings });
}

// Deletes a product's asset folder and its block.
async function handleProductRemove(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  if (!seriesSlug || !productId) return sendJson(res, 400, { error: "seriesSlug and productId are required" });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const folder = productFolder(seriesSlug, current.name, current.category);
  if (!PRODUCT_ASSET_FOLDER_RE.test(folder)) {
    return sendJson(res, 400, { error: "unsafe product folder, refusing to delete: " + folder });
  }

  const absFolder = path.join(ROOT, folder);
  let deletedFolder = false;
  if (fs.existsSync(absFolder)) {
    fs.rmSync(absFolder, { recursive: true, force: true });
    deletedFolder = true;
  }

  const patched = blocks.removeProductBlockInText(text, productId);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true, deleted: deletedFolder ? [folder] : [] });
}

async function handleProductRemovePhoto(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  const photoPath = body.photoPath;
  if (!seriesSlug || !productId || !photoPath) {
    return sendJson(res, 400, { error: "seriesSlug, productId and photoPath are required" });
  }

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const existingPhotos = (current.assets && current.assets.photos) || [];
  if (!existingPhotos.some((p) => p.src === photoPath)) return sendJson(res, 400, { error: "photo not found on this product: " + photoPath });

  const merged = Object.assign({}, current);
  merged.assets = Object.assign({}, current.assets, { photos: existingPhotos.filter((p) => p.src !== photoPath) });

  const absPath = path.join(ROOT, photoPath);
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true });
}

// A photo's caption (assets.photos[i].description), matched by src.
async function handleProductUpdatePhotoDescription(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  const photoPath = body.photoPath;
  if (!seriesSlug || !productId || !photoPath) {
    return sendJson(res, 400, { error: "seriesSlug, productId and photoPath are required" });
  }

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const photos = (current.assets && current.assets.photos) || [];
  const index = photos.findIndex((p) => p.src === photoPath);
  if (index === -1) return sendJson(res, 400, { error: "photo not found on this product: " + photoPath });

  const merged = Object.assign({}, current);
  merged.assets = Object.assign({}, current.assets);
  merged.assets.photos = photos.slice();
  merged.assets.photos[index] = { src: photoPath, description: body.description || "" };

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true });
}

// Immediate replace/remove of the saved model or x-ray (dropzones instead
// stage uploads for Save).

async function handleProductReplaceAsset(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  const assetKey = body.assetKey;
  if (!seriesSlug || !productId) return sendJson(res, 400, { error: "seriesSlug and productId are required" });
  if (assetKey !== "model" && assetKey !== "xray") return sendJson(res, 400, { error: 'assetKey must be "model" or "xray"' });
  if (!body.filename || !body.contentBase64) return sendJson(res, 400, { error: "filename and contentBase64 are required" });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const ext = extOf(body.filename);
  if (assetKey === "model" && !MODEL_EXTS.includes(ext)) return sendJson(res, 400, { error: "model file must be .glb or .gltf" });
  if (assetKey === "xray" && !IMAGE_EXTS.includes(ext)) return sendJson(res, 400, { error: "xray file must be a png/webp/jpg image" });

  const folder = productFolder(seriesSlug, current.name, current.category);
  const suffix = assetKey === "model" ? "_gltf" : "_xray";
  const dest = folder + "/" + folderSlug(current.name) + suffix + ext;

  try {
    writeBase64File(dest, body.contentBase64);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const oldRel = current.assets && current.assets[assetKey];
  if (oldRel && oldRel !== dest) {
    const oldAbs = path.join(ROOT, oldRel);
    if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
  }

  const merged = Object.assign({}, current);
  merged.assets = Object.assign({}, current.assets);
  merged.assets[assetKey] = dest;

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true, path: dest });
}

async function handleProductRemoveAsset(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  const assetKey = body.assetKey;
  if (!seriesSlug || !productId) return sendJson(res, 400, { error: "seriesSlug and productId are required" });
  if (assetKey !== "model" && assetKey !== "xray") return sendJson(res, 400, { error: 'assetKey must be "model" or "xray"' });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const oldRel = current.assets && current.assets[assetKey];
  if (oldRel) {
    const oldAbs = path.join(ROOT, oldRel);
    if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
  }

  const merged = Object.assign({}, current);
  merged.assets = Object.assign({}, current.assets);
  merged.assets[assetKey] = "";

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true });
}

// Replaces a photo at the same index, so the carousel order holds.
async function handleProductReplacePhoto(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const seriesSlug = body.seriesSlug;
  const productId = body.productId;
  const oldPhotoPath = body.oldPhotoPath;
  if (!seriesSlug || !productId || !oldPhotoPath) {
    return sendJson(res, 400, { error: "seriesSlug, productId and oldPhotoPath are required" });
  }
  if (!body.filename || !body.contentBase64) return sendJson(res, 400, { error: "filename and contentBase64 are required" });

  const seriesIndex = readJson(SERIES_JSON_PATH);
  const seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  const metals = seriesIndex.metals || [];

  const productsAbsPath = path.join(ROOT, seriesEntry.products);
  const text = fs.readFileSync(productsAbsPath, "utf8");
  const productsData = JSON.parse(text);
  const current = (productsData.products || []).find((p) => String(p.id) === String(productId));
  if (!current) return sendJson(res, 404, { error: "no product with id " + productId });

  const photos = (current.assets && current.assets.photos) || [];
  const index = photos.findIndex((p) => p.src === oldPhotoPath);
  if (index === -1) return sendJson(res, 400, { error: "photo not found on this product: " + oldPhotoPath });

  const ext = extOf(body.filename) || ".png";
  if (!IMAGE_EXTS.includes(ext)) return sendJson(res, 400, { error: "photo file must be a png/webp/jpg image" });

  const folder = productFolder(seriesSlug, current.name, current.category);
  const dest = folder + "/" + current.name + "_photo" + (index + 1) + ext;

  try {
    writeBase64File(dest, body.contentBase64);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (oldPhotoPath !== dest) {
    const oldAbs = path.join(ROOT, oldPhotoPath);
    if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
  }

  const merged = Object.assign({}, current);
  merged.assets = Object.assign({}, current.assets);
  merged.assets.photos = photos.slice();
  merged.assets.photos[index] = { src: dest, description: photos[index].description };

  const blockText = blocks.renderProductBlock(merged, metals);
  const patched = blocks.replaceProductBlockInText(text, productId, blockText);
  if (!patched) return sendJson(res, 500, { error: "could not locate product " + productId });
  fs.writeFileSync(productsAbsPath, patched, "utf8");

  sendJson(res, 200, { ok: true, path: dest });
}

// ---- file primitives ----

async function handleSaveFile(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  try {
    writeBase64File(body.destPath, body.contentBase64);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  sendJson(res, 200, { ok: true, path: body.destPath });
}

async function handleDeleteFile(req, res) {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!isAllowedAssetDestPath(body.path)) return sendJson(res, 400, { error: "path not allowed: " + body.path });
  const absPath = path.join(ROOT, body.path);
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  sendJson(res, 200, { ok: true });
}

const ROUTES = {
  "GET /api/data": handleGetData,
  "POST /api/global/featured": handleGlobalFeatured,
  "POST /api/global/category": handleGlobalCategory,
  "POST /api/global/hdri": handleGlobalHdri,
  "POST /api/global/metal": handleGlobalMetal,
  "POST /api/series/edit": handleSeriesEdit,
  "POST /api/series/add": handleSeriesAdd,
  "POST /api/series/remove": handleSeriesRemove,
  "POST /api/product/add": handleProductAdd,
  "POST /api/product/edit": handleProductEdit,
  "POST /api/product/remove": handleProductRemove,
  "POST /api/product/remove-photo": handleProductRemovePhoto,
  "POST /api/product/update-photo-description": handleProductUpdatePhotoDescription,
  "POST /api/product/replace-asset": handleProductReplaceAsset,
  "POST /api/product/remove-asset": handleProductRemoveAsset,
  "POST /api/product/replace-photo": handleProductReplacePhoto,
  "POST /api/save-file": handleSaveFile,
  "POST /api/delete-file": handleDeleteFile
};

startToolServer({ name: "json-tool", port: PORT, page: "json-tool.html", routes: ROUTES });
