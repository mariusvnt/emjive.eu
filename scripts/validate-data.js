#!/usr/bin/env node
/* ==========================================================================
   validate-data — checks data/series.json and every series' products.json
   and manifest.json against the schema in dev-guidelines/data.md, then checks
   the things a schema can't: that every path they (and each series' hero
   fragment) point at exists, spelled with EXACTLY the case on disk.

   The case check is the one that matters for hosting. Development is on
   Windows/macOS, where assets/foo.WEBP and assets/foo.webp are the same file;
   the OVH server is Linux, where they are not — a path that works on the dev
   machine and 404s in production is exactly the bug this exists to catch.

   Run:  npm run validate-data      (also the first step of `npm run verify`)
   Exits 1 with a list of every problem found, not just the first.
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");

const ROOT = path.resolve(__dirname, "..");
const problems = [];

function fail(where, message) {
  problems.push(where + ": " + message);
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  } catch (err) {
    fail(rel, "cannot be read as JSON (" + err.message + ")");
    return null;
  }
}

// fs.existsSync is case-insensitive on Windows and macOS, so check each path
// segment against the directory's real listing instead.
function existsExactCase(rel) {
  let dir = ROOT;
  for (const part of rel.split("/")) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

function checkPath(where, rel) {
  if (typeof rel !== "string" || rel === "") return;
  if (rel.startsWith("/") || /^[a-z]+:/i.test(rel)) {
    fail(where, "path must be repo-root-relative with no leading slash or scheme: " + rel);
    return;
  }
  if (!existsExactCase(rel)) fail(where, "file not found (case-sensitive): " + rel);
}

/* ---- schemas ----------------------------------------------------------- */

const str = { type: "string" };
const num = { type: "number" };
const strMap = { type: "object", additionalProperties: str };

const indexSchema = {
  type: "object",
  required: ["featured", "metals", "categories", "hdris", "series"],
  properties: {
    featured: str,
    metals: { type: "array", items: str, minItems: 1, uniqueItems: true },
    categories: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["sizes", "unit"],
        properties: { sizes: { type: "array", items: str }, unit: str }
      }
    },
    hdris: strMap,
    "swatch-hdri": str,
    "swatch-rotation": num,
    series: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["slug", "name", "year", "categories", "products", "hdri", "manifest"],
        properties: {
          slug: { type: "string", pattern: "^[a-z0-9-]+$" },
          name: str,
          year: str,
          categories: { type: "array", items: str },
          products: str,
          hdri: str,
          manifest: str,
          hero: {
            type: "object",
            required: ["fragment"],
            properties: {
              fragment: str,
              css: str,
              js: str,
              preload: { type: "array", items: str }
            }
          }
        }
      }
    }
  }
};

const metalMap = { type: "object", additionalProperties: str };

const productSchema = {
  type: "object",
  required: ["id", "name", "category", "description", "default-metal", "per-metal-specs", "assets"],
  properties: {
    id: str,
    name: { type: "string", minLength: 1 },
    category: str,
    description: str,
    "default-metal": str,
    "per-metal-specs": {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["price", "weight", "composition"],
        properties: { price: { type: "number", minimum: 0 }, weight: str, composition: str }
      }
    },
    "hero-hand-visibility": {
      type: "object",
      required: ["visible", "x", "y", "scale", "rotation"],
      properties: { visible: { type: "boolean" }, x: num, y: num, scale: num, rotation: num }
    },
    "3d-viewer-camera-default": {
      type: "object",
      required: ["rotation", "tilt", "zoom"],
      properties: { rotation: num, tilt: num, zoom: num, roll: num }
    },
    assets: {
      type: "object",
      required: ["model", "icons", "fallback-img", "xray", "top-shot", "photos"],
      properties: {
        model: str,
        icons: metalMap,
        "fallback-img": metalMap,
        xray: str,
        "top-shot": metalMap,
        photos: {
          type: "array",
          items: { type: "object", required: ["src", "description"], properties: { src: str, description: str } }
        }
      }
    }
  }
};

const productsFileSchema = {
  type: "object",
  required: ["series", "products"],
  properties: { series: str, products: { type: "array", items: productSchema } }
};

const manifestSchema = {
  type: "object",
  required: ["series", "title", "year", "sections", "credits"],
  properties: {
    series: str,
    title: str,
    subtitle: str,
    year: str,
    intro: str,
    sections: { type: "array" },
    credits: { type: "array" }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });

function validate(where, schema, data) {
  const check = ajv.compile(schema);
  if (check(data)) return true;
  for (const err of check.errors) {
    fail(where, (err.instancePath || "/") + " " + err.message + (err.params && err.params.additionalProperty ? " (" + err.params.additionalProperty + ")" : ""));
  }
  return false;
}

/* ---- run --------------------------------------------------------------- */

const index = readJson("data/series.json");
if (index && validate("data/series.json", indexSchema, index)) {
  const metals = new Set(index.metals);
  const hdriKeys = new Set(Object.keys(index.hdris));
  const slugs = index.series.map((s) => s.slug);

  if (!slugs.includes(index.featured)) fail("data/series.json", 'featured "' + index.featured + '" is not a series slug');
  if (new Set(slugs).size !== slugs.length) fail("data/series.json", "duplicate series slug");
  if (index["swatch-hdri"] && !hdriKeys.has(index["swatch-hdri"])) fail("data/series.json", 'swatch-hdri "' + index["swatch-hdri"] + '" is not a key of hdris');
  for (const [key, rel] of Object.entries(index.hdris)) checkPath("data/series.json hdris." + key, rel);

  for (const series of index.series) {
    const where = "series " + series.slug;
    if (!hdriKeys.has(series.hdri)) fail(where, 'hdri "' + series.hdri + '" is not a key of hdris');
    for (const cat of series.categories) {
      if (!index.categories[cat]) fail(where, 'category "' + cat + '" is not in the global categories');
    }

    checkPath(where + " products", series.products);
    checkPath(where + " manifest", series.manifest);
    if (series.hero) {
      for (const key of ["fragment", "css", "js"]) checkPath(where + " hero." + key, series.hero[key]);
      for (const rel of series.hero.preload || []) checkPath(where + " hero.preload", rel);
      // The fragment's own <img src>s resolve against the page, so they are
      // repo-root-relative like everything else in data/.
      if (series.hero.fragment && existsExactCase(series.hero.fragment)) {
        const html = fs.readFileSync(path.join(ROOT, series.hero.fragment), "utf8");
        for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) checkPath(where + " " + series.hero.fragment, match[1]);
      }
    }

    const productsFile = readJson(series.products);
    if (productsFile && validate(series.products, productsFileSchema, productsFile)) {
      if (productsFile.series !== series.slug) fail(series.products, 'series field "' + productsFile.series + '" does not match slug "' + series.slug + '"');
      const ids = new Set();
      for (const product of productsFile.products) {
        const label = series.products + " product " + product.id + " (" + product.name + ")";
        if (ids.has(product.id)) fail(label, "duplicate id within the series");
        ids.add(product.id);
        if (!series.categories.includes(product.category)) fail(label, 'category "' + product.category + '" is not declared by its series');
        if (!metals.has(product["default-metal"])) fail(label, 'default-metal "' + product["default-metal"] + '" is not in metals');

        // Every metal needs a spec (the picker reads each) and an icon and
        // fallback image (the picker swaps them live).
        for (const metal of metals) {
          if (!product["per-metal-specs"][metal]) fail(label, 'per-metal-specs has no "' + metal + '"');
          if (product.assets.model || Object.keys(product.assets.icons).length) {
            if (!product.assets.icons[metal]) fail(label, 'assets.icons has no "' + metal + '"');
          }
        }
        for (const field of ["per-metal-specs"]) {
          for (const key of Object.keys(product[field])) if (!metals.has(key)) fail(label, field + ' has unknown metal "' + key + '"');
        }
        for (const field of ["icons", "fallback-img", "top-shot"]) {
          for (const [metal, rel] of Object.entries(product.assets[field])) {
            if (!metals.has(metal)) fail(label, "assets." + field + ' has unknown metal "' + metal + '"');
            checkPath(label + " assets." + field + "." + metal, rel);
          }
        }
        checkPath(label + " assets.model", product.assets.model);
        checkPath(label + " assets.xray", product.assets.xray);
        product.assets.photos.forEach((photo, i) => checkPath(label + " assets.photos[" + i + "]", photo.src));
      }
    }

    const manifest = readJson(series.manifest);
    if (manifest && validate(series.manifest, manifestSchema, manifest)) {
      if (manifest.series !== series.slug) fail(series.manifest, 'series field "' + manifest.series + '" does not match slug "' + series.slug + '"');
    }
  }
}

if (problems.length) {
  console.error("validate-data: " + problems.length + " problem" + (problems.length === 1 ? "" : "s") + "\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("validate-data: ok");
