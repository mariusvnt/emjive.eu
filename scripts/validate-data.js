#!/usr/bin/env node
// Validates data/series.json and every series' products.json and manifest.json
// against their schemas, then what a schema can't: every referenced path
// exists with its exact case (the Linux host is case-sensitive), image
// variants, measured geometry, designs, slugs and the shared phone constants.
// Reports every problem, exits 1 if any.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");

const { ROOT, PHONE_QUERY, exitOnProblems } = require("./helpers");

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

// The size variants of a picture (name_<suffix>.ext, see js/loader.js) must
// exist, or the page silently downloads the original.
//   ["lo", "m", "m_lo"]  four-version pictures
//   ["m"]                phone version only
//   ["128"]              icon thumbnail
function checkVariants(where, rel, suffixes) {
  if (typeof rel !== "string" || rel === "") return;
  for (const suffix of suffixes) {
    const sibling = rel.replace(/(\.[A-Za-z0-9]+)$/, "_" + suffix + "$1");
    if (!existsExactCase(sibling)) fail(where, "missing its _" + suffix + " version " + sibling + " (run `npm run image-variants`)");
  }
}

// The phone query and crops must match across scripts/ (helpers.js,
// make-image-variants.js), the CSS and js/loader.js; a mismatch only shows as
// a quietly misaligned layout.
const { PHONE_CROP } = require("./make-image-variants");
const { slugify, reservedNames } = require("./slugs");

function checkPhoneConstants(file, expectedCrops) {
  if (!existsExactCase(file)) return;
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!text.includes(PHONE_QUERY)) fail(file, "does not contain the phone query " + PHONE_QUERY + " (see PHONE_QUERY in js/loader.js)");
  for (const [name, value] of Object.entries(expectedCrops)) {
    const found = [...text.matchAll(new RegExp("--" + name + ":\\s*([0-9.]+)\\s*;", "g"))].map((m) => Number(m[1]));
    if (!found.includes(value)) fail(file, "--" + name + " is " + (found.join(" / ") || "not set") + ", but PHONE_CROP in scripts/make-image-variants.js is " + value);
  }
}

/* ---- schemas ---- */

const str = { type: "string" };
const num = { type: "number" };
const strMap = { type: "object", additionalProperties: str };

const indexSchema = {
  type: "object",
  required: ["featured", "metals", "metal-costs", "metal-technology", "metal-composition", "metal-shaders", "printing-technologies", "categories", "hdris", "series"],
  properties: {
    featured: str,
    metals: { type: "array", items: str, minItems: 1, uniqueItems: true },
    "metal-costs": {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["density-g-cm3", "price-per-g", "loss-margin", "production-per-cm3"],
        properties: {
          "density-g-cm3": { type: "number", exclusiveMinimum: 0 },
          "price-per-g": { type: "number", exclusiveMinimum: 0 },
          "loss-margin": { type: "number", minimum: 0 },
          "production-per-cm3": { type: "number", exclusiveMinimum: 0 }
        }
      }
    },
    "metal-technology": strMap,
    "metal-composition": strMap,
    // js/three-viewer.js metalMaterial(): a base colour (0-255 per channel) and two 0-1 factors.
    "metal-shaders": {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["color", "metalness", "roughness"],
        additionalProperties: false,
        properties: {
          color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 },
          metalness: { type: "number", minimum: 0, maximum: 1 },
          roughness: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    "printing-technologies": {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["name", "description"],
        properties: { name: str, description: str }
      }
    },
    categories: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["sizes", "unit"],
        properties: {
          sizes: { type: "array", items: str },
          unit: str,
          // The size guide (js/selection.js fillSizeGuide).
          "size-guide": {
            type: "object",
            required: ["how", "head", "rows"],
            properties: {
              how: { type: "array", items: str, minItems: 1 },
              head: { type: "array", items: str, minItems: 1 },
              rows: { type: "array", items: { type: "array", items: str } }
            }
          }
        }
      }
    },
    hdris: strMap,
    "swatch-hdri": str,
    "swatch-blur": num,
    "swatch-camera": {
      type: "object",
      required: ["rotation", "tilt", "roll"],
      additionalProperties: false,
      properties: { rotation: num, tilt: num, roll: num }
    },
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

// Written by `npm run measure-models`; on a product and on each non-default design.
const geometrySchema = {
  type: "object",
  required: ["volume-cm3", "dimensions-mm", "min-box", "model-sha1"],
  properties: {
    "volume-cm3": { type: "number", exclusiveMinimum: 0 },
    "dimensions-mm": { type: "array", items: { type: "number", exclusiveMinimum: 0 }, minItems: 3, maxItems: 3 },
    // The wheel's hit boxes (js/stack-scene.js).
    "min-box": {
      type: "object",
      required: ["center", "axes"],
      properties: {
        center: { type: "array", items: num, minItems: 3, maxItems: 3 },
        axes: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "array", items: num, minItems: 3, maxItems: 3 }
        }
      }
    },
    // Measured on the STL: the dimensions, weight and price shown.
    print: {
      type: "object",
      required: ["volume-cm3", "dimensions-mm", "stl-sha1"],
      properties: {
        "volume-cm3": { type: "number", exclusiveMinimum: 0 },
        "dimensions-mm": { type: "array", items: { type: "number", exclusiveMinimum: 0 }, minItems: 3, maxItems: 3 },
        "stl-sha1": { type: "string", pattern: "^[0-9a-f]{40}$" }
      }
    },
    "model-sha1": { type: "string", pattern: "^[0-9a-f]{40}$" }
  }
};

// Product designs: the options and every design the picks can land on. The
// product's own fields are the default design. Keyed "key", never "id":
// scripts/auto-render.js slices product blocks on "id".
const designsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["default", "options", "list"],
  properties: {
    default: str,
    options: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "choices"],
        properties: {
          key: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          multiple: { type: "boolean" },
          choices: { type: "array", minItems: 2, items: { type: "string", minLength: 1 } }
        }
      }
    },
    list: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "picks"],
        properties: {
          key: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          picks: { type: "object", additionalProperties: { anyOf: [str, { type: "array", items: str }] } },
          geometry: geometrySchema,
          model: str,
          wireframe: str,
          stl: str,
          icons: metalMap,
          "fallback-img": metalMap
        }
      }
    }
  }
};

const productSchema = {
  type: "object",
  required: ["id", "name", "category", "description", "default-metal", "per-metal-specs", "size-range", "geometry", "assets"],
  properties: {
    id: str,
    name: { type: "string", minLength: 1 },
    category: str,
    description: str,
    "default-metal": str,
    // Price at the reference size (62 mm), scaled linearly with size.
    "per-metal-specs": {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["price"],
        properties: { price: { type: "number", minimum: 0 } }
      }
    },
    "size-range": {
      type: "object",
      required: ["min", "max"],
      properties: { min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 } }
    },
    geometry: geometrySchema,
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
      required: ["model", "icons", "fallback-img", "wheel-poster", "xray", "top-shot", "photos"],
      properties: {
        model: str,
        // Optional, hand-added: drawn over the model in the specs stage.
        wireframe: str,
        // Optional print model (scripts/split-models.js), measured into geometry.print;
        // kept out of the build.
        stl: str,
        icons: metalMap,
        "fallback-img": metalMap,
        "wheel-poster": metalMap,
        xray: str,
        "top-shot": metalMap,
        photos: {
          type: "array",
          items: { type: "object", required: ["src", "description"], properties: { src: str, description: str } }
        }
      }
    },
    designs: designsSchema
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

// model-sha1 / stl-sha1 must match the files, and min-box must be three
// orthonormal axes. Print models aren't in git, so missing ones are counted,
// not failed.
let missingPrintModels = 0;
function checkGeometry(label, modelRel, geometry, stlRel) {
  if (modelRel && existsExactCase(modelRel)) {
    const sha1 = crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, modelRel))).digest("hex");
    if (sha1 !== geometry["model-sha1"]) fail(label, "geometry is stale: the model file changed since it was measured (run `npm run measure-models`)");
  }
  if (stlRel) {
    if (stlRel.startsWith("/") || /^[a-z]+:/i.test(stlRel)) checkPath(label + " stl", stlRel);
    if (!geometry.print) {
      fail(label, "names a print model (stl) but geometry has no print measurements (run `npm run measure-models`)");
    } else if (existsExactCase(stlRel)) {
      const sha1 = crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, stlRel))).digest("hex");
      if (sha1 !== geometry.print["stl-sha1"]) fail(label, "geometry.print is stale: the print model changed since it was measured (run `npm run measure-models`)");
    } else {
      missingPrintModels++;
    }
  } else if (geometry.print) {
    fail(label, "geometry has print measurements but no print model (stl) is named");
  }
  const boxAxes = geometry["min-box"].axes;
  const dot3 = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const skew = Math.max(
    ...boxAxes.map((a) => Math.abs(dot3(a, a) - 1)),
    Math.abs(dot3(boxAxes[0], boxAxes[1])),
    Math.abs(dot3(boxAxes[0], boxAxes[2])),
    Math.abs(dot3(boxAxes[1], boxAxes[2]))
  );
  if (skew > 1e-3) fail(label, "geometry.min-box axes are not three unit vectors at right angles (run `npm run measure-models`)");
}

// Designs beyond their shape: the default exists and has no files of its own,
// every other one has its model, renders and geometry, and each design's picks
// name valid choices for every option, unique across designs.
function checkDesigns(label, product, metals) {
  const designs = product.designs;
  const options = new Map(designs.options.map((o) => [o.key, o]));
  if (options.size !== designs.options.length) fail(label, "designs.options has two options with the same key");
  for (const option of designs.options) {
    if (new Set(option.choices).size !== option.choices.length) fail(label, 'designs option "' + option.key + '" lists a choice twice');
  }
  const keys = new Set();
  const names = new Set();
  const picked = new Set();
  for (const design of designs.list) {
    const at = label + " design " + design.key;
    if (keys.has(design.key)) fail(at, "two designs share this key");
    if (options.has(design.key)) fail(at, "its key is also an option's key (designs are found by it in products.json)");
    keys.add(design.key);
    if (names.has(slugify(design.name))) fail(at, 'two designs share the name "' + design.name + '"');
    names.add(slugify(design.name));

    for (const pickKey of Object.keys(design.picks)) {
      if (!options.has(pickKey)) fail(at, 'picks "' + pickKey + '", which is not an option');
    }
    const signature = [];
    for (const option of designs.options) {
      const pick = design.picks[option.key];
      const values = Array.isArray(pick) ? pick : pick === undefined ? [] : [pick];
      if (option.multiple ? !Array.isArray(pick) || !values.length : typeof pick !== "string") {
        fail(at, 'picks needs ' + (option.multiple ? "a non-empty list" : "one choice") + ' for "' + option.key + '"');
      }
      for (const value of values) {
        if (!option.choices.includes(value)) fail(at, 'picks "' + value + '" for "' + option.key + '", which is not one of its choices');
      }
      signature.push(option.key + "=" + values.slice().sort().join("+"));
    }
    if (picked.has(signature.join("|"))) fail(at, "another design has the same picks");
    picked.add(signature.join("|"));

    const own = ["model", "wireframe", "stl", "icons", "fallback-img", "geometry"].filter((f) => design[f] !== undefined);
    if (design.key === designs.default) {
      if (own.length) fail(at, "is the default design, which is the product's own: it can't have " + own.join(", ") + " of its own");
      continue;
    }
    for (const field of ["model", "icons", "fallback-img", "geometry"]) {
      if (design[field] === undefined) fail(at, 'has no "' + field + '"');
    }
    if (!design.model || !design.icons || !design["fallback-img"] || !design.geometry) continue;
    checkPath(at + " model", design.model);
    checkPath(at + " wireframe", design.wireframe);
    for (const field of ["icons", "fallback-img"]) {
      for (const metal of metals) {
        if (!design[field][metal]) fail(at, field + ' has no "' + metal + '"');
      }
      for (const [metal, rel] of Object.entries(design[field])) {
        if (!metals.has(metal)) fail(at, field + ' has unknown metal "' + metal + '"');
        checkPath(at + " " + field + "." + metal, rel);
        if (field === "icons") checkVariants(at + " icons." + metal, rel, ["128"]);
      }
    }
    checkGeometry(at, design.model, design.geometry, design.stl);
  }
  if (!keys.has(designs.default)) fail(label, 'designs.default "' + designs.default + '" is not one of its designs');
}

/* ---- run ---- */

const index = readJson("data/series.json");
if (index && validate("data/series.json", indexSchema, index)) {
  const metals = new Set(index.metals);
  const hdriKeys = new Set(Object.keys(index.hdris));
  const slugs = index.series.map((s) => s.slug);

  if (!slugs.includes(index.featured)) fail("data/series.json", 'featured "' + index.featured + '" is not a series slug');
  if (new Set(slugs).size !== slugs.length) fail("data/series.json", "duplicate series slug");
  // js/product.js computeCosts: one entry per metal; manufacturing must not be negative.
  const costs = index["metal-costs"];
  for (const metal of metals) {
    if (!costs[metal]) fail("data/series.json", 'metal-costs has no "' + metal + '"');
  }
  for (const [metal, c] of Object.entries(costs)) {
    if (!metals.has(metal)) fail("data/series.json", 'metal-costs has unknown metal "' + metal + '"');
    else if (c["production-per-cm3"] < c["price-per-g"] * c["density-g-cm3"] * (1 + c["loss-margin"])) {
      fail("data/series.json", 'metal-costs "' + metal + '": production-per-cm3 is below its raw-material cost per cm3, so manufacturing would be negative');
    }
  }
  for (const [cat, info] of Object.entries(index.categories)) {
    const guide = info["size-guide"];
    if (!guide) continue;
    for (const row of guide.rows) {
      if (row.length !== guide.head.length) fail("data/series.json", 'categories "' + cat + '" size-guide: a row has ' + row.length + " cells, the head has " + guide.head.length);
    }
  }

  const technologies = index["printing-technologies"];
  for (const metal of metals) {
    const id = index["metal-technology"][metal];
    if (!id) fail("data/series.json", 'metal-technology has no "' + metal + '"');
    else if (!technologies[id]) fail("data/series.json", 'metal-technology "' + metal + '" names "' + id + '", which is not in printing-technologies');
  }
  for (const metal of Object.keys(index["metal-technology"])) {
    if (!metals.has(metal)) fail("data/series.json", 'metal-technology has unknown metal "' + metal + '"');
  }

  for (const metal of metals) {
    if (!index["metal-composition"][metal]) fail("data/series.json", 'metal-composition has no "' + metal + '"');
  }
  for (const metal of Object.keys(index["metal-composition"])) {
    if (!metals.has(metal)) fail("data/series.json", 'metal-composition has unknown metal "' + metal + '"');
  }
  for (const metal of metals) {
    if (!index["metal-shaders"][metal]) fail("data/series.json", 'metal-shaders has no "' + metal + '"');
  }
  for (const metal of Object.keys(index["metal-shaders"])) {
    if (!metals.has(metal)) fail("data/series.json", 'metal-shaders has unknown metal "' + metal + '"');
  }
  if (index["swatch-hdri"] && !hdriKeys.has(index["swatch-hdri"])) fail("data/series.json", 'swatch-hdri "' + index["swatch-hdri"] + '" is not a key of hdris');
  for (const [key, rel] of Object.entries(index.hdris)) checkPath("data/series.json hdris." + key, rel);

  // Item slugs are flat at the root (emjive.eu/<slug>): unique across all series
  // and not shadowing a page or top-level entry.
  const reserved = reservedNames(ROOT);
  const itemSlugs = new Map();

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
      // Originals; low-res variants are derived for the first, phone ones for the rest.
      (series.hero.preload || []).forEach((rel, i) => {
        checkPath(where + " hero.preload", rel);
        checkVariants(where + " hero.preload", rel, i === 0 ? ["lo", "m", "m_lo"] : ["m"]);
      });
      // Fragment images carry data-full (the original) and data-lo when there is a low-res pair.
      if (series.hero.fragment && existsExactCase(series.hero.fragment)) {
        const html = fs.readFileSync(path.join(ROOT, series.hero.fragment), "utf8");
        for (const match of html.matchAll(/<img\b[^>]*>/g)) {
          const tag = match[0];
          const src = (tag.match(/\bsrc="([^"]+)"/) || [])[1];
          const full = (tag.match(/\bdata-full="([^"]+)"/) || [])[1];
          const at = where + " " + series.hero.fragment;
          if (src) checkPath(at, src);
          if (full) {
            checkPath(at + " data-full", full);
            checkVariants(at + " " + full, full, /\bdata-lo\b/.test(tag) ? ["lo", "m", "m_lo"] : ["m"]);
          }
        }
      }
      checkPhoneConstants(series.hero.css, { "hero-crop": PHONE_CROP.hero });
    }

    const productsFile = readJson(series.products);
    if (productsFile && validate(series.products, productsFileSchema, productsFile)) {
      if (productsFile.series !== series.slug) fail(series.products, 'series field "' + productsFile.series + '" does not match slug "' + series.slug + '"');
      const ids = new Set();
      for (const product of productsFile.products) {
        const label = series.products + " product " + product.id + " (" + product.name + ")";
        if (ids.has(product.id)) fail(label, "duplicate id within the series");
        ids.add(product.id);

        const itemSlug = slugify(product.name);
        if (!itemSlug) fail(label, "name has no letters or digits to build an address from");
        else if (reserved.has(itemSlug)) fail(label, 'its address "/' + itemSlug + '" is taken by a page or a top-level file/folder');
        else if (itemSlugs.has(itemSlug)) fail(label, 'its address "/' + itemSlug + '" is already used by ' + itemSlugs.get(itemSlug));
        else itemSlugs.set(itemSlug, series.slug + " / " + product.id);
        if (!series.categories.includes(product.category)) fail(label, 'category "' + product.category + '" is not declared by its series');
        if (!metals.has(product["default-metal"])) fail(label, 'default-metal "' + product["default-metal"] + '" is not in metals');

        if (product["size-range"].min > product["size-range"].max) fail(label, "size-range min is above its max");

        for (const metal of metals) {
          if (!product["per-metal-specs"][metal]) fail(label, 'per-metal-specs has no "' + metal + '"');
          if (product.assets.model || Object.keys(product.assets.icons).length) {
            if (!product.assets.icons[metal]) fail(label, 'assets.icons has no "' + metal + '"');
          }
        }
        for (const field of ["per-metal-specs"]) {
          for (const key of Object.keys(product[field])) if (!metals.has(key)) fail(label, field + ' has unknown metal "' + key + '"');
        }
        for (const field of ["icons", "fallback-img", "wheel-poster", "top-shot"]) {
          for (const [metal, rel] of Object.entries(product.assets[field])) {
            if (!metals.has(metal)) fail(label, "assets." + field + ' has unknown metal "' + metal + '"');
            checkPath(label + " assets." + field + "." + metal, rel);
          }
        }
        for (const [metal, rel] of Object.entries(product.assets.icons)) {
          checkVariants(label + " assets.icons." + metal, rel, ["128"]);
        }
        checkPath(label + " assets.model", product.assets.model);
        checkPath(label + " assets.wireframe", product.assets.wireframe);
        checkGeometry(label, product.assets.model, product.geometry, product.assets.stl);
        if (product.designs) checkDesigns(label, product, metals);
        checkPath(label + " assets.xray", product.assets.xray);
        checkVariants(label + " assets.xray", product.assets.xray, ["lo", "m", "m_lo"]);
        product.assets.photos.forEach((photo, i) => checkPath(label + " assets.photos[" + i + "]", photo.src));
      }
    }

    const manifest = readJson(series.manifest);
    if (manifest && validate(series.manifest, manifestSchema, manifest)) {
      if (manifest.series !== series.slug) fail(series.manifest, 'series field "' + manifest.series + '" does not match slug "' + series.slug + '"');
    }
  }
}

// productSlug() in js/series.js must agree with scripts/slugs.js.
if (index && existsExactCase("js/series.js")) {
  const src = fs.readFileSync(path.join(ROOT, "js/series.js"), "utf8").replace(/\r\n/g, "\n");
  const body = /\n {2}function productSlug\(product\) \{[\s\S]*?\n {2}\}/.exec(src);
  if (!body) {
    fail("js/series.js", "no productSlug(product) function found (validate-data reads it to compare with scripts/slugs.js)");
  } else {
    const clientSlug = new Function("return (" + body[0] + ")")();
    for (const series of index.series) {
      const file = readJson(series.products);
      for (const product of (file && file.products) || []) {
        if (clientSlug(product) !== slugify(product.name)) {
          fail("js/series.js", 'productSlug() gives "' + clientSlug(product) + '" for "' + product.name + '" but scripts/slugs.js gives "' + slugify(product.name) + '"');
        }
      }
    }
  }
}

checkPhoneConstants("css/style.css", { "xray-crop": PHONE_CROP.xray });
if (existsExactCase("js/loader.js") && !fs.readFileSync(path.join(ROOT, "js/loader.js"), "utf8").includes(PHONE_QUERY)) {
  fail("js/loader.js", "does not contain the phone query " + PHONE_QUERY);
}

exitOnProblems("validate-data", problems);
if (missingPrintModels) {
  console.log("validate-data: " + missingPrintModels + " print model(s) (assets.stl) are not on disk — they are not in git, so their measurements (geometry.print) were not checked against them");
}
console.log("validate-data: ok");
