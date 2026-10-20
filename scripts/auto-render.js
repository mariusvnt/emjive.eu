#!/usr/bin/env node
// Re-renders the product images and metal swatches through the site's own
// viewer code (js/three-viewer.js, js/stack-scene.js) in headless Chrome with
// a real GPU (for MSAA; the startup log names the WebGL renderer). Set
// CHROME_PATH to override the Chrome location.
//
//   node scripts/auto-render.js [metal ...] [--series=<slug>] [--product=<slug>[,<slug>]] [--swatches-only] [--wheel-posters-only] [--hand-posters-only] [--specs-posters-only] [--plan-views-only]
//   node scripts/auto-render.js --image-variants [--series=<slug>]
//
// Defaults: every metal in data/series.json, every series.
//   --product             only those products (designs included); swatches untouched
//   --swatches-only       only the metal squares
//   --wheel-posters-only  only the wheel posters
//   --hand-posters-only   only the hand posters
//   --specs-posters-only  only the specs posters
//   --plan-views-only     only the plan views
//   --image-variants      no render: rewrites the size variants (make-image-variants.js)
//
// Once per product:
//   hand-poster   512px, the ring as the wheel's own scene draws it on the hero's
//                 hand (straight down, lower half cut, x-ray look, no metal), so
//                 the swap to the live model changes nothing
//   specs-poster  512px, the product page's viewer as specs draws it (all grey,
//                 wireframe in --category-col, fitted, at the reference size),
//                 framed like fallback-img: the poster on a page opened in specs.
//                 Metal-free, so one per product and per non-default design
//   plan-views    512px each, the specs stage's top, front and side views: the
//                 model in outline, --category-col on transparent, cropped to
//                 the content of the largest of the three (one crop and scale
//                 for all, EmjiveHelpers.planFrame in js/helpers.js). Also per
//                 non-default design
// Per metal, for every product (the picker shows any metal):
//   fallback-img  512px default-orbit capture: the viewer's pre-load poster, so it
//                 must match the live framing exactly
//   icon          the same capture, trimmed and re-centred (normalizeIconFraming)
//   wheel-poster  512px, drawn by the wheel's own scene (orthographic camera,
//                 fixed environment), so the swap to the live model changes nothing
// Each non-default design gets its own icon and fallback-img. Then one 72px
// square per metal, assets/metal-sample_<metal>.webp: one sphere under the
// "swatch-hdri", blurred by "swatch-blur", from "swatch-camera" (set in
// scene-tool.html's swatch mode). products.json paths are patched in place;
// replaced files are deleted. Afterwards the icons' 128px thumbnails are rewritten.
//
// Re-run for every metal after changing "metal-shaders", the swatch camera, an
// HDRI, the "sun", the "hdri-blur" or the "reflection-detail", with
// --hand-posters-only after changing "hand-shader", and with
// --specs-posters-only after changing the blueprint look, the fit or --category-col,
// and with --plan-views-only after changing the outline look, PLAN_VIEWS,
// PLAN_PAD or --category-col.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");
const { makeVariants } = require("./make-image-variants");
const blocks = require("./json-tool-blocks");
const {
  ROOT, SERIES_JSON_PATH, readJson, repoPath, argValue, folderSlug, productFolder, isSwatchCamera,
  catalogDrift, serveStatic
} = require("./helpers");

const PORT = 5199;

const ICON_SIZE = 512;
// The pre-load poster's box (js/three-viewer.js), so it is never scaled.
const FALLBACK_IMG_SIZE = ICON_SIZE;
// The wheel and hand posters: the model's box in the wheel's maths
// (js/stack-scene.js), at the wheel renderer's MAX_PIXEL_RATIO.
const STACK_POSTER_SIZE = ICON_SIZE;
const STACK_POSTER_SCALE = 2;
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

// A minimal page loading the site's own js/helpers.js, js/three-viewer.js and
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
<script src="js/helpers.js"></script>
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
  import { toolkit } from "/js/three-viewer.js";

  window.__renderReady = false;

  // Each render builds a new viewer (a new WebGL context); dispose the previous
  // one or contexts accumulate until the browser refuses new ones.
  var currentHandle = null;
  var currentStack = null;
  var currentPlan = null;
  function disposeCurrentHandle() {
    if (currentHandle && currentHandle.renderer) currentHandle.renderer.dispose();
    currentHandle = null;
    if (currentStack) currentStack.dispose();
    currentStack = null;
    if (currentPlan) currentPlan.dispose();
    currentPlan = null;
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

  // The product page's viewer fully in specs (js/product.js): blueprint sweep
  // and fit at 1, the reference size, its wireframe drawn in.
  window.__renderSpecsPoster = function (product, sizePx, hdriRelPath, lineColor) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var wrap = mountTargetWrap(sizePx);
    var handle = window.EmjiveModelViewer(product, product["default-metal"], {
      transparentBackground: true,
      static: true,
      poster: false,
      hdri: hdriRelPath,
      blueprint: { lineColor: lineColor },
      onReady: function () {
        handle.wireframeSettled.then(function () {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              window.__renderReady = true;
            });
          });
        });
      },
      onError: function () {
        console.error("the model failed to load while rendering the specs poster for " + product.name);
      }
    });
    if (!handle) {
      throw new Error("could not create a WebGL context while rendering the specs poster for " + product.name);
    }
    handle.setBlueprint(1, 1);
    handle.setSize(1);
    handle.el.id = "target";
    handle.el.style.width = "100%";
    handle.el.style.height = "100%";
    wrap.appendChild(handle.el);
    currentHandle = handle;
  };

  // One plan view (EmjiveHelpers.PLAN_VIEWS, planFrame): the model at the
  // reference size, seen straight along the view's axis by an orthographic
  // camera framing the product's square, drawn as outlines only. A first pass
  // draws normals and depth; the second marks a pixel where, within
  // PLAN_LINE_PX, the coverage, the depth or the normal jumps (silhouettes,
  // parts in front of others, creases), so each line sits centred on its edge.
  var PLAN_LINE_PX = 3;
  var PLAN_DEPTH_JUMP = 0.012;
  var PLAN_CREASE_COS = Math.cos(50 * Math.PI / 180);
  var PLAN_EDGE_FRAGMENT = [
    "uniform sampler2D tNormal;",
    "uniform sampler2D tDepth;",
    "uniform vec2 uTexel;",
    "uniform float uRadius;",
    "uniform float uDepthJump;",
    "uniform float uCreaseCos;",
    "uniform vec3 uColor;",
    "varying vec2 vUv;",
    "void main() {",
    "  vec4 n0 = texture2D(tNormal, vUv);",
    "  float d0 = texture2D(tDepth, vUv).x;",
    "  float hits = 0.0;",
    "  float taps = 0.0;",
    "  for (int ring = 1; ring <= 2; ring++) {",
    "    float r = uRadius * float(ring) / 2.0;",
    "    for (int k = 0; k < 16; k++) {",
    "      float a = 6.2831853 * float(k) / 16.0;",
    "      vec2 uv = vUv + vec2(cos(a), sin(a)) * r * uTexel;",
    "      vec4 n1 = texture2D(tNormal, uv);",
    "      float d1 = texture2D(tDepth, uv).x;",
    "      bool edge = abs(n1.a - n0.a) > 0.5;",
    "      if (!edge && n0.a > 0.5) {",
    "        edge = abs(d1 - d0) > uDepthJump || dot(n0.xyz * 2.0 - 1.0, n1.xyz * 2.0 - 1.0) < uCreaseCos;",
    "      }",
    "      hits += edge ? 1.0 : 0.0;",
    "      taps += 1.0;",
    "    }",
    "  }",
    "  float a = smoothstep(0.0, 0.25, hits / taps);",
    "  gl_FragColor = vec4(uColor * a, a);",
    "}"
  ].join("\\n");

  window.__renderPlanView = function (product, viewName, sizePx, lineColor) {
    window.__renderReady = false;
    disposeCurrentHandle();
    var frame = window.EmjiveHelpers.planFrame(product);
    if (!frame) throw new Error(product.name + " has no geometry.axis-box: run npm run measure-models");
    var view = frame.views[viewName];
    var wrap = mountTargetWrap(sizePx);
    var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(sizePx, sizePx);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.id = "target";
    renderer.domElement.style.cssText = "display: block; width: 100%; height: 100%;";
    wrap.appendChild(renderer.domElement);
    var buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    var target = new THREE.WebGLRenderTarget(buffer.x, buffer.y, { depthTexture: new THREE.DepthTexture(buffer.x, buffer.y) });
    var normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    var colour = new THREE.Color();
    colour.setStyle(lineColor, THREE.SRGBColorSpace);
    var srgb = {};
    colour.getRGB(srgb, THREE.SRGBColorSpace);
    var edgeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tNormal: { value: target.texture },
        tDepth: { value: target.depthTexture },
        uTexel: { value: new THREE.Vector2(1 / buffer.x, 1 / buffer.y) },
        uRadius: { value: PLAN_LINE_PX * (window.devicePixelRatio || 1) / 2 },
        uDepthJump: { value: PLAN_DEPTH_JUMP },
        uCreaseCos: { value: PLAN_CREASE_COS },
        uColor: { value: new THREE.Vector3(srgb.r, srgb.g, srgb.b) }
      },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: PLAN_EDGE_FRAGMENT,
      // Written as is: premultiplied, as the canvas expects.
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false
    });
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMaterial);
    quad.frustumCulled = false;
    var quadScene = new THREE.Scene();
    quadScene.add(quad);
    var scene = new THREE.Scene();
    var root = null;
    currentPlan = {
      dispose: function () {
        if (root) root.traverse(function (node) { if (node.isMesh) node.geometry.dispose(); });
        normalMaterial.dispose();
        edgeMaterial.dispose();
        quad.geometry.dispose();
        target.depthTexture.dispose();
        target.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
      }
    };

    toolkit.loadModelFile(product.assets.model, function (gltf) {
      root = gltf.scene;
      root.traverse(function (node) { if (node.isMesh) node.material = normalMaterial; });
      scene.add(root);
      var c = new THREE.Vector3().fromArray(frame.center);
      var radius = frame.render;
      var half = frame.render / 2;
      var camera = new THREE.OrthographicCamera(-half, half, half, -half, radius, radius * 3);
      camera.position.copy(c).addScaledVector(new THREE.Vector3().fromArray(view.eye), radius * 2);
      camera.up.fromArray(view.up);
      camera.lookAt(c);
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(quadScene, camera);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          window.__renderReady = true;
        });
      });
    }, function (err) {
      console.error("the model failed to load while rendering the " + viewName + " plan view for " + product.name, err);
    });
  };

  // The model as the wheel draws it: the wheel's own scene with this one
  // product, in the middle of the box at the given pose (at rest by default).
  function renderStackPoster(product, sizePx, hdriRelPath, pose, what) {
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
      items: [{ id: "0", product: product, size: sizePx }]
    });
    if (!stack) {
      throw new Error("could not create a WebGL context while rendering the " + what + " for " + product.name);
    }
    currentStack = stack;
    return stack.ready.then(function () {
      // A model that failed to load leaves a sprite stand-in, which would be saved as the poster.
      if (product.assets && product.assets.model && !stack.drawsModel("0")) {
        throw new Error("the model failed to load while rendering the " + what + " for " + product.name);
      }
      stack.handOver({ "0": Object.assign({ x: sizePx / 2, y: sizePx / 2, size: sizePx, rot: 0, alpha: 1 }, pose) });
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            window.__renderReady = true;
            resolve();
          });
        });
      });
    });
  }

  window.__renderWheelPoster = function (product, metalKey, sizePx, hdriRelPath) {
    return renderStackPoster(Object.assign({}, product, { "default-metal": metalKey }), sizePx, hdriRelPath, {}, "wheel poster (" + metalKey + ")");
  };

  // On the hand: unturned, as a ring starting its slide off (u 0) is posed
  // (js/gallery-stack.js poseAt()). The x-ray look hides the metal.
  window.__renderHandPoster = function (product, sizePx, hdriRelPath) {
    return renderStackPoster(product, sizePx, hdriRelPath, { ring: 1, fromRing: true, ringRot: 0, u: 0 }, "hand poster");
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
      if (req.url.split("?")[0] === "/__render__.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HARNESS_HTML);
        return;
      }
      serveStatic(req, res);
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
  await page.setViewport({ width: STACK_POSTER_SIZE, height: STACK_POSTER_SIZE, deviceScaleFactor: STACK_POSTER_SCALE });
  await page.evaluate((p, m, s, h) => window.__renderWheelPoster(p, m, s, h), product, metalKey, STACK_POSTER_SIZE, hdriRelPath);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  const buffer = await handle.screenshot({ omitBackground: true });
  await writeWebp(sharp(buffer).resize(STACK_POSTER_SIZE, STACK_POSTER_SIZE), outPath);
}

async function renderHandPoster(page, product, outPath, hdriRelPath) {
  await page.setViewport({ width: STACK_POSTER_SIZE, height: STACK_POSTER_SIZE, deviceScaleFactor: STACK_POSTER_SCALE });
  await page.evaluate((p, s, h) => window.__renderHandPoster(p, s, h), product, STACK_POSTER_SIZE, hdriRelPath);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  const buffer = await handle.screenshot({ omitBackground: true });
  await writeWebp(sharp(buffer).resize(STACK_POSTER_SIZE, STACK_POSTER_SIZE), outPath);
}

// The same box and supersampling as fallback-img, so it lines up with the viewer.
async function renderSpecsPoster(page, product, outPath, hdriRelPath, lineColor) {
  await page.setViewport({ width: ICON_SIZE, height: ICON_SIZE, deviceScaleFactor: CAPTURE_SCALE });
  await page.evaluate((p, s, h, c) => window.__renderSpecsPoster(p, s, h, c), product, ICON_SIZE, hdriRelPath, lineColor);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  const buffer = await handle.screenshot({ omitBackground: true });
  await writeWebp(sharp(buffer).resize(FALLBACK_IMG_SIZE, FALLBACK_IMG_SIZE), outPath);
}

// The plan views, with the specs poster's supersampling.
const PLAN_VIEW_SIZE = ICON_SIZE;
const PLAN_VIEW_NAMES = ["top", "front", "side"];
async function renderPlanView(page, product, viewName, outPath, lineColor) {
  await page.setViewport({ width: PLAN_VIEW_SIZE, height: PLAN_VIEW_SIZE, deviceScaleFactor: CAPTURE_SCALE });
  await page.evaluate((p, v, s, c) => window.__renderPlanView(p, v, s, c), product, viewName, PLAN_VIEW_SIZE, lineColor);
  await page.waitForFunction("window.__renderReady === true", { timeout: 30000 });
  const handle = await page.$("#target");
  const buffer = await handle.screenshot({ omitBackground: true });
  // Cropped, about the centre, to the rectangle all three views share
  // (EmjiveHelpers.planFrame), so the scale is the same across them.
  const frame = await page.evaluate((p) => window.EmjiveHelpers.planFrame(p), product);
  const pxPerMm = PLAN_VIEW_SIZE / frame.render;
  const even = (mm) => 2 * Math.round(mm * pxPerMm / 2);
  const width = even(frame.crop.w);
  const height = even(frame.crop.h);
  await writeWebp(
    sharp(buffer).resize(PLAN_VIEW_SIZE, PLAN_VIEW_SIZE).extract({
      left: (PLAN_VIEW_SIZE - width) / 2, top: (PLAN_VIEW_SIZE - height) / 2, width, height
    }),
    outPath
  );
}

// The wireframe's colour on the page: --category-col in css/style.css.
function categoryColour() {
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const match = /--category-col:\s*([^;]+);/.exec(css);
  if (!match) throw new Error("no --category-col found in css/style.css (the specs poster's wireframe colour)");
  return match[1].trim();
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

function deleteIfExists(absPath) {
  if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
}

// Replaces one metal's path in the first "<blockKey>": {...} map within span,
// in the raw text (hand alignment survives). null if not found (the caller warns).
function updateMetalFieldInSpan(text, span, blockKey, metal, newRelPath) {
  if (!span) return null;
  const map = new RegExp(`"${blockKey}":\\s*\\{[^}]*\\}`).exec(text.slice(span.start, span.end));
  if (!map) return null;
  const start = span.start + map.index;
  return blocks.replaceInSpan(text, { start, end: start + map[0].length }, new RegExp(`("${metal}":\\s*)"[^"]*"`), `$1"${newRelPath}"`);
}

// A product's map: its block runs to the next "id": (so a design entry is
// keyed "key", never "id").
function updateProductMetalFieldInText(text, product, blockKey, metal, newRelPath) {
  return updateMetalFieldInSpan(text, blocks.anchoredSpan(text, "id", product.id), blockKey, metal, newRelPath);
}

// A product's single path field ("hand-poster"); null if not found.
function updateProductPathFieldInText(text, product, field, newRelPath) {
  const span = blocks.anchoredSpan(text, "id", product.id);
  return span && blocks.replaceInSpan(text, span, new RegExp(`("${field}":\\s*)"[^"]*"`), `$1"${newRelPath}"`);
}

// A product's "specs-poster", added after its "hand-poster" line if it has none
// yet; null if neither is found.
// The product's own span stops at its "designs", whose entries have their own.
function updateProductSpecsPosterInText(text, product, newRelPath) {
  const span = blocks.anchoredSpan(text, "id", product.id);
  if (!span) return null;
  const designsIdx = text.indexOf('"designs": {', span.start);
  if (designsIdx !== -1 && designsIdx < span.end) span.end = designsIdx;
  return blocks.replaceInSpan(text, span, /("specs-poster":\s*)"[^"]*"/, `$1"${newRelPath}"`) ||
    blocks.replaceInSpan(text, span, /(\n([ \t]*)"hand-poster":\s*"[^"]*",)/, `$1\n$2"specs-poster": "${newRelPath}",`);
}

// A non-default design's entry, found by its "key" inside the product's "designs" list.
function designSpanInText(text, product, designKey) {
  const productSpan = blocks.anchoredSpan(text, "id", product.id);
  if (!productSpan) return null;
  const listIdx = text.indexOf('"list": [', productSpan.start);
  if (listIdx === -1 || listIdx > productSpan.end) return null;
  return blocks.anchoredSpan(text, "key", designKey, listIdx, productSpan.end);
}

function updateDesignMetalFieldInText(text, product, designKey, blockKey, metal, newRelPath) {
  return updateMetalFieldInSpan(text, designSpanInText(text, product, designKey), blockKey, metal, newRelPath);
}

// A design's "specs-poster", added after its "fallback-img" map if it has none yet.
function updateDesignSpecsPosterInText(text, product, designKey, newRelPath) {
  const span = designSpanInText(text, product, designKey);
  if (!span) return null;
  return blocks.replaceInSpan(text, span, /("specs-poster":\s*)"[^"]*"/, `$1"${newRelPath}"`) ||
    blocks.replaceInSpan(text, span, /(\n([ \t]*)"fallback-img":\s*\{[^}]*\})/, `$1,\n$2"specs-poster": "${newRelPath}"`);
}

// The "plan-views" map, inline: { "top": ..., "front": ..., "side": ... }.
function planViewsLine(paths) {
  return "{ " + PLAN_VIEW_NAMES.map((v) => `"${v}": "${paths[v]}"`).join(", ") + " }";
}

// A product's "plan-views", added after its "specs-poster" line if it has none
// yet; null if neither is found. Same span as updateProductSpecsPosterInText.
function updateProductPlanViewsInText(text, product, paths) {
  const span = blocks.anchoredSpan(text, "id", product.id);
  if (!span) return null;
  const designsIdx = text.indexOf('"designs": {', span.start);
  if (designsIdx !== -1 && designsIdx < span.end) span.end = designsIdx;
  const line = planViewsLine(paths);
  return blocks.replaceInSpan(text, span, /("plan-views":\s*)\{[^}]*\}/, `$1${line}`) ||
    blocks.replaceInSpan(text, span, /(\n([ \t]*)"specs-poster":\s*"[^"]*",)/, `$1\n$2"plan-views": ${line},`);
}

// A design's "plan-views", added after its "specs-poster" if it has none yet.
function updateDesignPlanViewsInText(text, product, designKey, paths) {
  const span = designSpanInText(text, product, designKey);
  if (!span) return null;
  const line = planViewsLine(paths);
  return blocks.replaceInSpan(text, span, /("plan-views":\s*)\{[^}]*\}/, `$1${line}`) ||
    blocks.replaceInSpan(text, span, /(\n([ \t]*)"specs-poster":\s*"[^"]*")/, `$1,\n$2"plan-views": ${line}`);
}

// A product shown as one of its designs: the design's model and renders, the
// product's camera (js/series.js resolveDesign).
function designView(product, design) {
  return Object.assign({}, product, {
    assets: Object.assign({}, product.assets, {
      model: design.model,
      wireframe: design.wireframe || "",
      icons: design.icons || {},
      "fallback-img": design["fallback-img"] || {},
      "specs-poster": design["specs-poster"] || "",
      "plan-views": design["plan-views"] || {}
    }),
    geometry: design.geometry
  });
}

async function main() {
  const args = process.argv.slice(2);
  const requestedMetals = args.filter((a) => !a.startsWith("--"));
  const seriesArg = argValue(args, "series");
  // Product slugs, comma-separated.
  const productArg = argValue(args, "product");
  const onlyProducts = productArg ? productArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const swatchesOnly = args.includes("--swatches-only");
  const wheelPostersOnly = args.includes("--wheel-posters-only");
  const handPostersOnly = args.includes("--hand-posters-only");
  const specsPostersOnly = args.includes("--specs-posters-only");
  const planViewsOnly = args.includes("--plan-views-only");
  // No browser needed, nor a valid metal.
  if (args.includes("--image-variants")) {
    if (seriesArg) {
      const known = readJson(SERIES_JSON_PATH).series.map((s) => s.slug);
      if (!known.includes(seriesArg)) {
        throw new Error("Unknown series: " + seriesArg + " — must be one of: " + known.join(", "));
      }
    }
    console.log("auto-render --image-variants — series: " + (seriesArg || "all"));
    await makeVariants({ force: true, series: seriesArg });
    return;
  }

  const seriesIndex = readJson(SERIES_JSON_PATH);
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
    const known = new Set(targets.flatMap((t) => t.data.products.map((p) => folderSlug(p.name))));
    const unknownProducts = onlyProducts.filter((p) => !known.has(p));
    if (unknownProducts.length) throw new Error("Unknown product(s): " + unknownProducts.join(", ") + " — must be among: " + [...known].join(", "));
  }

  console.log("auto-render — metal(s): " + metals.join(", ") +
    " — series: " + targets.map((t) => t.slug).join(", ") +
    (onlyProducts ? " — product(s): " + onlyProducts.join(", ") : ""));
  // Every series' categories and HDRI, the selected series' products.
  const drift = catalogDrift(seriesIndex, Object.fromEntries(targets.map((t) => [t.slug, t.data])));
  for (const warning of drift) console.warn("  warning: " + warning);

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
    // The harness loads no js/series.js, so the viewer is handed the shaders.
    await page.evaluate((shaders) => window.EmjiveModelViewer.setMetalShaders(shaders), seriesIndex["metal-shaders"]);
    await page.evaluate((settings) => window.EmjiveModelViewer.setHandShader(settings), seriesIndex["hand-shader"]);
    await page.evaluate((settings) => window.EmjiveModelViewer.setSun(settings), seriesIndex.sun);
    await page.evaluate((deg) => window.EmjiveModelViewer.setHdriBlur(deg), seriesIndex["hdri-blur"]);
    await page.evaluate((levels) => window.EmjiveModelViewer.setReflectionDetail(levels), seriesIndex["reflection-detail"]);

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

    if (!wheelPostersOnly && !specsPostersOnly && !planViewsOnly) {
      console.log("\n--- hand posters ---");
      for (const target of targets) {
        for (const product of target.data.products) {
          if (onlyProducts && !onlyProducts.includes(folderSlug(product.name))) continue;
          if (!(product.assets && product.assets.model)) continue;
          const folder = productFolder(target.slug, product.name, product.category);
          const handRelPath = folder + "/" + folderSlug(product.name) + "_hand-poster.webp";
          const handAbsPath = path.join(ROOT, handRelPath);
          console.log("  hand poster: [" + target.slug + "] " + product.name + " -> " + handRelPath);
          await renderHandPoster(page, product, handAbsPath, target.hdri);
          const oldHandRelPath = product.assets["hand-poster"];
          if (oldHandRelPath !== handRelPath) {
            const patched = updateProductPathFieldInText(target.text, product, "hand-poster", handRelPath);
            if (patched) {
              target.text = patched;
              if (oldHandRelPath && path.resolve(path.join(ROOT, oldHandRelPath)) !== path.resolve(handAbsPath)) {
                deleteIfExists(path.join(ROOT, oldHandRelPath));
              }
            } else {
              console.warn(
                "  could not find the assets.hand-poster line to update in " + repoPath(target.absPath) +
                " for " + product.name + " — set it by hand: " + handRelPath
              );
            }
          }
        }
      }
    }

    if (!wheelPostersOnly && !handPostersOnly && !planViewsOnly) {
      console.log("\n--- specs posters ---");
      const lineColor = categoryColour();
      for (const target of targets) {
        for (const product of target.data.products) {
          if (onlyProducts && !onlyProducts.includes(folderSlug(product.name))) continue;
          if (!(product.assets && product.assets.model)) continue;
          const folder = productFolder(target.slug, product.name, product.category);
          const relPath = folder + "/" + folderSlug(product.name) + "_specs-poster.webp";
          console.log("  specs poster: [" + target.slug + "] " + product.name + " -> " + relPath);
          await renderSpecsPoster(page, product, path.join(ROOT, relPath), target.hdri, lineColor);
          const oldRelPath = product.assets["specs-poster"];
          if (oldRelPath !== relPath) {
            const patched = updateProductSpecsPosterInText(target.text, product, relPath);
            if (patched) {
              target.text = patched;
              if (oldRelPath && path.resolve(path.join(ROOT, oldRelPath)) !== path.resolve(path.join(ROOT, relPath))) {
                deleteIfExists(path.join(ROOT, oldRelPath));
              }
            } else {
              console.warn(
                "  could not find the assets.specs-poster or hand-poster line in " + repoPath(target.absPath) +
                " for " + product.name + " — set it by hand: " + relPath
              );
            }
          }

          const designs = product.designs;
          for (const design of (designs && designs.list) || []) {
            if (design.key === designs.default || !design.model) continue;
            const designRel = folder + "/" + folderSlug(product.name) + "-" + folderSlug(design.key) + "_specs-poster.webp";
            console.log("  design " + design.key + ": [" + target.slug + "] " + product.name + " -> " + designRel);
            await renderSpecsPoster(page, designView(product, design), path.join(ROOT, designRel), target.hdri, lineColor);
            const oldDesignRel = design["specs-poster"];
            if (oldDesignRel === designRel) continue;
            const patched = updateDesignSpecsPosterInText(target.text, product, design.key, designRel);
            if (patched) {
              target.text = patched;
              if (oldDesignRel && path.resolve(path.join(ROOT, oldDesignRel)) !== path.resolve(path.join(ROOT, designRel))) {
                deleteIfExists(path.join(ROOT, oldDesignRel));
              }
            } else {
              console.warn(
                "  could not find design " + design.key + "'s specs-poster or fallback-img in " + repoPath(target.absPath) +
                " for " + product.name + " — set it by hand: " + designRel
              );
            }
          }
        }
      }
    }

    if (!wheelPostersOnly && !handPostersOnly && !specsPostersOnly) {
      console.log("\n--- plan views ---");
      const lineColor = categoryColour();
      // The three views of one model as <base>_plan-<view>.webp; replaced files are deleted.
      const renderPlanViews = async (view, base, label) => {
        const paths = {};
        for (const viewName of PLAN_VIEW_NAMES) {
          paths[viewName] = base + "_plan-" + viewName + ".webp";
          console.log("  plan view: " + label + " (" + viewName + ") -> " + paths[viewName]);
          await renderPlanView(page, view, viewName, path.join(ROOT, paths[viewName]), lineColor);
        }
        return paths;
      };
      const dropReplaced = (oldPaths, paths) => {
        for (const viewName of PLAN_VIEW_NAMES) {
          const oldRel = oldPaths && oldPaths[viewName];
          if (oldRel && path.resolve(path.join(ROOT, oldRel)) !== path.resolve(path.join(ROOT, paths[viewName]))) {
            deleteIfExists(path.join(ROOT, oldRel));
          }
        }
      };
      const samePaths = (a, b) => !!a && PLAN_VIEW_NAMES.every((v) => a[v] === b[v]);
      for (const target of targets) {
        for (const product of target.data.products) {
          if (onlyProducts && !onlyProducts.includes(folderSlug(product.name))) continue;
          if (!(product.assets && product.assets.model)) continue;
          const folder = productFolder(target.slug, product.name, product.category);
          const paths = await renderPlanViews(product, folder + "/" + folderSlug(product.name), "[" + target.slug + "] " + product.name);
          const oldPaths = product.assets["plan-views"];
          if (!samePaths(oldPaths, paths)) {
            const patched = updateProductPlanViewsInText(target.text, product, paths);
            if (patched) {
              target.text = patched;
              dropReplaced(oldPaths, paths);
            } else {
              console.warn(
                "  could not find the assets.plan-views or specs-poster line in " + repoPath(target.absPath) +
                " for " + product.name + " — set it by hand: " + planViewsLine(paths)
              );
            }
          }

          const designs = product.designs;
          for (const design of (designs && designs.list) || []) {
            if (design.key === designs.default || !design.model) continue;
            const designPaths = await renderPlanViews(
              designView(product, design),
              folder + "/" + folderSlug(product.name) + "-" + folderSlug(design.key),
              "design " + design.key + ": [" + target.slug + "] " + product.name
            );
            if (samePaths(design["plan-views"], designPaths)) continue;
            const patched = updateDesignPlanViewsInText(target.text, product, design.key, designPaths);
            if (patched) {
              target.text = patched;
              dropReplaced(design["plan-views"], designPaths);
            } else {
              console.warn(
                "  could not find design " + design.key + "'s plan-views or specs-poster in " + repoPath(target.absPath) +
                " for " + product.name + " — set it by hand: " + planViewsLine(designPaths)
              );
            }
          }
        }
      }
    }

    for (const metal of handPostersOnly || specsPostersOnly || planViewsOnly ? [] : metals) {
      console.log("\n--- " + metal + " ---");

      for (const target of targets) {
        const rel = repoPath(target.absPath);

        for (const product of target.data.products) {
          if (onlyProducts && !onlyProducts.includes(folderSlug(product.name))) continue;
          const folder = productFolder(target.slug, product.name, product.category);

          // The model is the one asset this tool doesn't write; outside the predicted
          // folder means a renamed directory or a missed move.
          const productModel = product.assets && product.assets.model;
          if (productModel && path.dirname(productModel) !== folder) {
            console.warn(
              "  warning: [" + target.slug + "] " + product.name + "'s model is in " +
              path.dirname(productModel) + " but its renders go to " + folder
            );
          }

          const wheelRelPath = folder + "/" + folderSlug(product.name) + "_wheel-poster_" + metal + ".webp";
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

          const fallbackRelPath = folder + "/" + folderSlug(product.name) + "_fallback-img_" + metal + ".webp";
          const fallbackAbsPath = path.join(ROOT, fallbackRelPath);
          const relOutPath = folder + "/" + folderSlug(product.name) + "_icon_" + metal + ".webp";
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

          // Non-default designs: icon and fallback-img from the product's camera, as
          // <product>-<design key>_... No hand poster: only the default design is shown on the hand.
          const designs = product.designs;
          for (const design of (designs && designs.list) || []) {
            if (design.key === designs.default) continue;
            const base = folder + "/" + folderSlug(product.name) + "-" + folderSlug(design.key);
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

    if (!onlyProducts && !wheelPostersOnly && !handPostersOnly && !specsPostersOnly && !planViewsOnly) {
      console.log("\n--- swatches ---");
      await renderSwatches(page, metals, swatchHdriPath, swatchBlur, swatchCamera);
    }

    for (const target of targets) {
      if (target.text !== target.raw) {
        fs.writeFileSync(target.absPath, target.text, "utf8");
        console.log("\nUpdated " + repoPath(target.absPath) + " asset paths.");
      }
    }

    // The new icons are the source of the 128px thumbnails.
    if (!swatchesOnly && !wheelPostersOnly && !handPostersOnly && !specsPostersOnly && !planViewsOnly) {
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
