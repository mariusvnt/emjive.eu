#!/usr/bin/env node
/* ==========================================================================
   scene-tool-server — bare static/API server for scene-tool.html, a
   standalone dev page for tuning a product's camera angle, a series' HDRI,
   the swatch scene's point light (where it stands, how strong it and the
   uniform environment are), and a metal's
   shader — all as a live preview through the site's real
   window.EmjiveModelViewer (js/three-viewer.js), with a Save action that
   text-patches the relevant source file in place.

   Usage:
     node scripts/scene-tool-server.js
     npm run scene-tool

   Modeled directly on scripts/auto-render.js's own startServer()/MIME map/
   path-traversal guard (duplicated rather than imported — this file has no
   other reason to depend on auto-render.js, and a little redundancy here
   is consistent with this repo's own tolerance for that trade-off, e.g.
   vite.config.js's copyFilesVitesBuildCantTrace() comment).

   Deliberately outside Vite entirely (not in vite.config.js's
   rollupOptions.input, same as auto-render.js itself) — this is an
   authoring tool, not a page the live site ever serves.
   ========================================================================== */

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

// ---- small shared helpers ----

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

// ---- text-surgery patchers — same "id"/"slug"-anchor, non-nested-braces
// block-scoping idiom as scripts/auto-render.js's own
// updateProductMetalFieldInText, adapted for whole-block numeric/string
// replacements instead of a per-metal string value swap. Never re-parses/
// re-serializes the whole file, so hand-aligned formatting elsewhere
// survives untouched. Each returns the patched text, or null if the
// expected shape wasn't found (caller responds with a clear error rather
// than silently inserting a new key). ----

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

// Replaces the top-level "swatch-light": { ... } block (a single object of
// plain numbers and one array of three, so no nested braces) with `light`,
// kept on one line like the file's own. Returns null if the block isn't
// there, so nothing is written for a field that has to be added by hand first.
function updateSwatchLightInText(text, light) {
  var pattern = /"swatch-light":\s*\{[^{}]*\}/;
  if (!pattern.test(text)) return null;
  var block = '"swatch-light": { "position": [' + light.position.join(", ") + '], "intensity": ' + light.intensity +
    ', "environment": ' + light.environment + " }";
  return text.replace(pattern, function () { return block; });
}

// Patches js/three-viewer.js's own METAL_PRESETS object — the one save
// target in this file that isn't JSON. Bounded to the object literal's own
// span first ("var METAL_PRESETS = {" to the first "};" after it — a
// small, flat, 3-entry object, safe to bound this way) before matching the
// one metal's own sub-block within it, so a coincidental "steel:"/etc
// elsewhere in the file (there isn't one today, but this is cheap
// insurance) can never be touched. Regenerates the whole metal line in the
// file's existing "N / 255" style for baseColorFactor.
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

// ---- endpoint handlers — each re-reads its target file fresh (this
// server is long-lived across many separate Save clicks, unlike
// auto-render.js's one-shot batch read), validates before touching disk,
// and writes only on a successful patch match. ----

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

// The swatch scene's one point light — its position, its strength and the
// uniform environment's strength — is all anyone gets to set: the frame, the
// camera's place and the spheres' are solved (see swatchOrbit in
// js/three-viewer.js), so there is nothing else to accept or write.
async function handleSaveSwatchLight(req, res) {
  var body = await readJsonBody(req);
  var position = body.position;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(isFiniteNumber)) {
    return sendJson(res, 400, { error: "position must be three finite numbers" });
  }
  if (!isFiniteNumber(body.intensity) || !isFiniteNumber(body.environment)) {
    return sendJson(res, 400, { error: "intensity and environment must be finite numbers" });
  }

  var text = fs.readFileSync(SERIES_JSON_PATH, "utf8");
  var light = {
    position: position.map(function (n) { return Math.round(n * 100) / 100; }),
    intensity: Math.round(body.intensity * 100) / 100,
    environment: Math.round(body.environment * 100) / 100
  };
  var patched = updateSwatchLightInText(text, light);
  if (!patched) {
    return sendJson(res, 404, { error: "could not find \"swatch-light\" in data/series.json — add it by hand first" });
  }

  fs.writeFileSync(SERIES_JSON_PATH, patched, "utf8");
  return sendJson(res, 200, { ok: true, saved: { "swatch-light": light } });
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
  "POST /api/save-swatch-light": handleSaveSwatchLight,
  "POST /api/save-metal-shader": handleSaveMetalShader
};

// ---- static file serving — same shape as scripts/auto-render.js's own
// startServer(), including /node_modules/... so scene-tool.html's import
// map (three/three-addons, resolved the same way auto-render.js's
// HARNESS_HTML does) can be served from this same bare server. ----
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

// These servers can write to and delete files in the repo, so they must only
// ever answer this machine: bound to the loopback interface (not the LAN),
// and — because a web page the developer happens to have open could still
// aim a request at localhost — only for requests whose Host is a loopback
// name (stops DNS rebinding) and, for anything that isn't a plain read, whose
// Origin is this server itself (stops cross-site writes).
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
