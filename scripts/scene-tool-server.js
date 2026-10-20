#!/usr/bin/env node
// Dev server for scene-tool.html (npm run scene-tool): live preview of product
// cameras, series and swatch HDRIs, the HDRI blur, swatch blur and camera, the
// sun, reflection detail and metal shaders through the real viewer, saved by
// text-patching the data files in place.

"use strict";

const fs = require("fs");
const path = require("path");
const blocks = require("./json-tool-blocks");
const { ROOT, SERIES_JSON_PATH, findSeriesEntry, readJsonBody, sendJson, startToolServer } = require("./helpers");

const PORT = 5200;
const MAX_BODY_BYTES = 1e6;

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// ---- text patchers ----
// Replace one field without re-serializing the file, so hand alignment
// survives. null if the field isn't there: it must be added by hand first.

function updateCameraDefaultInText(text, productId, orbit) {
  var span = blocks.anchoredSpan(text, "id", productId);
  var newFieldText =
    '"3d-viewer-camera-default": { "rotation": ' + orbit.rotation +
    ', "tilt": ' + orbit.tilt + ', "zoom": ' + orbit.zoom + ', "roll": ' + orbit.roll + ' }';
  return span && blocks.replaceInSpan(text, span, /"3d-viewer-camera-default":\s*\{[^}]*\}/, newFieldText);
}

// Top-level swatch fields; each update is optional.
function updateSwatchSceneInText(text, updates) {
  var result = text;
  if (updates["swatch-hdri"] !== undefined) {
    result = blocks.updateTopLevelScalarInText(result, "swatch-hdri", '"' + updates["swatch-hdri"] + '"');
    if (!result) return null;
  }
  if (updates["swatch-blur"] !== undefined) {
    var blurPattern = /"swatch-blur":\s*-?[0-9.]+/;
    if (!blurPattern.test(result)) return null;
    result = result.replace(blurPattern, function () { return '"swatch-blur": ' + updates["swatch-blur"]; });
  }
  if (updates["swatch-camera"] !== undefined) {
    var cameraPattern = /"swatch-camera":\s*\{[^{}]*\}/;
    if (!cameraPattern.test(result)) return null;
    var camera = updates["swatch-camera"];
    var block = '"swatch-camera": { "rotation": ' + camera.rotation + ', "tilt": ' + camera.tilt + ', "roll": ' + camera.roll + " }";
    result = result.replace(cameraPattern, function () { return block; });
  }
  return result;
}

// One metal's entry in data/series.json's "metal-shaders", added if the metal has none yet.
function updateMetalShaderInText(text, metalKey, shader) {
  var anchor = '"metal-shaders": {';
  var value = '{ "color": [' + shader.color.join(", ") + '], "metalness": ' + shader.metalness +
    ', "roughness": ' + shader.roughness + " }";
  return blocks.updateObjectEntryInText(text, anchor, metalKey, value) ||
    blocks.insertBeforeObjectClose(text, anchor, '    "' + metalKey + '": ' + value);
}

// ---- endpoints: each re-reads its file and writes only on a successful patch ----

async function handleSaveProductCamera(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  var seriesSlug = body.seriesSlug;
  var productId = body.productId;
  if (!seriesSlug || !productId) return sendJson(res, 400, { error: "seriesSlug and productId are required" });
  if (![body.rotation, body.tilt, body.zoom, body.roll].every(isFiniteNumber)) {
    return sendJson(res, 400, { error: "rotation/tilt/zoom/roll must be finite numbers" });
  }

  var seriesIndex = JSON.parse(fs.readFileSync(SERIES_JSON_PATH, "utf8"));
  var seriesEntry = findSeriesEntry(seriesIndex, seriesSlug);
  if (!seriesEntry) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });

  var productsPath = path.join(ROOT, seriesEntry.products);
  var text = fs.readFileSync(productsPath, "utf8");
  var orbit = {
    rotation: Math.round(body.rotation),
    tilt: Math.round(body.tilt),
    zoom: Math.round(body.zoom),
    roll: Math.round(body.roll)
  };
  var patched = updateCameraDefaultInText(text, productId, orbit);
  if (!patched) {
    return sendJson(res, 404, {
      error: "could not find \"" + productId + "\"'s 3d-viewer-camera-default field in " +
        seriesEntry.products + " — add it by hand first"
    });
  }

  fs.writeFileSync(productsPath, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: orbit });
}

async function handleSaveSeriesHdri(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  var seriesSlug = body.seriesSlug;
  var hdriKey = body.hdriKey;
  if (!seriesSlug || !hdriKey) return sendJson(res, 400, { error: "seriesSlug and hdriKey are required" });

  var seriesText = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var seriesIndex = JSON.parse(seriesText);
  if (!findSeriesEntry(seriesIndex, seriesSlug)) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  if (!Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, hdriKey)) {
    return sendJson(res, 400, { error: "unknown hdri: " + hdriKey });
  }

  var patched = blocks.updateSeriesFieldInText(seriesText, seriesSlug, "hdri", '"' + hdriKey + '"');
  if (!patched) {
    return sendJson(res, 404, { error: "could not find series \"" + seriesSlug + "\"'s hdri field — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { seriesSlug: seriesSlug, hdri: hdriKey } });
}

// Only the angles: distance, fov and frame are solved (swatchOrbit in js/three-viewer.js).
async function handleSaveSwatchCamera(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  if (![body.rotation, body.tilt, body.roll].every(isFiniteNumber)) {
    return sendJson(res, 400, { error: "rotation/tilt/roll must be finite numbers" });
  }
  var camera = {
    rotation: Math.round(body.rotation * 100) / 100,
    tilt: Math.round(body.tilt * 100) / 100,
    roll: Math.round(body.roll * 100) / 100
  };
  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var patched = updateSwatchSceneInText(text, { "swatch-camera": camera });
  if (!patched) {
    return sendJson(res, 404, { error: "could not find \"swatch-camera\" in data/series.json — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "swatch-camera": camera } });
}

async function handleSaveSwatchHdri(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  var hdriKey = body.hdriKey;
  if (!hdriKey) return sendJson(res, 400, { error: "hdriKey is required" });

  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var seriesIndex = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, hdriKey)) {
    return sendJson(res, 400, { error: "unknown hdri: " + hdriKey });
  }
  var patched = updateSwatchSceneInText(text, { "swatch-hdri": hdriKey });
  if (!patched) {
    return sendJson(res, 404, { error: "could not find \"swatch-hdri\" in data/series.json — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "swatch-hdri": hdriKey } });
}

// Gaussian sigma in pixels of the HDRI image.
async function handleSaveSwatchBlur(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!isFiniteNumber(body.blur) || body.blur < 0) {
    return sendJson(res, 400, { error: "blur must be a finite number, 0 or more" });
  }
  var blur = Math.round(body.blur * 100) / 100;
  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var patched = updateSwatchSceneInText(text, { "swatch-blur": blur });
  if (!patched) {
    return sendJson(res, 404, { error: "could not find \"swatch-blur\" in data/series.json — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "swatch-blur": blur } });
}

// Every scene's HDRI blur: gaussian sigma in degrees.
async function handleSaveHdriBlur(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!isFiniteNumber(body.blur) || body.blur < 0) {
    return sendJson(res, 400, { error: "blur must be a finite number, 0 or more" });
  }
  var blur = Math.round(body.blur * 100) / 100;
  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var blurPattern = /"hdri-blur":\s*-?[0-9.]+/;
  if (!blurPattern.test(text)) {
    return sendJson(res, 404, { error: 'could not find "hdri-blur" in data/series.json — add it by hand first' });
  }
  var patched = text.replace(blurPattern, function () { return '"hdri-blur": ' + blur; });

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "hdri-blur": blur } });
}

// Every metal's reflection detail: environment levels read finer.
async function handleSaveReflectionDetail(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!isFiniteNumber(body.levels) || body.levels < 0) {
    return sendJson(res, 400, { error: "levels must be a finite number, 0 or more" });
  }
  var levels = Math.round(body.levels * 100) / 100;
  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var levelsPattern = /"reflection-detail":\s*[0-9.]+/;
  if (!levelsPattern.test(text)) {
    return sendJson(res, 404, { error: 'could not find "reflection-detail" in data/series.json — add it by hand first' });
  }
  var patched = text.replace(levelsPattern, function () { return '"reflection-detail": ' + levels; });

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "reflection-detail": levels } });
}

async function handleSaveSun(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  if (typeof body.on !== "boolean" || !isFiniteNumber(body.strength) || body.strength < 0) {
    return sendJson(res, 400, { error: "on must be a boolean and strength a finite number, 0 or more" });
  }
  var sun = { on: body.on, strength: Math.round(body.strength * 100) / 100 };
  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var sunPattern = /"sun":\s*\{[^{}]*\}/;
  if (!sunPattern.test(text)) {
    return sendJson(res, 404, { error: 'could not find "sun" in data/series.json — add it by hand first' });
  }
  var patched = text.replace(sunPattern, function () {
    return '"sun": { "on": ' + sun.on + ', "strength": ' + sun.strength + " }";
  });

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { sun: sun } });
}

async function handleSaveMetalShader(req, res) {
  var body = await readJsonBody(req, MAX_BODY_BYTES);
  var metalKey = body.metalKey;

  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var seriesIndex = JSON.parse(text);
  if (!(seriesIndex.metals || []).includes(metalKey)) {
    return sendJson(res, 400, { error: "unknown metal: " + metalKey });
  }
  var color = body.color;
  if (!Array.isArray(color) || color.length !== 3 || !color.every(isFiniteNumber) || color.some((n) => n < 0 || n > 255)) {
    return sendJson(res, 400, { error: "color must be three finite numbers between 0 and 255" });
  }
  if (![body.metalness, body.roughness].every(isFiniteNumber) || [body.metalness, body.roughness].some((n) => n < 0 || n > 1)) {
    return sendJson(res, 400, { error: "metalness/roughness must be finite numbers between 0 and 1" });
  }

  var shader = {
    color: color.map(Math.round),
    metalness: Math.round(body.metalness * 100) / 100,
    roughness: Math.round(body.roughness * 100) / 100
  };
  var patched = updateMetalShaderInText(text, metalKey, shader);
  if (!patched) {
    return sendJson(res, 404, { error: 'could not find "metal-shaders" in data/series.json — add it by hand first' });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { metalKey: metalKey, shader: shader } });
}

const ROUTES = {
  "POST /api/save-product-camera": handleSaveProductCamera,
  "POST /api/save-series-hdri": handleSaveSeriesHdri,
  "POST /api/save-swatch-camera": handleSaveSwatchCamera,
  "POST /api/save-swatch-hdri": handleSaveSwatchHdri,
  "POST /api/save-swatch-blur": handleSaveSwatchBlur,
  "POST /api/save-hdri-blur": handleSaveHdriBlur,
  "POST /api/save-reflection-detail": handleSaveReflectionDetail,
  "POST /api/save-sun": handleSaveSun,
  "POST /api/save-metal-shader": handleSaveMetalShader
};

// Static files include /node_modules, for scene-tool.html's import map.
startToolServer({ name: "scene-tool", port: PORT, page: "scene-tool.html", routes: ROUTES });
