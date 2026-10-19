#!/usr/bin/env node
// Re-renders the product images and metal swatches through the site's own
// viewer code (js/three-viewer.js, js/stack-scene.js) in headless Chrome with
// a real GPU (for MSAA; the startup log names the WebGL renderer). Set
// CHROME_PATH to override the Chrome location.
//
//   node scripts/auto-render.js [metal ...] [--series=<slug>] [--product=<slug>[,<slug>]] [--swatches-only] [--wheel-posters-only]
//   node scripts/auto-render.js --image-variants [--series=<slug>]
//
// Defaults: every metal in data/series.json, every series.
//   --product             only those products (designs included); swatches untouched
//   --swatches-only       only the metal squares
//   --wheel-posters-only  only the wheel posters
//   --image-variants      no render: rewrites the size variants (make-image-variants.js)
//
// Per metal, for every product (the picker shows any metal):
//   fallback-img  512px default-orbit capture: the viewer's pre-load poster, so it
//                 must match the live framing exactly
//   icon          the same capture, trimmed and re-centred (normalizeIconFraming)
//   wheel-poster  512px, drawn by the wheel's own scene (orthographic camera,
//                 fixed environment), so the swap to the live model changes nothing
//   top-shot      1024px straight down, with a contact shadow and a "finger"
//                 occluder hiding the ring's inner geometry
// Each non-default design gets its own icon and fallback-img. Then one 72px
// square per metal, assets/metal-sample_<metal>.webp: one sphere under the
// "swatch-hdri", blurred by "swatch-blur", from "swatch-camera" (set in
// scene-tool.html's swatch mode). products.json paths are patched in place;
// replaced files are deleted. Afterwards the icons' 128px thumbnails are rewritten.
//
// Re-run for every metal after changing METAL_PRESETS, the swatch camera or an HDRI.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");
const { makeVariants } = require("./make-image-variants");

const ROOT = path.resolve(__dirname, "..");
const SERIES_JSON_PATH = path.join(ROOT, "data", "series.json");
const PORT = 5199;

const ICON_SIZE = 512;
// The pre-load poster's box (js/three-viewer.js), so it is never scaled.
const FALLBACK_IMG_SIZE = ICON_SIZE;
const TOP_SHOT_SIZE = 1024;
// The model's box in the wheel's maths (js/stack-scene.js), at the wheel
// renderer's MAX_PIXEL_RATIO.
const WHEEL_POSTER_SIZE = ICON_SIZE;
const WHEEL_POSTER_SCALE = 1.5;
// Captured through the biggest square inside the sphere's disc (swatchOrbit
// in js/three-viewer.js); saved at 3x the picker's 1.5rem squares
// (--metal-square), sharp on a 3x screen.
const SWATCH_CAPTURE = 72;
const SWATCH_SIZE = 72;
const SWATCH_CAMERA_DEFAULT = { rotation: 0, tilt: 90, roll: 0 };
// Supersampling for sharp source pixels before the final downscale.
const CAPTURE_SCALE = 2;


function findChrome() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error("CHROME_PATH is set but doesn't exist: " + process.env.CHROME_PATH);
  }
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "Could not find a Chrome install in the usual places. Set CHROME_PATH to your Chrome " +
    "executable's path and try again."
  );
}

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

// A minimal page loading the site's own js/three-viewer.js and
// js/stack-scene.js, with an import map onto node_modules (no bundler here).
// Harness-only viewer options: `transparentBackground` (alpha to crop
// against) and `static` (no idle animation shifting the framing before the
// screenshot).
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="UTF-8" />
<script type="importmap">
{
  "imports": {
    "three": "/node_modules/three/build/three.module.js",
    "three/addons/": "/node_modules/three/examples/jsm/"
  }
}
</script>
<script type="module" src="js/three-viewer.js"></script>
<style>
  html, body { margin: 0; background: transparent; }
  #target-wrap { display: block; background: transparent; }
  /* The viewer leaves the canvas's CSS size to the stylesheet, which isn't
     loaded here: without this the canvas takes its 2x buffer size. */
  .emjive-3d-viewer, .emjive-3d-viewer__canvas { width: 100%; height: 100%; display: block; }
  .stack-canvas { width: 100%; height: 100%; display: block; }
</style>
</head><body>
<script type="module">
  import * as THREE from "three";
  import { createStackScene } from "/js/stack-scene.js";

  window.__renderReady = false;

  // Each render builds a new viewer (a new WebGL context); dispose the previous
  // one or contexts accumulate until the browser refuses new ones.
  var currentHandle = null;
  var currentStack = null;
  function disposeCurrentHandle() {
    if (currentHandle && currentHandle.renderer) currentHandle.renderer.dispose();
    currentHandle = null;
    if (currentStack) currentStack.dispose();
    currentStack = null;
  }

  function mountTargetWrap(widthPx, heightPx) {
    document.body.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.id = "target-wrap";
    wrap.style.width = widthPx + "px";
    wrap.style.height = (heightPx === undefined ? widthPx : heightPx) + "px";
    document.body.appendChild(wrap);
    return wrap;
  }

  window.__renderTarget = function (product, metalKey, sizePx, hdriRelPath) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var wrap = mountTargetWrap(sizePx);
    var handle = window.EmjiveModelViewer(product, metalKey, {
      transparentBackground: true,
      static: true,
      hdri: hdriRelPath,
      onReady: function () {
        // Two rAFs: the settled frame is the one screenshotted.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            window.__renderReady = true;
          });
        });
      }
    });
    if (!handle) {
      // Fail loudly: this run exists to produce the fallback images.
      throw new Error("could not create a WebGL context while rendering the icon for " + product.name + " (" + metalKey + ")");
    }
    handle.el.id = "target";
    handle.el.style.width = "100%";
    handle.el.style.height = "100%";
    wrap.appendChild(handle.el);
    currentHandle = handle;
  };

  // The model as the wheel draws it: the wheel's own scene with this one
  // product, at rest in the middle of the box.
  window.__renderWheelPoster = function (product, metalKey, sizePx, hdriRelPath) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var wrap = mountTargetWrap(sizePx);
    var host = document.createElement("div");
    host.id = "target";
    host.style.cssText = "position: relative; width: 100%; height: 100%;";
    wrap.appendChild(host);
    var stack = createStackScene({
      host: host,
      hdri: hdriRelPath,
      items: [{ id: "0", product: Object.assign({}, product, { "default-metal": metalKey }), size: sizePx }]
    });
    if (!stack) {
      throw new Error("could not create a WebGL context while rendering the wheel poster for " + product.name + " (" + metalKey + ")");
    }
    currentStack = stack;
    return stack.ready.then(function () {
      stack.handOver({ "0": { x: sizePx / 2, y: sizePx / 2, size: sizePx, rot: 0, alpha: 1 } });
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            window.__renderReady = true;
            resolve();
          });
        });
      });
    });
  };

  // Soft contact shadow for top shots.
  function makeShadowTexture() {
    var c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    var ctx = c.getContext("2d");
    var gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, "rgba(0,0,0,0.45)");
    gradient.addColorStop(0.7, "rgba(0,0,0,0.18)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  function addShadowPlane(scene, box) {
    var sphere = box.getBoundingSphere(new THREE.Sphere());
    // Small enough that the gradient reaches zero well inside the frame: faint
    // edge alpha shows as a translucent rectangle when the top shot is composited
    // small onto the hero's hand.
    var size = sphere.radius * 1.4;
    var plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(sphere.center.x, sphere.center.y - sphere.radius, sphere.center.z);
    scene.add(plane);
    return plane;
  }

  // An invisible depth-only plane standing in for a finger: a top shot of an
  // empty ring otherwise shows its inner wall, or through gaps in the shank.
  // Cuts every model at 50% of its bounding-box height, a deliberate trade-off
  // (radius-fitted or raycast cutoffs clipped visible geometry on some models).
  // renderOrder -1 so it claims the depth buffer before the model draws.
  function addFingerOccluder(scene, box) {
    var size = new THREE.Vector3();
    box.getSize(size);
    var center = new THREE.Vector3();
    box.getCenter(center);
    var cutY = box.min.y + size.y * 0.5;
    // Oversized so the cut covers any footprint.
    var planeSize = Math.max(size.x, size.z) * 4;
    var mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(planeSize, planeSize),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: THREE.DoubleSide })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(center.x, cutY, center.z);
    mesh.renderOrder = -1;
    scene.add(mesh);
  }

  // The site's viewer, but straight down and with a contact shadow.
  window.__renderTopShot = function (product, metalKey, sizePx, hdriRelPath) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var wrap = mountTargetWrap(sizePx);
    // The product's zoom, but rotation 0 and no roll: top shots composited on
    // the hand need one canonical orientation.
    var defaultOrbit = product["3d-viewer-camera-default"] || { rotation: 0, tilt: 75, zoom: 105 };
    var zoom = typeof defaultOrbit.zoom === "number" ? defaultOrbit.zoom : 105;
    var handle = window.EmjiveModelViewer(product, metalKey, {
      transparentBackground: true,
      static: true,
      hdri: hdriRelPath,
      onReady: function () {
        // The model's own box, measured before the occluder and shadow are added.
        var modelBox = new THREE.Box3().setFromObject(handle.scene);

        // Two passes: in one pass the occluder's depth would cut a hole in the
        // shadow, and drawing the shadow in both would double-darken it. Pass 1 draws
        // the shadow alone (model on layer 1); pass 2 draws model and occluder over
        // it without clearing, the shadow hidden.
        handle.scene.traverse(function (obj) { obj.layers.set(1); });
        var shadowMesh = addShadowPlane(handle.scene, modelBox);
        handle.setCameraOrbit({ rotation: 0, tilt: 0, zoom: zoom }); // pass 1: shadow alone

        handle.scene.traverse(function (obj) { obj.layers.set(0); });
        shadowMesh.layers.set(1); // hide it again — only the model + occluder render this pass
        addFingerOccluder(handle.scene, modelBox);
        handle.renderer.autoClear = false;
        handle.renderer.render(handle.scene, handle.camera); // pass 2: model + occluder, over the shadow
        handle.renderer.autoClear = true;

        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            window.__renderReady = true;
          });
        });
      }
    });
    if (!handle) {
      throw new Error("could not create a WebGL context while rendering the top shot for " + product.name + " (" + metalKey + ")");
    }
    handle.el.id = "target";
    handle.el.style.width = "100%";
    handle.el.style.height = "100%";
    wrap.appendChild(handle.el);
    currentHandle = handle;
  };

  // One sphere under the swatch HDRI, built once through the site's viewer
  // (options.swatch); __aimSwatch changes its metal. The camera is
  // swatchOrbit("swatch-camera").
  window.__buildSwatchScene = function (sizePx, metalKey, hdriRelPath, blurPx, camera) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var wrap = mountTargetWrap(sizePx, sizePx);
    var stubProduct = {
      name: "swatch",
      "3d-viewer-camera-default": window.EmjiveModelViewer.swatchOrbit(camera)
    };
    var handle = window.EmjiveModelViewer(stubProduct, metalKey, {
      transparentBackground: true,
      static: true,
      hdri: hdriRelPath,
      environmentBlur: blurPx,
      swatch: true,
      onReady: function () {
        window.__renderReady = true;
      }
    });
    if (!handle) {
      throw new Error("could not create a WebGL context while rendering the swatches");
    }
    handle.el.id = "target";
    handle.el.style.width = "100%";
    handle.el.style.height = "100%";
    wrap.appendChild(handle.el);
    currentHandle = handle;
  };

  // setCameraOrbit() renders synchronously on a static viewer, drawing the new metal.
  window.__aimSwatch = function (metalKey, camera) {
    currentHandle.applyMetal(metalKey);
    currentHandle.setCameraOrbit(window.EmjiveModelViewer.swatchOrbit(camera));
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  };
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/__render__.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HARNESS_HTML);
        return;
      }
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
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function captureTarget(page, cssSizePx, product, metalKey, hdriRelPath) {
  await page.setViewport({ width: cssSizePx, height: cssSizePx, deviceScaleFactor: CAPTURE_SCALE });
  await page.evaluate((p, m, s, h) => window.__renderTarget(p, m, s, h), product, metalKey, cssSizePx, hdriRelPath);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  return handle.screenshot({ omitBackground: true });
}

async function writeWebp(sharpInstance, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharpInstance.webp({ quality: 92, alphaQuality: 100 }).toFile(outPath);
}

// Share of the square an icon's trimmed content fills along its longer edge.
// frameCamera() frames by bounding sphere, so on-screen fill varies per
// product; trimming and re-centring normalizes it.
const ICON_CONTENT_FRACTION = 0.8;

function normalizeIconFraming(sharpPipeline, sizePx) {
  const inner = Math.round(sizePx * ICON_CONTENT_FRACTION);
  const padLeft = Math.floor((sizePx - inner) / 2);
  const padRight = sizePx - inner - padLeft;
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  return sharpPipeline
    .trim({ threshold: 10 })
    .resize(inner, inner, { fit: "contain", background: transparent })
    .extend({ top: padLeft, bottom: padRight, left: padLeft, right: padRight, background: transparent });
}

// One capture, saved as-is for fallback-img and re-framed for the icon.
async function renderIconAndFallback(page, product, metalKey, fallbackOutPath, iconOutPath, hdriRelPath) {
  const buffer = await captureTarget(page, ICON_SIZE, product, metalKey, hdriRelPath);
  await writeWebp(sharp(buffer).resize(FALLBACK_IMG_SIZE, FALLBACK_IMG_SIZE), fallbackOutPath);
  await writeWebp(normalizeIconFraming(sharp(buffer), ICON_SIZE), iconOutPath);
}

async function renderWheelPoster(page, product, metalKey, outPath, hdriRelPath) {
  await page.setViewport({ width: WHEEL_POSTER_SIZE, height: WHEEL_POSTER_SIZE, deviceScaleFactor: WHEEL_POSTER_SCALE });
  await page.evaluate((p, m, s, h) => window.__renderWheelPoster(p, m, s, h), product, metalKey, WHEEL_POSTER_SIZE, hdriRelPath);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  const buffer = await handle.screenshot({ omitBackground: true });
  await writeWebp(sharp(buffer).resize(WHEEL_POSTER_SIZE, WHEEL_POSTER_SIZE), outPath);
}

async function captureTopShotTarget(page, cssSizePx, product, metalKey, hdriRelPath) {
  await page.setViewport({ width: cssSizePx, height: cssSizePx, deviceScaleFactor: CAPTURE_SCALE });
  await page.evaluate((p, m, s, h) => window.__renderTopShot(p, m, s, h), product, metalKey, cssSizePx, hdriRelPath);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  return handle.screenshot({ omitBackground: true });
}

async function renderTopShot(page, product, metalKey, outPath, hdriRelPath) {
  const buffer = await captureTopShotTarget(page, TOP_SHOT_SIZE, product, metalKey, hdriRelPath);
  await writeWebp(sharp(buffer).resize(TOP_SHOT_SIZE, TOP_SHOT_SIZE), outPath);
}

// One scene; only the sphere's metal changes between captures.
async function renderSwatches(page, wantedMetals, hdriRelPath, blurPx, camera) {
  await page.setViewport({ width: SWATCH_CAPTURE, height: SWATCH_CAPTURE, deviceScaleFactor: CAPTURE_SCALE });
  await page.evaluate(
    (size, m, h, b, c) => window.__buildSwatchScene(size, m, h, b, c),
    SWATCH_CAPTURE, wantedMetals[0], hdriRelPath, blurPx, camera
  );
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });

  for (const metal of wantedMetals) {
    const relPath = "assets/metal-sample_" + metal + ".webp";
    console.log("  swatch -> " + relPath);
    await page.evaluate((m, c) => window.__aimSwatch(m, c), metal, camera);
    const handle = await page.$("#target");
    const buffer = await handle.screenshot({ omitBackground: true });
    await writeWebp(sharp(buffer).resize(SWATCH_SIZE, SWATCH_SIZE), path.join(ROOT, relPath));
    // Legacy filename.
    deleteIfExists(path.join(ROOT, "assets", "metal-swatch-" + metal + ".png"));
  }
}

function slug(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, "-");
}

function deleteIfExists(absPath) {
  if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
}

// Replaces one metal's path in a product's "<blockKey>": {...} map, in the raw
// text (hand alignment survives). The product is found by "id", the map within
// its block, which runs to the next "id": (so a design entry is keyed "key",
// never "id"). null if not found (the caller warns).
function updateProductMetalFieldInText(text, product, blockKey, metal, newRelPath) {
  const idAnchor = `"id": "${product.id}"`;
  const startIdx = text.indexOf(idAnchor);
  if (startIdx === -1) return null;
  const nextIdIdx = text.indexOf('"id": "', startIdx + idAnchor.length);
  const blockEnd = nextIdIdx === -1 ? text.length : nextIdIdx;
  const block = text.slice(startIdx, blockEnd);

  const blockPattern = new RegExp(`"${blockKey}":\\s*\\{[^}]*\\}`);
  const blockMatch = block.match(blockPattern);
  if (!blockMatch) return null;
  const matchedBlock = blockMatch[0];
  const metalKeyPattern = new RegExp(`("${metal}":\\s*)"[^"]*"`);
  if (!metalKeyPattern.test(matchedBlock)) return null;
  const newMatchedBlock = matchedBlock.replace(metalKeyPattern, `$1"${newRelPath}"`);
  const newBlock = block.replace(matchedBlock, newMatchedBlock);
  return text.slice(0, startIdx) + newBlock + text.slice(blockEnd);
}

// The same for a non-default design's map, found by its "key" inside the
// product's "designs" list.
function updateDesignMetalFieldInText(text, product, designKey, blockKey, metal, newRelPath) {
  const idAnchor = `"id": "${product.id}"`;
  const productStart = text.indexOf(idAnchor);
  if (productStart === -1) return null;
  const nextIdIdx = text.indexOf('"id": "', productStart + idAnchor.length);
  const productEnd = nextIdIdx === -1 ? text.length : nextIdIdx;
  const listIdx = text.indexOf('"list": [', productStart);
  if (listIdx === -1 || listIdx > productEnd) return null;
  const keyAnchor = `"key": "${designKey}"`;
  const startIdx = text.indexOf(keyAnchor, listIdx);
  if (startIdx === -1 || startIdx > productEnd) return null;
  const nextKeyIdx = text.indexOf('"key": "', startIdx + keyAnchor.length);
  const blockEnd = nextKeyIdx === -1 || nextKeyIdx > productEnd ? productEnd : nextKeyIdx;
  const block = text.slice(startIdx, blockEnd);

  const blockPattern = new RegExp(`"${blockKey}":\\s*\\{[^}]*\\}`);
  const blockMatch = block.match(blockPattern);
  if (!blockMatch) return null;
  const metalKeyPattern = new RegExp(`("${metal}":\\s*)"[^"]*"`);
  if (!metalKeyPattern.test(blockMatch[0])) return null;
  const newBlock = block.replace(blockMatch[0], blockMatch[0].replace(metalKeyPattern, `$1"${newRelPath}"`));
  return text.slice(0, startIdx) + newBlock + text.slice(blockEnd);
}

// A product shown as one of its designs: the design's model and renders, the
// product's camera (js/series.js resolveDesign).
function designView(product, design) {
  return Object.assign({}, product, {
    assets: Object.assign({}, product.assets, {
      model: design.model,
      wireframe: design.wireframe || "",
      icons: design.icons || {},
      "fallback-img": design["fallback-img"] || {}
    }),
    geometry: design.geometry
  });
}

// A product's render folder, from the series layout (the <slug>_<category>
// convention), not from wherever its model sits.
function productFolder(seriesSlug, product) {
  return "assets/series/" + seriesSlug + "/products/" + slug(product.name) + "_" + product.category;
}

// Both drifts fail silently on the site: a series category outside the global
// vocabulary gives a dead filter button, a product outside its series'
// categories vanishes under any filter.
function warnCategoryDrift(seriesIndex, targets) {
  const vocabulary = Object.keys(seriesIndex.categories || {});
  for (const entry of seriesIndex.series) {
    for (const cat of entry.categories || []) {
      if (!vocabulary.includes(cat)) {
        console.warn(
          "  warning: series \"" + entry.slug + "\" declares category \"" + cat +
          "\" which isn't in data/series.json's top-level \"categories\""
        );
      }
    }
  }
  for (const target of targets) {
    const declared = (seriesIndex.series.find((s) => s.slug === target.slug) || {}).categories || [];
    for (const product of target.data.products) {
      if (!declared.includes(product.category)) {
        console.warn(
          "  warning: [" + target.slug + "] " + product.name + " is category \"" + product.category +
          "\", which that series doesn't declare — it won't be reachable by any filter"
        );
      }
    }
  }
}

// Checks every series, regardless of --series.
function warnHdriDrift(seriesIndex) {
  const vocabulary = Object.keys(seriesIndex.hdris || {});
  for (const entry of seriesIndex.series) {
    if (!entry.hdri || !vocabulary.includes(entry.hdri)) {
      console.warn(
        "  warning: series \"" + entry.slug + "\" declares hdri \"" + entry.hdri +
        "\" which isn't in data/series.json's top-level \"hdris\""
      );
    }
  }
}

// The swatch fields scene-tool.html writes.
function warnSwatchSceneDrift(seriesIndex) {
  const hdriVocabulary = Object.keys(seriesIndex.hdris || {});
  const swatchHdri = seriesIndex["swatch-hdri"];
  if (swatchHdri && !hdriVocabulary.includes(swatchHdri)) {
    console.warn(
      "  warning: top-level \"swatch-hdri\" is \"" + swatchHdri +
      "\" which isn't in data/series.json's top-level \"hdris\""
    );
  }
  const blur = seriesIndex["swatch-blur"];
  if (blur !== undefined && !(typeof blur === "number" && isFinite(blur) && blur >= 0)) {
    console.warn(
      "  warning: top-level \"swatch-blur\" is " + JSON.stringify(blur) +
      ", not a number of pixels (0 or more) - the swatch will render with no blur"
    );
  }
  const camera = seriesIndex["swatch-camera"];
  if (camera !== undefined && !isSwatchCamera(camera)) {
    console.warn(
      "  warning: top-level \"swatch-camera\" is " + JSON.stringify(camera) +
      ", not { rotation, tilt, roll } of numbers - the swatch will render with the default camera"
    );
  }
}

function isSwatchCamera(camera) {
  return !!camera && typeof camera === "object" &&
    ["rotation", "tilt", "roll"].every((k) => typeof camera[k] === "number" && isFinite(camera[k]));
}

async function main() {
  const args = process.argv.slice(2);
  const requestedMetals = args.filter((a) => !a.startsWith("--"));
  const seriesArg = (args.find((a) => a.startsWith("--series=")) || "").split("=")[1];
  // Product slugs, comma-separated.
  const productArg = (args.find((a) => a.startsWith("--product=")) || "").split("=")[1];
  const onlyProducts = productArg ? productArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const swatchesOnly = args.includes("--swatches-only");
  const wheelPostersOnly = args.includes("--wheel-posters-only");
  // No browser needed, nor a valid metal.
  if (args.includes("--image-variants")) {
    if (seriesArg) {
      const known = JSON.parse(fs.readFileSync(SERIES_JSON_PATH, "utf8")).series.map((s) => s.slug);
      if (!known.includes(seriesArg)) {
        throw new Error("Unknown series: " + seriesArg + " — must be one of: " + known.join(", "));
      }
    }
    console.log("auto-render --image-variants — series: " + (seriesArg || "all"));
    await makeVariants({ force: true, series: seriesArg });
    return;
  }

  const seriesIndex = JSON.parse(fs.readFileSync(SERIES_JSON_PATH, "utf8"));
  const allMetals = seriesIndex.metals || [];
  const allHdris = seriesIndex.hdris || {};
  const metals = requestedMetals.length ? requestedMetals : allMetals;

  // Missing or malformed fields fall back to the defaults, so a swatch always renders.
  const swatchHdriPath = allHdris[seriesIndex["swatch-hdri"]];
  const swatchBlur = typeof seriesIndex["swatch-blur"] === "number" && seriesIndex["swatch-blur"] > 0 ? seriesIndex["swatch-blur"] : 0;
  const swatchCamera = isSwatchCamera(seriesIndex["swatch-camera"]) ? seriesIndex["swatch-camera"] : SWATCH_CAMERA_DEFAULT;

  const unknown = metals.filter((m) => !allMetals.includes(m));
  if (unknown.length) {
    throw new Error(
      "Unknown metal(s): " + unknown.join(", ") + " — must be one of: " + allMetals.join(", ")
    );
  }

  // raw/text/data stay per file: ids are only unique within one file.
  const selected = swatchesOnly ? [] : seriesIndex.series.filter((s) => !seriesArg || s.slug === seriesArg);
  if (seriesArg && !swatchesOnly && !selected.length) {
    throw new Error(
      "Unknown series: " + seriesArg + " — must be one of: " +
      seriesIndex.series.map((s) => s.slug).join(", ")
    );
  }
  const targets = selected.map((s) => {
    const absPath = path.join(ROOT, s.products);
    const raw = fs.readFileSync(absPath, "utf8");
    return { slug: s.slug, absPath, raw, text: raw, data: JSON.parse(raw), hdri: allHdris[s.hdri] };
  });
  if (onlyProducts) {
    const known = new Set(targets.flatMap((t) => t.data.products.map((p) => slug(p.name))));
    const unknownProducts = onlyProducts.filter((p) => !known.has(p));
    if (unknownProducts.length) throw new Error("Unknown product(s): " + unknownProducts.join(", ") + " — must be among: " + [...known].join(", "));
  }

  console.log("auto-render — metal(s): " + metals.join(", ") +
    " — series: " + targets.map((t) => t.slug).join(", ") +
    (onlyProducts ? " — product(s): " + onlyProducts.join(", ") : ""));
  warnCategoryDrift(seriesIndex, targets);
  warnHdriDrift(seriesIndex);
  warnSwatchSceneDrift(seriesIndex);

  const chromePath = findChrome();
  const server = await startServer();

  const gpuArgs =
    process.platform === "win32"
      ? ["--headless=new", "--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"]
      : ["--headless=new", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: gpuArgs
  });


  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("  page error:", err.message));

    await page.goto("http://localhost:" + PORT + "/__render__.html", {
      waitUntil: "networkidle0",
      timeout: 30000
    });

    // Flags a software rasterizer (no real MSAA).
    const renderer = await page.evaluate(() => {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return null;
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    console.log("WebGL renderer: " + renderer);
    if (!renderer || /swiftshader|software/i.test(renderer)) {
      console.warn(
        "WARNING: this looks like software rendering, not a real GPU — output will still be " +
        "produced but without proper MSAA. Set CHROME_PATH to a Chrome build with GPU access if " +
        "that's unexpected."
      );
    }

    for (const metal of metals) {
      console.log("\n--- " + metal + " ---");

      for (const target of targets) {
        const rel = path.relative(ROOT, target.absPath).replace(/\\/g, "/");

        for (const product of target.data.products) {
          if (onlyProducts && !onlyProducts.includes(slug(product.name))) continue;
          const folder = productFolder(target.slug, product);

          // The model is the one asset this tool doesn't write; outside the predicted
          // folder means a renamed directory or a missed move.
          const productModel = product.assets && product.assets.model;
          if (productModel && path.dirname(productModel) !== folder) {
            console.warn(
              "  warning: [" + target.slug + "] " + product.name + "'s model is in " +
              path.dirname(productModel) + " but its renders go to " + folder
            );
          }

          const wheelRelPath = folder + "/" + slug(product.name) + "_wheel-poster_" + metal + ".webp";
          const wheelAbsPath = path.join(ROOT, wheelRelPath);

          console.log("  wheel poster: [" + target.slug + "] " + product.name + " (" + metal + ") -> " + wheelRelPath);
          await renderWheelPoster(page, product, metal, wheelAbsPath, target.hdri);

          const oldWheelRelPath = product.assets && product.assets["wheel-poster"] && product.assets["wheel-poster"][metal];
          if (oldWheelRelPath !== wheelRelPath) {
            const patched = updateProductMetalFieldInText(target.text, product, "wheel-poster", metal, wheelRelPath);
            if (patched) {
              target.text = patched;
              if (oldWheelRelPath) {
                const oldAbs = path.join(ROOT, oldWheelRelPath);
                if (path.resolve(oldAbs) !== path.resolve(wheelAbsPath)) deleteIfExists(oldAbs);
              }
            } else {
              console.warn(
                "  could not find the assets.wheel-poster." + metal + " line to update in " + rel +
                " for " + product.name + " — set it by hand: " + wheelRelPath
              );
            }
          }
          if (wheelPostersOnly) continue;

          const fallbackRelPath = folder + "/" + slug(product.name) + "_fallback-img_" + metal + ".webp";
          const fallbackAbsPath = path.join(ROOT, fallbackRelPath);
          const relOutPath = folder + "/" + slug(product.name) + "_icon_" + metal + ".webp";
          const absOutPath = path.join(ROOT, relOutPath);

          console.log("  fallback-img: [" + target.slug + "] " + product.name + " (" + metal + ") -> " + fallbackRelPath);
          console.log("  icon: [" + target.slug + "] " + product.name + " (" + metal + ") -> " + relOutPath);
          await renderIconAndFallback(page, product, metal, fallbackAbsPath, absOutPath, target.hdri);

          const oldFallbackRelPath = product.assets && product.assets["fallback-img"] && product.assets["fallback-img"][metal];
          if (oldFallbackRelPath !== fallbackRelPath) {
            const patched = updateProductMetalFieldInText(target.text, product, "fallback-img", metal, fallbackRelPath);
            if (patched) {
              target.text = patched;
              if (oldFallbackRelPath) {
                const oldAbs = path.join(ROOT, oldFallbackRelPath);
                if (path.resolve(oldAbs) !== path.resolve(fallbackAbsPath)) deleteIfExists(oldAbs);
              }
            } else {
              console.warn(
                "  could not find the assets.fallback-img." + metal + " line to update in " + rel +
                " for " + product.name + " — set it by hand: " + fallbackRelPath
              );
            }
          }

          const oldIconRelPath = product.assets && product.assets.icons && product.assets.icons[metal];
          if (oldIconRelPath !== relOutPath) {
            const patched = updateProductMetalFieldInText(target.text, product, "icons", metal, relOutPath);
            if (patched) {
              target.text = patched;
              if (oldIconRelPath) {
                const oldAbs = path.join(ROOT, oldIconRelPath);
                if (path.resolve(oldAbs) !== path.resolve(absOutPath)) deleteIfExists(oldAbs);
              }
            } else {
              console.warn(
                "  could not find the assets.icons." + metal + " line to update in " + rel + " for " +
                product.name + " — set it by hand: " + relOutPath
              );
            }
          }

          const topShotRelPath = folder + "/" + slug(product.name) + "_top-shot_" + metal + ".webp";
          const topShotAbsPath = path.join(ROOT, topShotRelPath);

          console.log("  top shot: [" + target.slug + "] " + product.name + " (" + metal + ") -> " + topShotRelPath);
          await renderTopShot(page, product, metal, topShotAbsPath, target.hdri);

          const oldTopShotRelPath = product.assets && product.assets["top-shot"] && product.assets["top-shot"][metal];
          if (oldTopShotRelPath !== topShotRelPath) {
            const patched = updateProductMetalFieldInText(target.text, product, "top-shot", metal, topShotRelPath);
            if (patched) {
              target.text = patched;
              if (oldTopShotRelPath) {
                const oldAbs = path.join(ROOT, oldTopShotRelPath);
                if (path.resolve(oldAbs) !== path.resolve(topShotAbsPath)) deleteIfExists(oldAbs);
              }
            } else {
              console.warn(
                "  could not find the assets.top-shot." + metal + " line to update in " + rel +
                " for " + product.name + " — set it by hand: " + topShotRelPath
              );
            }
          }

          // Non-default designs: icon and fallback-img from the product's camera, as
          // <product>-<design key>_... No top shot: only the default design is shown on the hand.
          const designs = product.designs;
          for (const design of (designs && designs.list) || []) {
            if (design.key === designs.default) continue;
            const base = folder + "/" + slug(product.name) + "-" + slug(design.key);
            const view = designView(product, design);
            const designFallbackRel = base + "_fallback-img_" + metal + ".webp";
            const designIconRel = base + "_icon_" + metal + ".webp";
            console.log("  design " + design.key + ": [" + target.slug + "] " + product.name + " (" + metal + ") -> " + designIconRel);
            await renderIconAndFallback(page, view, metal, path.join(ROOT, designFallbackRel), path.join(ROOT, designIconRel), target.hdri);
            for (const [field, newRel] of [["fallback-img", designFallbackRel], ["icons", designIconRel]]) {
              const oldRel = design[field] && design[field][metal];
              if (oldRel === newRel) continue;
              const patched = updateDesignMetalFieldInText(target.text, product, design.key, field, metal, newRel);
              if (patched) {
                target.text = patched;
                if (oldRel && path.resolve(path.join(ROOT, oldRel)) !== path.resolve(path.join(ROOT, newRel))) deleteIfExists(path.join(ROOT, oldRel));
              } else {
                console.warn(
                  "  could not find design " + design.key + "'s " + field + "." + metal + " line in " + rel +
                  " for " + product.name + " — set it by hand: " + newRel
                );
              }
            }
          }
        }
      }

    }

    if (!onlyProducts && !wheelPostersOnly) {
      console.log("\n--- swatches ---");
      await renderSwatches(page, metals, swatchHdriPath, swatchBlur, swatchCamera);
    }

    for (const target of targets) {
      if (target.text !== target.raw) {
        fs.writeFileSync(target.absPath, target.text, "utf8");
        console.log("\nUpdated " + path.relative(ROOT, target.absPath).replace(/\\/g, "/") +
          " asset paths.");
      }
    }

    // The new icons are the source of the 128px thumbnails.
    if (!swatchesOnly && !wheelPostersOnly) {
      console.log("\n--- icon thumbnails ---");
      await makeVariants({ force: true, kinds: ["icons"], series: seriesArg });
    }

    console.log("\nDone.");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
