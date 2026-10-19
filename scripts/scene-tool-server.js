#!/usr/bin/env node
// Dev server for scene-tool.html (npm run scene-tool): live preview of product
// cameras, series and swatch HDRIs, swatch blur and camera, and metal shaders
// through the real viewer, saved by text-patching the source files in place.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const SERIES_JSON_PATH = path.join(ROOT, "data", "series.json");
const THREE_VIEWER_PATH = path.join(ROOT, "js", "three-viewer.js");
const PORT = 5200;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".css": "text/css"
};

// ---- helpers ----

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    var chunks = [];
    var size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      var raw = Buffer.concat(chunks).toString("utf8");
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
  var body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function findSeriesEntry(seriesIndex, seriesSlug) {
  return (seriesIndex.series || []).find((s) => s.slug === seriesSlug) || null;
}

// ---- text patchers ----
// Replace one field inside the block anchored on an "id"/"slug", without
// re-serializing the file, so hand alignment survives. null if the field
// isn't there: it must be added by hand first.

function updateCameraDefaultInText(text, productId, orbit) {
  var idAnchor = '"id": "' + productId + '"';
  var startIdx = text.indexOf(idAnchor);
  if (startIdx === -1) return null;
  var nextIdIdx = text.indexOf('"id": "', startIdx + idAnchor.length);
  var blockEnd = nextIdIdx === -1 ? text.length : nextIdIdx;
  var block = text.slice(startIdx, blockEnd);

  var fieldPattern = /"3d-viewer-camera-default":\s*\{[^}]*\}/;
  if (!fieldPattern.test(block)) return null;
  var newFieldText =
    '"3d-viewer-camera-default": { "rotation": ' + orbit.rotation +
    ', "tilt": ' + orbit.tilt + ', "zoom": ' + orbit.zoom + ', "roll": ' + orbit.roll + ' }';
  var newBlock = block.replace(fieldPattern, newFieldText);
  return text.slice(0, startIdx) + newBlock + text.slice(blockEnd);
}

function updateSeriesHdriInText(text, seriesSlug, hdriKey) {
  var slugAnchor = '"slug": "' + seriesSlug + '"';
  var startIdx = text.indexOf(slugAnchor);
  if (startIdx === -1) return null;
  var nextSlugIdx = text.indexOf('"slug": "', startIdx + slugAnchor.length);
  var blockEnd = nextSlugIdx === -1 ? text.length : nextSlugIdx;
  var block = text.slice(startIdx, blockEnd);

  var fieldPattern = /"hdri":\s*"[^"]*"/;
  if (!fieldPattern.test(block)) return null;
  var newBlock = block.replace(fieldPattern, '"hdri": "' + hdriKey + '"');
  return text.slice(0, startIdx) + newBlock + text.slice(blockEnd);
}

// Top-level swatch fields; each update is optional.
function updateSwatchSceneInText(text, updates) {
  var result = text;
  if (updates["swatch-hdri"] !== undefined) {
    var hdriPattern = /"swatch-hdri":\s*"[^"]*"/;
    if (!hdriPattern.test(result)) return null;
    result = result.replace(hdriPattern, function () { return '"swatch-hdri": "' + updates["swatch-hdri"] + '"'; });
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

// Patches one metal in js/three-viewer.js's METAL_PRESETS, bounded to that
// object literal.
function updateMetalPresetInText(text, metalKey, preset) {
  var startAnchor = "var METAL_PRESETS = {";
  var startIdx = text.indexOf(startAnchor);
  if (startIdx === -1) return null;
  var blockEndIdx = text.indexOf("};", startIdx);
  if (blockEndIdx === -1) return null;
  var blockEnd = blockEndIdx + 2;
  var block = text.slice(startIdx, blockEnd);

  var fieldPattern = new RegExp(metalKey + ":\\s*\\{[^}]*\\}");
  if (!fieldPattern.test(block)) return null;
  var newFieldText =
    metalKey + ": { baseColorFactor: [" + preset.r + " / 255, " + preset.g + " / 255, " + preset.b +
    " / 255, 1], metallicFactor: " + preset.metallicFactor + ", roughnessFactor: " + preset.roughnessFactor + " }";
  var newBlock = block.replace(fieldPattern, newFieldText);
  return text.slice(0, startIdx) + newBlock + text.slice(blockEnd);
}

// ---- endpoints: each re-reads its file and writes only on a successful patch ----

async function handleSaveProductCamera(req, res) {
  var body = await readJsonBody(req);
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
  var body = await readJsonBody(req);
  var seriesSlug = body.seriesSlug;
  var hdriKey = body.hdriKey;
  if (!seriesSlug || !hdriKey) return sendJson(res, 400, { error: "seriesSlug and hdriKey are required" });

  var seriesText = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var seriesIndex = JSON.parse(seriesText);
  if (!findSeriesEntry(seriesIndex, seriesSlug)) return sendJson(res, 400, { error: "unknown series: " + seriesSlug });
  if (!Object.prototype.hasOwnProperty.call(seriesIndex.hdris || {}, hdriKey)) {
    return sendJson(res, 400, { error: "unknown hdri: " + hdriKey });
  }

  var patched = updateSeriesHdriInText(seriesText, seriesSlug, hdriKey);
  if (!patched) {
    return sendJson(res, 404, { error: "could not find series \"" + seriesSlug + "\"'s hdri field — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { seriesSlug: seriesSlug, hdri: hdriKey } });
}

// Only the angles: distance, fov and frame are solved (swatchOrbit in js/three-viewer.js).
async function handleSaveSwatchCamera(req, res) {
  var body = await readJsonBody(req);
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
  var body = await readJsonBody(req);
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
  var body = await readJsonBody(req);
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

async function handleSaveMetalShader(req, res) {
  var body = await readJsonBody(req);
  var metalKey = body.metalKey;

  var seriesIndex = JSON.parse(fs.readFileSync(SERIES_JSON_PATH, "utf8"));
  if (!(seriesIndex.metals || []).includes(metalKey)) {
    return sendJson(res, 400, { error: "unknown metal: " + metalKey });
  }
  var r = body.r, g = body.g, b = body.b;
  var metallicFactor = body.metallicFactor, roughnessFactor = body.roughnessFactor;
  if (![r, g, b].every(isFiniteNumber) || [r, g, b].some((n) => n < 0 || n > 255)) {
    return sendJson(res, 400, { error: "r/g/b must be finite numbers between 0 and 255" });
  }
  if (![metallicFactor, roughnessFactor].every(isFiniteNumber) || [metallicFactor, roughnessFactor].some((n) => n < 0 || n > 1)) {
    return sendJson(res, 400, { error: "metallicFactor/roughnessFactor must be finite numbers between 0 and 1" });
  }

  var text = fs.readFileSync(THREE_VIEWER_PATH, "utf8");
  var preset = {
    r: Math.round(r), g: Math.round(g), b: Math.round(b),
    metallicFactor: metallicFactor, roughnessFactor: roughnessFactor
  };
  var patched = updateMetalPresetInText(text, metalKey, preset);
  if (!patched) {
    return sendJson(res, 404, { error: "could not find METAL_PRESETS." + metalKey + " in js/three-viewer.js" });
  }

  fs.writeFileSync(THREE_VIEWER_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { metalKey: metalKey, preset: preset } });
}

const ROUTES = {
  "POST /api/save-product-camera": handleSaveProductCamera,
  "POST /api/save-series-hdri": handleSaveSeriesHdri,
  "POST /api/save-swatch-camera": handleSaveSwatchCamera,
  "POST /api/save-swatch-hdri": handleSaveSwatchHdri,
  "POST /api/save-swatch-blur": handleSaveSwatchBlur,
  "POST /api/save-metal-shader": handleSaveMetalShader
};

// ---- static files, including /node_modules for scene-tool.html's import map ----
function serveStatic(req, res) {
  var urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/scene-tool.html";
  var filePath = path.join(ROOT, urlPath);
  var normalizedFile = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
  var normalizedRoot = path.resolve(ROOT).replace(/\\/g, "/").toLowerCase();
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
function isLocalRequest(req) {
  const host = String(req.headers.host || "");
  const allowed = ["localhost:" + PORT, LOOPBACK + ":" + PORT];
  if (!allowed.includes(host)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  return !origin || allowed.some((h) => origin === "http://" + h);
}

const server = http.createServer((req, res) => {
  if (!isLocalRequest(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  var routeKey = req.method + " " + req.url.split("?")[0];
  var handler = ROUTES[routeKey];
  if (handler) {
    handler(req, res).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: String((err && err.message) || err) });
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, LOOPBACK, () => {
  console.log("scene-tool — http://" + LOOPBACK + ":" + PORT + "/scene-tool.html");
});
