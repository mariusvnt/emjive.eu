/* ==========================================================================
   J&MV — shared 3D viewer construction (three.js + TrackballControls).
   Replaces the old <model-viewer>-based buildModelViewer(): same external
   contract (build a viewer for a product/metal, get back { el, applyMetal }
   plus a new setCameraOrbit for the render tooling — see
   scripts/auto-render.js), same window.EmjiveModelViewer global, so the two
   callers (js/main.js's homepage grid, js/product.js's carousel) barely
   change. The actual rotation feel — free pole-crossing rotation, release
   inertia, an idle "ease back to default pose" reset, a continuous
   up-vector leveling drift, and an idle "nudge" hint — was designed and
   tuned separately in what used to be test-viewer.html/js/test-viewer.js;
   this is that same behavior, generalized to be instanced (multiple
   simultaneous viewers on one page) and parameterized (any product, any
   container size, any camera-orbit angle) instead of hardcoded to one
   model at a fixed 420x420.

   An ES module (not a classic script like the rest of js/) specifically
   because it needs to import "three"/"three/addons/*" — Vite resolves
   these from the local npm "three" package (see dev-guidelines/tooling.md).
   js/main.js and js/product.js stay classic scripts; both only touch
   window.EmjiveModelViewer inside a fetch(...).then(...) callback, which
   always resolves after this module has finished executing and set the
   global, so there's no load-order race despite the different script
   timing (module scripts run deferred, classic scripts run inline).
   ========================================================================== */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

(function () {
  "use strict";

  // ---- Draco decoding -----------------------------------------------------
  //
  // ONE decoder instance for the whole page, shared by every viewer and
  // every GLTFLoader.load() call. This is not just a tidiness preference:
  // constructing a DRACOLoader per load is the single most-reported cause
  // of Draco failing specifically on iOS Safari (three.js#22445,
  // discourse#68835) — each instance spawns its own worker pool and its
  // own WASM heap, and iOS tears the page down long before desktop would.
  // Unlike loadEnvironment()'s PMREM texture (tied to one WebGLRenderer's
  // context), Draco decoding is plain WASM with no GPU context involved,
  // so one decoder can legitimately serve every model on the page.
  //
  // Self-hosted (not the Google CDN three.js's own examples default to) so
  // this stays a fully offline, no-external-request static site like the
  // rest of it — see assets.md for the assets/draco/ folder these three
  // files came from (verbatim, unmodified, copied from three's own npm
  // package). Only products actually using KHR_draco_mesh_compression ever
  // trigger a fetch of these; GLTFLoader ignores an attached DRACOLoader
  // entirely for a model that doesn't use the extension.
  var dracoLoader = new DRACOLoader();
  // Resolved against the document rather than left as the bare relative
  // string "assets/draco/". DRACOLoader hands these paths to a FileLoader
  // that resolves them against the *document* URL — fine today (every page
  // sits at the repo root) but silently wrong the moment a page moves into
  // a subdirectory, and wrong in a way that only shows up on Draco models.
  // new URL(..., document.baseURI) pins it once, here, instead.
  dracoLoader.setDecoderPath(new URL("assets/draco/", document.baseURI).href);
  // Default is 4. Every viewer on this site decodes exactly one model, and
  // the grid deliberately keeps only a handful alive at a time, so 4
  // workers can never be usefully busy — they'd just be 4 separate copies
  // of the Draco WASM heap (the decoder config, wasmBinary included, is
  // structured-cloned into each one). On a phone that is pure memory
  // pressure against the very budget the lazy grid exists to protect.
  // hardwareConcurrency is the usual proxy for "how much parallelism is
  // real here"; iPhones report 4-6 but have far less memory headroom than
  // that implies, so this is capped at 2 regardless.
  dracoLoader.setWorkerLimit(Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1)));

  // The decoder libraries (draco_wasm_wrapper.js + draco_decoder.wasm,
  // ~336KB together) are fetched lazily by DRACOLoader on the first decode
  // — which, left alone, lands them *inside* the first model's load, after
  // its .glb has already arrived. That's a wasted serial round trip on the
  // exact request path we care most about. Kicking preload() off as soon
  // as we know a model is coming overlaps it with the .glb fetch instead,
  // which is always the larger of the two. Guarded so a page that never
  // shows a 3D model (every page but index/product) never pays for it, and
  // so it's a no-op after the first call (preload() itself memoizes via
  // decoderPending, this just avoids the call entirely).
  var dracoPreloaded = false;
  function preloadDracoDecoder() {
    if (dracoPreloaded) return;
    dracoPreloaded = true;
    dracoLoader.preload();
  }

  // Also shared, for the same reason and with the same caveat as the
  // DRACOLoader above — a GLTFLoader holds no per-context state, so one
  // instance with the decoder attached once serves every load.
  var gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // ---- counters for the ?mem=1 overlay (js/viewer-entry.js) ---------------
  // Plain numbers and one list, kept current whether or not anything reads
  // them: what the overlay shows is what a person holding a phone with no
  // desktop inspector can read off the screen. cpuGeometryBytes is the part
  // of a live model's geometry that is still held as JavaScript typed arrays
  // (see releaseGeometryArrays below) — the figure that ought to fall back
  // towards zero once every live model has drawn its first frame.
  var liveRenderers = [];
  window.EmjiveMem = window.EmjiveMem || {};
  window.EmjiveMem.cpuGeometryBytes = 0;
  window.EmjiveMem.dracoWorkers = function () { return dracoLoader.workerPool ? dracoLoader.workerPool.length : 0; };
  window.EmjiveMem.liveRenderers = function () { return liveRenderers.length; };
  window.EmjiveMem.gpuObjects = function () {
    var geometries = 0;
    var textures = 0;
    liveRenderers.forEach(function (renderer) {
      geometries += renderer.info.memory.geometries;
      textures += renderer.info.memory.textures;
    });
    return { geometries: geometries, textures: textures };
  };

  // ---- giving the Draco workers back --------------------------------------
  // A Draco worker is a WASM heap that only ever grows, and decoding the
  // biggest model here (3.9M vertices) leaves the worker that did it holding
  // on to a heap of that order for as long as it lives — the page's whole
  // life, since nothing ever ended it. Terminating an idle worker frees the
  // heap; DRACOLoader starts a new one the next time a decode needs it.
  //
  // Not DRACOLoader.dispose(): that also revokes workerSourceURL, while the
  // loader keeps its (already resolved) decoder promise, so the next decode
  // would try to start a worker from a URL that no longer exists. Emptying
  // the pool is the whole of what is wanted. workerPool is the loader's own
  // field, hence the guard — if a later three.js renames it this becomes a
  // no-op, and the workers simply stay, as they did before.
  //
  // Delayed after the last load settles rather than run at once: a card
  // scrolled into view starts a load, and tearing the worker down between
  // two loads a second apart would pay for a new worker and a WASM compile
  // each time. Immediate when the page is hidden or going away, which is
  // when iOS is deciding what to reclaim.
  var DRACO_IDLE_RELEASE_MS = 4000;
  var modelLoadsInFlight = 0;
  var dracoReleaseTimer = 0;

  function releaseDracoWorkers() {
    clearTimeout(dracoReleaseTimer);
    dracoReleaseTimer = 0;
    if (modelLoadsInFlight > 0 || !Array.isArray(dracoLoader.workerPool)) return;
    dracoLoader.workerPool.forEach(function (worker) { worker.terminate(); });
    dracoLoader.workerPool.length = 0;
  }

  function modelLoadSettled() {
    modelLoadsInFlight--;
    if (modelLoadsInFlight === 0) {
      clearTimeout(dracoReleaseTimer);
      dracoReleaseTimer = setTimeout(releaseDracoWorkers, DRACO_IDLE_RELEASE_MS);
    }
  }

  // GLTFLoader.load, counted: the release above has to know whether a decode
  // is still running on one of the workers it would end.
  function loadModelFile(src, onLoad, onError) {
    modelLoadsInFlight++;
    clearTimeout(dracoReleaseTimer);
    dracoReleaseTimer = 0;
    gltfLoader.load(src, function (gltf) {
      modelLoadSettled();
      onLoad(gltf);
    }, undefined, function (err) {
      modelLoadSettled();
      onError(err);
    });
  }

  window.addEventListener("pagehide", releaseDracoWorkers);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") releaseDracoWorkers();
  });

  // Fallback only, now — the real per-call choice is data/series.json's
  // top-level "hdris" map, resolved by the caller (js/main.js, js/product.js,
  // or scripts/auto-render.js) and passed in as options.hdri, exactly like
  // metalKey already is. Used whenever a caller omits options.hdri (this
  // module is deliberately series-unaware, and auto-render.js's headless
  // harness never loads js/series.js at all, so it can't be resolved here).
  var DEFAULT_HDRI_SRC = "assets/hdri/studio_kontrast_04_1k.hdr";
  var DEFAULT_ORBIT = { rotation: 0, tilt: 75, zoom: 105 };
  var WORLD_UP = new THREE.Vector3(0, 1, 0);

  // PBR material presets applied to every mesh of a product's 3D model,
  // regardless of the model's own original materials/textures. Pick one
  // per product via the "default-metal" field in products.json (defaults to
  // "steel" if omitted or unrecognized). Keys here should match the
  // top-level "metals" list in products.json — that list is the source
  // of truth for which metal names are valid, so keep the two in sync.
  // The single source of truth repo-wide (scripts/auto-render.js reuses
  // this exact module, not a separate copy).
  var METAL_PRESETS = {
    steel: { baseColorFactor: [120 / 255, 120 / 255, 135 / 255, 1], metallicFactor: 1, roughnessFactor: 0.15 },
    silver: { baseColorFactor: [240 / 255, 240 / 255, 240 / 255, 1], metallicFactor: 1.0, roughnessFactor: 0.09 },
    bronze: { baseColorFactor: [255 / 255, 156 / 255, 41 / 255, 1], metallicFactor: 0.95, roughnessFactor: 0.08 }
  };

  function metalToStandardMaterialParams(metalKey) {
    var preset = METAL_PRESETS[metalKey] || METAL_PRESETS.steel;
    return {
      color: new THREE.Color(preset.baseColorFactor[0], preset.baseColorFactor[1], preset.baseColorFactor[2]),
      metalness: preset.metallicFactor,
      roughness: preset.roughnessFactor
    };
  }

  // ---- blueprint (options.blueprint — the product page's specs stage) ---
  // A horizontal cut sweeps up the model (in view space, so it is always
  // level on screen whatever the orbit): above it the metal as ever, below
  // it a flat fill the colour of the page — no lighting, no reflections —
  // drawn over by the mesh's own edges in faint black, back edges hidden.
  // Appended after <colorspace_fragment>, so uFill is an output-space
  // (sRGB) colour and lands on screen exactly as given: the filled model is
  // indistinguishable from the page behind it and only its lines read. The
  // cut itself is a thin black line while the sweep is under way.
  var BLUEPRINT_FRAGMENT = [
    "{",
    "  float bpY = -vViewPosition.y;",
    "  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFill, step( bpY, uScanY ) );",
    "  float bpPx = fwidth( bpY );",
    "  float bpCut = 1.0 - smoothstep( bpPx * 0.5, bpPx * 1.5, abs( bpY - uScanY ) );",
    "  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 0.0 ), bpCut * uScanOn );",
    "}"
  ].join("\n");
  // The edges are the real mesh's (30-80k triangles drawn a few hundred
  // pixels wide), so they have to be faint: at full black the dense parts
  // read as a solid silhouette, and even 0.22 read as charcoal. Overlapping
  // lines darken each other, which is what makes grazing angles read as
  // shading.
  var BLUEPRINT_WIRE_OPACITY = 0.1;
  // The dimension brackets, in units of the box's longest side: how far out
  // from the box the three dimension lines are pushed (BRACKET_GAP) — they
  // run along three consecutive edges of the outline of the box, which is
  // scaled up a little about its centre, so they join end to end; each label
  // sits BRACKET_LABEL_PX (screen pixels, clear of its own box) from its line.
  var BRACKET_GAP = 0.12;
  var BRACKET_LABEL_PX = 7;
  // A line shorter than this on screen (its axis pointing at the camera) has
  // no room for its label, and is hidden.
  var BRACKET_MIN_PX = 28;
  // How thick the dimension lines are, in device pixels: a plain GL line is
  // one, so half of that is a screen-space line (LineMaterial) thinner than a
  // pixel, which the multisampling draws as a fainter, finer line.
  var BRACKET_LINE_DEVICE_PX = 0.5;
  // How much better (in NDC) another run of edges has to be before the
  // brackets move to it — otherwise two near-equal candidates flicker while rotating.
  var BRACKET_HYSTERESIS = 0.06;
  // The brackets fade in over the later part of the fit.
  var BRACKET_FADE_FROM = 0.35;
  // The box the brackets measure, drawn as a faint tinted volume: its
  // opacity at full (it fades in with the brackets).
  var BOX_OPACITY = 0.07;
  // The largest size the page scales the model to (70 over its base size,
  // 62): the fit leaves room for it, so brackets never leave the canvas.
  var BLUEPRINT_SIZE_MAX = 70 / 62;
  // A length in millimetres, as the page shows it: centimetres, two places.
  function formatCm(mm) {
    return (Math.round(mm * 10 + 1e-6) / 100).toFixed(2) + " cm";
  }

  function smoothstep01(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // { rotation, tilt, zoom, roll } -> radians + a percent (100% = the
  // distance that exactly frames the model's bounding sphere for the
  // camera's fov). rotation spins left/right, tilt is up/down (90 =
  // eye-level), zoom is that same radius expressed as a percent, roll
  // spins the camera around its own view axis (0 = level) — descriptive
  // names for what used to be a single "<theta>deg <phi>deg <radius%>"
  // string (matching model-viewer's old camera-orbit attribute convention,
  // which this whole viewer replaced; roll has no equivalent there, it's
  // new). `roll` is optional and defaults to 0 — every product predating
  // it omits the field entirely, and it's still the overwhelmingly common
  // case for a new one, since most product photography wants a level
  // horizon; scene-tool.html only writes it once a free-drag has actually
  // set a nonzero one.
  function parseOrbitConfig(config) {
    var cfg = config || DEFAULT_ORBIT;
    var theta = typeof cfg.rotation === "number" ? cfg.rotation : 0;
    var phi = typeof cfg.tilt === "number" ? cfg.tilt : 75;
    var radiusPercent = typeof cfg.zoom === "number" ? cfg.zoom : 105;
    var roll = typeof cfg.roll === "number" ? cfg.roll : 0;
    return {
      thetaRad: (theta * Math.PI) / 180,
      phiRad: (phi * Math.PI) / 180,
      radiusPercent: radiusPercent,
      rollRad: (roll * Math.PI) / 180,
      // Optional [x, y, z] to orbit instead of the model's own centre —
      // only the swatch scene uses it (swatchOrbit), to aim at one sphere.
      target: Array.isArray(cfg.target) ? new THREE.Vector3(cfg.target[0], cfg.target[1], cfg.target[2]) : null,
      // Optional vertical fov in degrees (same user: the swatch, whose frame
      // is solved from the sphere's disc). null leaves the camera's own.
      fov: typeof cfg.fov === "number" ? cfg.fov : null
    };
  }

  // The resting "up" for a given eye direction: WORLD_UP's component
  // perpendicular to eyeDir (the level up at that position), spun around
  // eyeDir by rollRad. Left unnormalized on purpose — its length is the
  // sine of the eye's angle from the pole, which is exactly the fade the
  // leveling drift wants (see the animate loop), and it degenerates to
  // zero at the poles rather than to NaN. frameCamera() and the idle
  // nudge normalize it; the drift uses it raw.
  function restUpRaw(out, eyeDir, rollRad) {
    out.copy(WORLD_UP).addScaledVector(eyeDir, -WORLD_UP.dot(eyeDir));
    return out.applyAxisAngle(eyeDir, rollRad);
  }

  // The metal swatches (scene-tool.html's swatch mode, and
  // scripts/auto-render.js's swatch renderer): ONE scene holding a single
  // sphere in the middle, lit by an HDRI like any product, in place of a
  // loaded GLTF model. Every swatch is that scene seen from the same camera,
  // with the sphere's material changed between renders (applyMetal(), like any
  // other viewer) — so the camera, the sphere and the HDRI are the same in all
  // of them and only the metal differs. No material is set here:
  // applyMaterial()'s mesh traversal (below) gives the sphere the current metal.
  var SWATCH_SPHERE_RADIUS = 1;
  // How far the camera stands from the sphere's centre, in the sphere's radii:
  // a mild perspective (the disc seen is that of a sphere 12 radii away).
  var SWATCH_DISTANCE = 12;

  function buildSwatchStack() {
    var group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.SphereGeometry(SWATCH_SPHERE_RADIUS, 96, 64)));
    return group;
  }

  // The sphere's bounding-sphere radius as frameCamera() measures it: that of
  // its bounding BOX (half the box's diagonal), which is sqrt(3) radii.
  var SWATCH_GROUP_RADIUS = Math.sqrt(3) * SWATCH_SPHERE_RADIUS;

  // The camera, for the angles anyone gets to choose — `angles` is
  // { rotation, tilt, roll } in degrees (data/series.json's "swatch-camera"),
  // the same three the product cameras have: where the camera stands round the
  // sphere (rotation: round the vertical axis; tilt: 90 is eye level, 0 is
  // straight above; roll: the turn of the picture), always looking at its
  // centre. Missing ones are 0, 90 and 0 — straight in front, eye level.
  // The rest is solved: the camera stands SWATCH_DISTANCE radii away, with a
  // frame that is the BIGGEST SQUARE INSIDE THE DISC the sphere shows from
  // there (the same from every angle, a sphere being round). Seen from
  // distance d the sphere's silhouette is a circle of angular radius
  // a = asin(r / d) — on the image plane at unit distance, radius tan(a). A
  // square inscribed in a circle has its corners on it: its half-diagonal is
  // tan(a), its half-side tan(a) / sqrt(2), and a square frame (aspect 1) has
  // that half-side at tan(fov / 2). So
  //   fov = 2 * atan(tan(asin(r / d)) / sqrt(2)).
  // frameCamera() puts the camera at sphereRadius / sin(fov / 2) * zoom / 100
  // from the target, so the zoom that makes that distance d is
  // d * sin(fov / 2) / sphereRadius.
  function swatchOrbit(angles) {
    var a = angles || {};
    var d = SWATCH_DISTANCE * SWATCH_SPHERE_RADIUS;
    var halfFov = Math.atan(Math.tan(Math.asin(SWATCH_SPHERE_RADIUS / d)) / Math.SQRT2);
    return {
      rotation: typeof a.rotation === "number" ? a.rotation : 0,
      tilt: typeof a.tilt === "number" ? a.tilt : 90,
      roll: typeof a.roll === "number" ? a.roll : 0,
      zoom: (100 * d * Math.sin(halfFov)) / SWATCH_GROUP_RADIUS,
      target: [0, 0, 0],
      fov: (2 * halfFov * 180) / Math.PI
    };
  }

  function parseTargetString(str) {
    if (!str) return null;
    var parts = str.trim().split(/\s+/).map(parseFloat);
    if (parts.length < 3 || parts.some(function (n) { return isNaN(n); })) return null;
    return new THREE.Vector3(parts[0], parts[1], parts[2]);
  }

  // Standard parametric cubic-bezier evaluator (control points (x1,y1)/(x2,y2),
  // implicit endpoints (0,0)/(1,1)) — Newton-Raphson to solve for the curve
  // parameter at a given time-fraction x, same approach browsers use for CSS's
  // own cubic-bezier() timing functions.
  function cubicBezierEase(t, x1, y1, x2, y2) {
    function componentAt(u, a, b) {
      var v = 1 - u;
      return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
    }
    var u = t;
    for (var i = 0; i < 8; i++) {
      var x = componentAt(u, x1, x2) - t;
      var dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(dx) < 1e-6) break;
      u = Math.max(0, Math.min(1, u - x / dx));
    }
    return componentAt(u, y1, y2);
  }

  // Spherical linear interpolation between two unit vectors. Unlike
  // lerpVectors+normalize (nlerp), this sweeps at constant angular velocity
  // and doesn't pass close to the origin for large-angle/near-antipodal
  // pairs — needed because free-spinning across a pole can leave the
  // camera almost anywhere before a rollback has to reorient it.
  function slerpVectors(out, a, b, t) {
    var cosTheta = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    var theta = Math.acos(cosTheta);
    if (theta < 1e-4) return out.copy(b);
    var sinTheta = Math.sin(theta);
    if (sinTheta < 1e-4) return out.lerpVectors(a, b, t).normalize();
    return out
      .copy(a)
      .multiplyScalar(Math.sin((1 - t) * theta) / sinTheta)
      .addScaledVector(b, Math.sin(t * theta) / sinTheta);
  }

  // ---- HDRI environment, loaded fresh for every viewer instance. NOT
  // cached/shared across instances despite two instances often using the
  // same source file (any two viewers showing series that picked the same
  // hdris key): a PMREMGenerator's output texture is a GPU resource tied
  // to the specific WebGLRenderer/context that built it, and every
  // buildThreeViewer() call constructs its own renderer. A cross-instance
  // cache (an earlier version of this file had one, keyed only on the
  // source file, not the renderer) silently handed later instances a
  // texture handle from a DIFFERENT context — invalid there, and since
  // this scene has zero THREE.Light objects (lighting is 100% via
  // scene.environment), every mesh's PBR shading collapsed to solid black
  // for every viewer except whichever one happened to build the cached
  // texture first. Reproduced concretely on the homepage grid (several
  // simultaneous instances, several real WebGL contexts) — a single page
  // with only one viewer (e.g. product.html's carousel) never showed it,
  // since there's only ever one context for the cache to coincidentally
  // "work" against there. Loading it per-instance means the homepage
  // grid's several simultaneous viewers each independently fetch+decode
  // the HDRI and run PMREM generation — a modest, one-time-per-instance
  // cost (not a per-frame one), and normal HTTP caching keeps the repeat
  // fetches of the same file cheap after the first.
  //
  // hdriSrc is the caller-resolved path (data/series.json's "hdris" map,
  // looked up via that series' "hdri" key — see js/series.js's hdriPath()),
  // falling back to DEFAULT_HDRI_SRC when omitted or unresolved.
  // The PIXELS, though, are plain CPU-side data with no context affinity at
  // all — and decoding a 2K RGBE .hdr into half-floats is genuinely
  // expensive main-thread work (tens of ms), which the comment above was
  // quietly signing every viewer up to repeat from scratch. This caches the
  // decode (and the fetch) per source file, keyed on the URL and shared by
  // an in-flight promise so N simultaneous viewers asking for the same HDRI
  // during one scroll trigger exactly one decode between them. Each viewer
  // still gets its own throwaway DataTexture wrapper around that one shared
  // pixel buffer, so the per-renderer GPU upload/dispose lifecycle below is
  // exactly what it was before — only the redundant decoding is gone. A
  // failed load evicts its own entry so a later viewer can retry rather
  // than inheriting a permanently-rejected promise.
  var hdrSourceCache = {};
  var hdrLoadsInFlight = 0;

  // three's loaders take no AbortSignal, so a request that stalls (rather
  // than fails) would leave a viewer waiting forever with nothing to fall
  // back on. Rejecting after this long hands it to the same error path a
  // failed request takes; the stalled download itself is simply abandoned.
  // Generous: the biggest single file is a ~4MB model on a slow mobile link.
  var LOAD_TIMEOUT_MS = 90000;

  // ---- decoding off the main thread ------------------------------------
  //
  // The file is downloaded here (that is the request the page's own preload
  // of it is matched against) and decoded by js/hdr-worker.js, which hands the
  // half-float pixels back. Used only where Vite has bundled this module:
  // `import.meta.env` is undefined on a page that loads it unbundled
  // (scene-tool.html, the render harness), where a module worker could not
  // resolve `three` through the import map anyway. Any failure — no module
  // workers, the worker script missing, a decode error — falls back to
  // decoding on the main thread with HDRLoader.parse(), the same function the
  // worker runs, so the result is identical either way.
  var hdrWorker = null;
  var hdrWorkerBroken = typeof Worker !== "function" || typeof import.meta.env === "undefined";
  var hdrJobs = {};
  var hdrJobCount = 0;

  function retireHdrWorker() {
    hdrWorkerBroken = true;
    if (hdrWorker) {
      try { hdrWorker.terminate(); } catch (err) { /* already gone */ }
      hdrWorker = null;
    }
    var jobs = hdrJobs;
    hdrJobs = {};
    Object.keys(jobs).forEach(function (id) { jobs[id].fail(); });
  }

  function getHdrWorker() {
    if (hdrWorkerBroken) return null;
    if (!hdrWorker) {
      try {
        hdrWorker = new Worker(new URL("./hdr-worker.js", import.meta.url), { type: "module" });
      } catch (err) {
        hdrWorkerBroken = true;
        return null;
      }
      hdrWorker.onmessage = function (event) {
        var job = hdrJobs[event.data.id];
        if (!job) return;
        delete hdrJobs[event.data.id];
        if (event.data.error) job.fail();
        else job.done(event.data);
      };
      hdrWorker.onerror = retireHdrWorker;
    }
    return hdrWorker;
  }

  // The parsed file as the plain object loadEnvironment() reads (it only
  // ever uses these fields; a DataTexture is made per renderer from them).
  function hdrSource(parsed) {
    return {
      image: { data: parsed.data, width: parsed.width, height: parsed.height },
      format: THREE.RGBAFormat,
      type: parsed.type,
      colorSpace: parsed.colorSpace,
      minFilter: parsed.minFilter,
      magFilter: parsed.magFilter,
      generateMipmaps: parsed.generateMipmaps,
      flipY: parsed.flipY
    };
  }

  function decodeHdr(buffer) {
    var worker = getHdrWorker();
    if (!worker) return Promise.resolve(hdrSource(new HDRLoader().parse(buffer)));
    return new Promise(function (resolve) {
      var id = ++hdrJobCount;
      hdrJobs[id] = {
        done: function (parsed) { resolve(hdrSource(parsed)); },
        fail: function () { resolve(hdrSource(new HDRLoader().parse(buffer))); }
      };
      // Copied, not transferred: if the worker can't do it the buffer is
      // still here for the fallback above.
      worker.postMessage({ id: id, buffer: buffer });
    });
  }

  function loadHdrSource(src) {
    if (!hdrSourceCache[src]) {
      hdrLoadsInFlight++;
      hdrSourceCache[src] = new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error("Timed out loading " + src)); }, LOAD_TIMEOUT_MS);
        var fileLoader = new THREE.FileLoader();
        fileLoader.setResponseType("arraybuffer");
        fileLoader.load(src, function (buffer) {
          decodeHdr(buffer).then(function (source) {
            clearTimeout(timer);
            resolve(source);
          }, function (err) {
            clearTimeout(timer);
            reject(err);
          });
        }, undefined, function (err) {
          clearTimeout(timer);
          reject(err);
        });
      }).then(
        function (texture) {
          hdrLoadsInFlight--;
          return texture;
        },
        function (err) {
          hdrLoadsInFlight--;
          // Evicted so a later viewer can retry rather than inheriting a
          // permanently-rejected promise.
          delete hdrSourceCache[src];
          throw err;
        }
      );
    }
    return hdrSourceCache[src];
  }

  // What this cache actually costs is invisible in a heap profile, because a
  // DataTexture's pixels live in an external ArrayBuffer rather than the JS
  // heap: Bones' studio_kontrast_04_1k.hdr is 1.4MB on the wire and decodes
  // to 1024 x 512 half-float RGBA — ~4.2MB — held at module scope for the
  // life of the document. (Both figures were 4x larger before
  // `npm run optimize-hdri` halved the source to 1k; the cache mattered
  // proportionally more then, and still earns its keep.) Worth every byte
  // while viewers are being built and
  // rebuilt during a scroll (it's what stops N simultaneous viewers decoding
  // the same file N times), and worth nothing at all once the page is frozen
  // or backgrounded, which on iOS is precisely when the memory is wanted
  // elsewhere. Rebuilding it costs one re-decode on the next viewer built
  // after the visitor returns, by which point they're looking at an icon
  // fading into a model anyway.
  //
  // Guarded on in-flight loads rather than cancelling them: clearing the map
  // mid-load doesn't stop the decode (its awaiters hold the promise
  // directly), it just guarantees the next caller starts a second one.
  function releaseHdrSources() {
    if (hdrLoadsInFlight > 0) return;
    hdrSourceCache = {};
  }

  window.addEventListener("pagehide", releaseHdrSources);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") releaseHdrSources();
  });

  // isStale() is the viewer asking "were you torn down while this loaded?".
  // A card scrolled past mid-load has already had its renderer released and
  // its context force-lost; building the environment on it anyway is a PMREM
  // render into a dead context — wasted work, a "Context Lost" warning, and a
  // render target allocated only to be freed a moment later. Resolves to null
  // then, and the caller has nothing to attach.
  // blurPx (optional, 0 or missing: none — every product): a gaussian blur of
  // the HDRI itself, its sigma in pixels of the HDRI image (the swatch scene's
  // "swatch-blur"). PMREMGenerator.fromEquirectangular() has no blur, so
  // then the HDRI is the background of a throwaway scene and goes through
  // fromScene(), which blurs by a sigma in radians before it prefilters.
  function loadEnvironment(renderer, hdriSrc, isStale, blurPx) {
    var src = hdriSrc || DEFAULT_HDRI_SRC;
    var pmremGenerator = new THREE.PMREMGenerator(renderer);
    // Synchronous, so a throw here would escape as an exception out of the
    // viewer's constructor instead of the rejected promise every other
    // failure in this chain becomes — leaving the renderer (and its WebGL
    // context) behind. Turn it into the same rejection.
    try {
      pmremGenerator.compileEquirectangularShader();
    } catch (err) {
      pmremGenerator.dispose();
      console.error("emjive: failed to prepare the HDRI environment", err);
      return Promise.reject(err);
    }
    return loadHdrSource(src).then(
      function (sourceTexture) {
        if (isStale && isStale()) {
          pmremGenerator.dispose();
          return null;
        }
        // A fresh DataTexture per call, sharing sourceTexture's pixel
        // buffer by reference rather than copying it. It exists only long
        // enough for PMREM to upload it into THIS renderer's context and
        // is disposed immediately after — disposing a DataTexture frees
        // the GPU copy, never the JS typed array behind it, so the cached
        // source survives untouched for the next viewer.
        var image = sourceTexture.image;
        var equirect = new THREE.DataTexture(image.data, image.width, image.height, sourceTexture.format, sourceTexture.type);
        equirect.colorSpace = sourceTexture.colorSpace;
        equirect.magFilter = sourceTexture.magFilter;
        equirect.minFilter = sourceTexture.minFilter;
        equirect.generateMipmaps = sourceTexture.generateMipmaps;
        equirect.flipY = sourceTexture.flipY;
        equirect.needsUpdate = true;

        // The whole render target, not just its .texture. PMREMGenerator
        // hands ownership of the target to the caller — pmremGenerator
        // .dispose() below frees only the generator's own scratch
        // resources — so disposing the texture alone would leave the
        // target's framebuffer behind with nothing holding a reference
        // that could ever free it.
        var renderTarget;
        if (blurPx > 0) {
          // A full turn of longitude is image.width pixels. The cube faces
          // are a quarter of that wide, as fromEquirectangular() makes them.
          equirect.mapping = THREE.EquirectangularReflectionMapping;
          var blurScene = new THREE.Scene();
          blurScene.background = equirect;
          renderTarget = pmremGenerator.fromScene(blurScene, (blurPx * 2 * Math.PI) / image.width, 0.1, 100, { size: Math.max(64, image.width / 4) });
        } else {
          renderTarget = pmremGenerator.fromEquirectangular(equirect);
        }
        equirect.dispose();
        pmremGenerator.dispose();
        return renderTarget;
      },
      // Without this, a failed HDRI request (network blip, server hiccup)
      // left this promise neither resolved nor rejected —
      // Promise.all([modelPromise, environmentPromise]) below then hung
      // forever with zero console output, so the model silently never
      // appeared and there was no way to tell why. Rejecting here at least
      // surfaces the failure and lets it fall through to the same "poster
      // stays as the fallback" behavior a model-load failure already gets.
      function (err) {
        pmremGenerator.dispose();
        console.error("emjive: failed to load HDRI environment", src, err);
        throw err;
      }
    );
  }

  // ---- session-wide idle-nudge suppression: once the visitor has really
  // dragged any one viewer (this page, or an earlier one this session),
  // every viewer's idle "nudge" hint stops scheduling itself — they've
  // already learned it's draggable. sessionStorage (not localStorage) so
  // it's remembered for revisits within the same browsing session but
  // doesn't permanently disable it for a brand new visit days later. ----
  var INTERACTION_SEEN_KEY = "emjive_model_interacted";
  var interactionSuppressed = false;
  try {
    interactionSuppressed = sessionStorage.getItem(INTERACTION_SEEN_KEY) === "1";
  } catch (e) {
    // sessionStorage unavailable (private browsing, etc.) — just falls
    // back to per-page-load behavior instead of remembering across nav.
  }
  // Every LIVE viewer's cancelNudge, so the first real drag anywhere can
  // silence the hint everywhere at once. Entries MUST be removed on
  // dispose() — see unregisterCancelNudge below. A cancelNudge is a
  // closure over its whole buildThreeViewer() invocation, so holding one
  // holds that viewer's scene, renderer and fully decoded model geometry
  // with it; while this array only ever grew, every viewer the homepage
  // grid had ever built stayed in memory for the life of the page, however
  // diligently dispose() freed its GPU-side resources. Measured on the
  // Bones grid, that was ~1GB of unreclaimable JS heap per three passes of
  // scrolling the page end to end — a straight line up until the tab died,
  // which on iOS Safari means the page reloading itself.
  var allCancelNudgeFns = [];

  function unregisterCancelNudge(cancel) {
    var i = allCancelNudgeFns.indexOf(cancel);
    if (i !== -1) allCancelNudgeFns.splice(i, 1);
  }

  function suppressNudgeEverywhere() {
    interactionSuppressed = true;
    // Copied before iterating: a cancel() implementation is free to
    // unregister itself, which would otherwise shift the array out from
    // under this loop and skip entries.
    allCancelNudgeFns.slice().forEach(function (cancel) {
      cancel();
    });
    try {
      sessionStorage.setItem(INTERACTION_SEEN_KEY, "1");
    } catch (e) {
      // Ignore — worst case it just won't be remembered on the next page.
    }
  }

  var POST_INERTIA_PAUSE = 420; // ms of stillness once it's actually stopped, before easing back
  var ROLLBACK_DURATION = 1200; // ms
  var ROLLBACK_BEZIER = [0.65, 0, 0.35, 1]; // gentle at both ends, unhurried
  var IDLE_NUDGE_DELAY = 3000; // ms of no interaction before the nudge plays
  // The nudge replays every IDLE_NUDGE_DELAY until the visitor drags, and it
  // takes ~3.6s to play — so a live viewer that is never touched redraws its
  // whole model for more than half of its life. On the gallery that is every
  // live card at once. A touch device has a thermal and memory budget to
  // protect and a visitor who learns "it turns" from the first showing, so
  // there the hint plays this many times per viewer and then rests (a
  // mouse keeps the endless version).
  var NUDGE_MAX_PLAYS_TOUCH = 2;
  var touchDevice = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  var NUDGE_ANGLE_RAD = (15 * Math.PI) / 180;
  var HAND_OFFSETS = [0, -40, 40]; // px, index-matched to the 3 nudge waypoints
  var DRIFT_RATE = 1.5; // 1/second, continuous up-leveling rate
  var SETTLE_ANGULAR_VELOCITY = 0.024; // rad/s treated as "spin has stopped"
  var REF_DT = 1 / 60;
  // Progressive-braking tuning: plain exponential decay (a single constant
  // lambda) keeps slowing at the same PROPORTIONAL rate forever, which
  // means its absolute motion gets imperceptibly slow well before it's
  // actually at rest — reads as trailing off rather than stopping. Below
  // PROGRESSIVE_BOOST_SPEED (rad/s), lambda ramps up smoothly toward
  // PROGRESSIVE_BOOST_MAX times its baseline value as speed approaches
  // zero, so the last bit of a spin brakes harder and stops crisply
  // instead of coasting forever. At/above this speed, feel is unchanged.
  var PROGRESSIVE_BOOST_SPEED = 0.5; // rad/s
  var PROGRESSIVE_BOOST_MAX = 4;

  // ---- prefers-reduced-motion -------------------------------------------
  //
  // Held as a live MediaQueryList rather than read once into a boolean.
  // Every site that reads it below already runs per-frame (the animate
  // loop) or per-timer (scheduleIdleNudge), so `.matches` gets re-evaluated
  // naturally and an OS-level toggle takes effect on the next frame — with
  // no `change` listener to register, to remember to remove in dispose(),
  // or to leak a closure over an entire viewer (scene, renderer, decoded
  // model) the way allCancelNudgeFns once did.
  //
  // Deliberately module-scope here rather than a shared window.EmjiveMotion
  // on js/series.js, and not for tidiness: this module is also loaded by
  // scene-tool.html, which loads no js/series.js at all. A shared helper
  // would be undefined there, so this file would need the query locally
  // regardless — and it is the only JS on the site that needs it, since
  // every other piece of motion is a CSS transition the stylesheet's own
  // reduced-motion block already covers. See css/style.css.
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Builds a three.js viewer for a product and returns a handle so callers
  // (the homepage grid, and the product detail page's carousel) can swap
  // its metal finish later without reloading the .glb or losing whatever
  // camera angle the visitor left it at. Exposed as window.EmjiveModelViewer
  // at the bottom of this file. `options.onReady` fires once after the model
  // has loaded, been framed to its default pose, and painted one frame —
  // for scripts/auto-render.js's render harness it's the direct replacement
  // for the old model-viewer harness's `load` event + `jumpCameraToGoal()` +
  // settle-frame wait; js/main.js's grid uses the same hook to time its
  // icon -> model crossfade off the real "there is something to see now"
  // moment. `options.onError` is its counterpart for a model/HDRI that
  // never arrives, so a caller can restore its own fallback instead of
  // leaving an empty box.
  function buildThreeViewer(product, metalKey, options) {
    options = options || {};
    // `transparentBackground`/`static` only exist for
    // scripts/auto-render.js's render harness — never set by the
    // interactive site. `static` skips the idle-nudge hint and the
    // continuous animate loop entirely (only explicit render() calls, from
    // the initial load and from setCameraOrbit()), so nothing can shift
    // the framing between the harness's onReady firing and its screenshot
    // actually being taken a few ms later.
    var isStatic = !!options.static;
    // Tool-only (scene-tool.html), never set by the interactive site or by
    // scripts/auto-render.js's harness. Wants the OPPOSITE trade-off from
    // `static`: full interactive dragging (unlike static, which never
    // starts the animate loop at all, so a drag would be visually dead),
    // but with the two "auto-correcting" behaviors below (release inertia,
    // the ease-back-to-default reset) switched off — the whole point is
    // manually setting a pose and having it stay exactly there so it can
    // be read back and saved, roll included (see frameCamera()'s `roll`
    // handling, and readCurrentOrbit() in scene-tool.html).
    var isFreeOrbit = !!options.freeOrbit;
    // prefers-reduced-motion turns out to want exactly the same four
    // behaviors off that freeOrbit does — release inertia, the
    // ease-back-to-default pose reset, the continuous up-vector leveling
    // drift, and the idle nudge — so they share one predicate rather than
    // growing a parallel set of conditions. The two arrive at it for
    // different reasons: freeOrbit wants a pose to STAY put so the tool can
    // read it back and save it; reduced motion wants nothing to move that
    // the visitor didn't move themselves.
    //
    // What neither disables is dragging. That's visitor-initiated, so it
    // isn't what the media query is about, and a model you can't turn is a
    // product you can't see. The reset in particular is SKIPPED rather than
    // applied instantly: snapping the camera home the moment a spin settles
    // is an unrequested view change, which for a vestibular-sensitive
    // visitor is worse than simply leaving the model where they put it.
    //
    // A function, not a boolean captured here, so the media query stays
    // live — see `reducedMotion`'s own comment at module scope.
    function noAutoMotion() {
      return isFreeOrbit || reducedMotion.matches;
    }
    // `transparentBackground` used to also gate the renderer's own alpha
    // (the interactive site rendered opaque, near-black, on purpose — see
    // git history) but that traded a real bug (a solid black square behind
    // every model until/unless it exactly fills its frame) for a subtler
    // one (semi-transparent edge pixels reading slightly off under ACES
    // tone mapping when later composited over a page background). The
    // black square is worse, so both the interactive site and the render
    // harness (scripts/auto-render.js) now render with a genuinely
    // transparent canvas; this flag is kept only to gate
    // `preserveDrawingBuffer`, still harness-only — needed for an
    // external screenshot readback of the canvas; the interactive site
    // never reads its own canvas back.
    var preserveBuffer = !!options.transparentBackground;
    // js/product.js only: { fill: "<the page's background colour>" }. Turns
    // on the metal -> wireframe sweep, the dimension brackets and the fit
    // scale behind them, all driven by handle.setBlueprint(sweep, fit);
    // 0, 0 (where it starts) draws exactly what a viewer without it does.
    var blueprint = options.blueprint && !options.swatch ? options.blueprint : null;

    var wrapper = document.createElement("div");
    wrapper.className = "emjive-3d-viewer";
    // The canvas is the whole of it and has no text of its own: without a
    // name a screen reader meets an unlabelled graphic. role="img" presents
    // the viewer as one named picture (the product's), which is what it is
    // to a visitor who can't see it; dragging it is a pointer-only extra.
    wrapper.setAttribute("role", "img");
    wrapper.setAttribute("aria-label", ((product && product.name) || "Product") + ", 3D model");

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: preserveBuffer
      });
    } catch (err) {
      // A browser's per-page WebGL context budget is finite — once it's
      // exhausted (several simultaneous viewers, bfcache-retained
      // contexts from earlier navigations, a weak/mobile GPU), this
      // constructor throws synchronously. Left uncaught, this used to
      // blow up the caller's whole products.forEach loop (js/main.js)
      // mid-iteration, silently dropping every remaining product — no
      // model AND no icon fallback, since callers only build the icon
      // fallback when this function returns null, not when it throws.
      // Returning null instead lets both js/main.js and js/product.js
      // fall back to the plain icon image, same as a product with no
      // "model" field at all.
      console.error("emjive: could not create a WebGL context for", product.name, err);
      return null;
    }
    liveRenderers.push(renderer);
    // Canvas backing-store memory is width * height * pixelRatio^2 * 4
    // bytes, doubled again by antialias: true's multisample buffer — and
    // iOS Safari enforces a hard TOTAL canvas budget across the whole
    // page, not a per-canvas one, killing the tab ("A problem repeatedly
    // occurred") once every canvas added together crosses it. The homepage
    // grid is the only place several viewers are alive at once, so it's
    // the only caller that lowers this (see js/main.js); a phone's DPR 3
    // capped at 2 still meant each card carried 2.25x the pixels of a
    // DPR-1.5 one, for a ~400px box where the difference is invisible.
    var maxPixelRatio = typeof options.maxPixelRatio === "number" ? options.maxPixelRatio : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    // The blueprint's edges are clipped to below the sweep's cut (a
    // per-material clipping plane), which three only honours with this on.
    if (blueprint) renderer.localClippingEnabled = true;
    renderer.domElement.className = "emjive-3d-viewer__canvas";
    wrapper.appendChild(renderer.domElement);

    // Poster only matters pre-load, so this is fixed to whatever metal the
    // viewer is being built for — never needs to change after (by the time
    // a visitor could switch metals in the picker, the real model has
    // already loaded and the poster is long gone). Uses fallback-img, not
    // icons — icons is cropped/re-centered for use as a flat thumbnail
    // elsewhere (see js/main.js, js/product.js) and doesn't match the
    // model's actual default framing, which produced a visible "jump" the
    // instant the real model swapped in. fallback-img is the model's own
    // default-orbit capture saved as-is (see scripts/auto-render.js), so it
    // lines up with the live canvas's first frame instead.
    // options.poster: false opts out entirely — for a caller that already
    // has its own image sitting behind the viewer and does its own
    // crossfade (js/main.js's grid cards, where the card's icon is already
    // on screen). Running both there would mean fading the model in over a
    // poster that's simultaneously fading out over the icon: three images
    // of the same ring, two of them semi-transparent, for half a second.
    var posterEl = null;
    var posterSrc = options.poster === false
      ? null
      : product.assets && product.assets["fallback-img"] && product.assets["fallback-img"][metalKey];
    if (posterSrc) {
      posterEl = document.createElement("img");
      posterEl.className = "emjive-3d-viewer__poster";
      posterEl.src = posterSrc;
      posterEl.alt = "";
      wrapper.appendChild(posterEl);
    }

    // The loader (js/loader.js). While the model and environment load, a
    // loader sits over the poster (or over the caller's own fallback image
    // behind this viewer). The viewer swaps in the moment the model is ready
    // — the loader is released then and plays out its crossing over the live,
    // already draggable model; it does not hold the reveal back. Three cases:
    //   options.loader = a hold   the caller already mounted the loader on a
    //                             host of its own (js/main.js's grid cards,
    //                             whose figure also holds the icon) — this is
    //                             the hold released at reveal (and by the
    //                             caller too, if the load never finishes)
    //   options.loader = false    no loader: nothing is shown or released
    //   otherwise                 mount one inside this viewer's own box;
    //                             options.loaderBleed lets its parts travel
    //                             past that box to the edges of the clipping
    //                             ancestor, for a box whose own edges aren't
    //                             visible (the carousels' model slides)
    // Never for the render harness (static) or any page that doesn't load
    // js/loader.js (scene-tool.html, scripts/auto-render.js's page).
    var loadGate = null;
    if (!isStatic && options.loader !== false && window.EmjiveLoader) {
      loadGate = options.loader && typeof options.loader.done === "function"
        ? options.loader
        : window.EmjiveLoader.mount(wrapper, { bleed: !!options.loaderBleed });
    }

    // A <div>, not an <img> — its visible pixels come entirely from the
    // backdrop-filter invert clipped to the SVG's mask shape (see the CSS
    // rule), not from any fill/stroke painted by the element itself.
    var nudgeHandEl = document.createElement("div");
    nudgeHandEl.className = "emjive-3d-viewer__nudge-hand";
    wrapper.appendChild(nudgeHandEl);

    // options.hitCircle (js/product.js): the share of the viewer's width left
    // as a margin around the part of it that answers to a drag — a circle
    // (0.25: a circle whose radius is three quarters of the viewer's own).
    // A transparent overlay clipped to that circle carries the controls
    // instead of the canvas; CSS clip-path clips hit-testing too, so a press
    // inside the circle is the model's and a press outside it falls through
    // to whatever is under the viewer (the carousel, which pages or scrolls).
    // Without it the whole canvas is the model's, as it is everywhere else.
    var hitEl = null;
    if (typeof options.hitCircle === "number" && !isStatic) {
      hitEl = document.createElement("div");
      hitEl.className = "emjive-3d-viewer__hit";
      hitEl.style.setProperty("--hit-r", ((1 - options.hitCircle) * 50).toFixed(2) + "%");
      wrapper.appendChild(hitEl);
      wrapper.classList.add("has-hit-circle");
    }

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);

    // Declared up here, not down by dispose(), because both async load
    // chains below have to be able to read it. js/main.js's grid disposes
    // a viewer the moment its card scrolls clear — which routinely happens
    // while that card's .glb (tens of MB) and HDRI are still in flight, so
    // "was I torn down before this arrived?" is the normal case during a
    // fast scroll, not an edge case.
    var isDisposed = false;

    // options.onError is meant to fire at most once — see reportError()
    // below — but it now has two independent triggers (the load/HDRI
    // failure path further down, and a WebGL context loss that can happen
    // well after a successful load, see handleContextLost). Without this
    // guard, a context loss arriving after an already-rejected load promise
    // (or vice versa) would call a caller's onError twice.
    var hasErrored = false;
    function reportError() {
      if (isDisposed || hasErrored) return;
      hasErrored = true;
      // Whatever the loader was waiting for isn't coming; let it go (the
      // poster, or the caller's icon, is what stays on screen).
      if (loadGate) loadGate.done();
      if (options.onError) options.onError();
    }

    // iOS Safari silently reclaims WebGL contexts under memory pressure —
    // independent of, and often well after, a model's own successful load
    // (several simultaneous viewers on the homepage grid, or just the page
    // being backgrounded and foregrounded again). Nothing else in this file
    // would ever notice: modelLoaded stays true, the poster/icon crossfade
    // already finished, and the render-on-demand loop below only redraws on
    // camera motion, so a lost context just leaves the canvas permanently
    // blank with every piece of this module's own state insisting
    // everything is fine. Not attempting real restoration here (re-
    // uploading textures/geometry into a webglcontextrestored context) —
    // deliberately NOT calling event.preventDefault(), which per spec means
    // the browser won't try to restore it — since iOS Safari's own
    // memory-pressure losses are frequently never restorable anyway, and
    // this site already has a proven, always-available fallback for "can't
    // show the 3D model": the same static icon a product with no model at
    // all gets. reportError() routes there via options.onError exactly like
    // a load failure does.
    function handleContextLost() {
      console.error("emjive: WebGL context lost for", product.name);
      reportError();
    }
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost, false);

    // Frees a loaded model's own GPU buffers. Split out of dispose()
    // because the late-arrival paths below need exactly the same teardown
    // for a model that showed up after the viewer was already gone —
    // without it, everything a fast scroll started but didn't finish
    // leaked its full decoded geometry, which is precisely the memory the
    // lazy grid exists to cap.
    // Material.dispose() frees the compiled program but NOT its textures
    // (maps are separate GPU objects), so a glTF's own maps would otherwise
    // outlive everything that could ever draw them.
    function disposeMaterial(material) {
      if (!material) return;
      if (Array.isArray(material)) {
        material.forEach(disposeMaterial);
        return;
      }
      Object.keys(material).forEach(function (key) {
        var value = material[key];
        if (value && value.isTexture) value.dispose();
      });
      material.dispose();
    }

    function disposeObject3D(root) {
      if (!root) return;
      root.traverse(function (node) {
        if (!node.isMesh) return;
        if (node.geometry) node.geometry.dispose();
        disposeMaterial(node.material);
      });
    }

    // What a model costs as JavaScript typed arrays. A glTF loaded through
    // Draco arrives as Float32 positions and normals plus 32-bit indices
    // however small the file was on the wire: the biggest ring here is 4MB
    // as a file and about 120MB decoded, and three.js keeps that copy in
    // the page for the life of the geometry even though the GPU holds its
    // own after the first draw.
    function eachGeometryBuffer(root, visit) {
      root.traverse(function (node) {
        if (!node.isMesh || !node.geometry) return;
        var geometry = node.geometry;
        Object.keys(geometry.attributes).forEach(function (name) {
          // Interleaved attributes share a buffer with others and aren't
          // what Draco produces; leave anything that isn't a plain one.
          if (geometry.attributes[name].isBufferAttribute) visit(geometry.attributes[name]);
        });
        if (geometry.index) visit(geometry.index);
      });
    }

    function cpuGeometryBytes(root) {
      var bytes = 0;
      eachGeometryBuffer(root, function (attribute) {
        if (attribute.array) bytes += attribute.array.byteLength;
      });
      return bytes;
    }

    // Once the first frame has been drawn the GPU has its own copy of every
    // buffer, and nothing in this viewer reads the arrays again: a metal
    // switch only swaps materials, the camera is framed from the bounding
    // box (computed here, before the arrays go, because three.js otherwise
    // computes the box and the culling sphere lazily from positions it would
    // no longer have), and a lost context is reported as a failure and the
    // viewer rebuilt from the file rather than re-uploaded.
    //
    // Skipped for the render harness and the scene tool, which call
    // frameCamera() again for every pose they take and read the scene back.
    // The count held is handed back either way, so the overlay's figure
    // follows what is actually still in memory.
    var heldCpuBytes = 0;
    function releaseHeldCpuBytes() {
      window.EmjiveMem.cpuGeometryBytes -= heldCpuBytes;
      heldCpuBytes = 0;
    }

    function releaseGeometryArrays(root) {
      if (!root) return;
      root.traverse(function (node) {
        if (!node.isMesh || !node.geometry) return;
        if (node.geometry.boundingBox === null) node.geometry.computeBoundingBox();
        if (node.geometry.boundingSphere === null) node.geometry.computeBoundingSphere();
      });
      eachGeometryBuffer(root, function (attribute) { attribute.array = null; });
      releaseHeldCpuBytes();
    }

    // Not fired-and-forgotten: the environment load and the GLTF load
    // below are two independent async chains with no inherent ordering,
    // and Promise.all()'d together (see below) rather than racing —
    // otherwise the first frame (the one the render harness screenshots)
    // could get captured before the environment texture has actually
    // landed on the scene, rendering flat black.
    // Held separately from scene.environment (which is only the target's
    // .texture) so dispose() can free the whole render target — see
    // loadEnvironment's own comment.
    var environmentTarget = null;
    // (options.environment === false: none — for a viewer that only ever
    // draws the flat blueprint, which no reflection touches.)
    var environmentPromise = options.environment === false ? Promise.resolve() : loadEnvironment(renderer, options.hdri, function () { return isDisposed; }, options.environmentBlur).then(function (renderTarget) {
      // Arriving after teardown: the PMREM target is real GPU memory on a
      // renderer that's already been released, so it has to be freed here
      // rather than attached to a scene nothing will ever draw again. (Null
      // when loadEnvironment saw the teardown first and built nothing.)
      if (isDisposed) {
        if (renderTarget) renderTarget.dispose();
        return;
      }
      environmentTarget = renderTarget;
      scene.environment = renderTarget.texture;
    });

    // Initial size read synchronously (before any async load resolves) so
    // the renderer/camera are correctly sized from the very first frame —
    // a ResizeObserver alone would leave both at a stale default until its
    // first callback, which could lose the race against the GLTF load.
    var currentWidth = 1;
    var currentHeight = 1;
    // Set by anything that changes what the canvas should show WITHOUT
    // moving the camera — a resize, a metal swap. Declared here rather
    // than beside the rest of the animate-loop state because applySize()
    // is called synchronously below, well before that block. Consumed (and
    // cleared) once per frame by the animate loop.
    var needsRender = false;
    // `controls` isn't constructed yet the first time applySize() runs
    // (see below) — referencing it here is safe regardless, since `var`
    // hoists the declaration and this function isn't CALLED until after
    // that first synchronous invocation returns.
    function applySize(w, h) {
      w = Math.max(1, w);
      h = Math.max(1, h);
      if (w === currentWidth && h === currentHeight) return;
      currentWidth = w;
      currentHeight = h;
      renderer.setSize(w, h, false); // false: don't fight the existing CSS sizing
      if (bracketLines) bracketLines.material.resolution.set(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // A resize repaints nothing by itself, and the render-on-demand loop
      // keys off camera MOTION — which a resize isn't — so an idle viewer
      // would keep showing the pre-resize frame stretched to the new box
      // until something else happened to move. See needsRender's own
      // comment down in the animate loop.
      needsRender = true;
      // A static viewer has no animate loop to consume needsRender, and
      // setSize() above has just wiped the canvas. The wrapper is still
      // detached when the ready path's one render runs, so whenever that
      // render beats this observer to the real size — a primitive swatch
      // with the HDRI decode already cached is fast enough to — the
      // harness screenshotted a blank canvas. Skipped for a viewer that's
      // torn down or whose wrapper has left the page: auto-render clears
      // the body between renders without disconnecting old observers.
      if (isStatic && modelLoaded && !isDisposed && wrapper.isConnected) {
        renderer.render(scene, camera);
      }
      // TrackballControls caches the element's screen rect itself
      // (.screen.width/left/etc, read via handleResize()) rather than
      // measuring it fresh on every pointer event — it only does this
      // once, in its own constructor. At construction time below, `wrapper`
      // is still a detached <div> (the caller hasn't appended it to the
      // page yet), so that first read is always 0x0 — and with
      // screen.width stuck at 0, _getMouseOnCircle() divides by zero on
      // every drag, producing NaN deltas that (NaN being falsy) silently
      // no-op the whole rotation, forever. Re-syncing it here, on every
      // real resize (including the first one after the wrapper actually
      // lands in the document and gets a real size), is what makes
      // dragging work at all.
      if (controls) controls.handleResize();
    }
    var initialRect = wrapper.getBoundingClientRect();
    applySize(initialRect.width || 1, initialRect.height || 1);

    var resizeObserver = new ResizeObserver(function (entries) {
      var box = entries[0].contentRect;
      applySize(box.width, box.height);
    });
    resizeObserver.observe(wrapper);

    var controls = new TrackballControls(camera, hitEl || renderer.domElement);
    // Rotation only — matches the old disable-zoom behavior.
    controls.noZoom = true;
    controls.noPan = true;
    // Lower = a given drag distance produces less rotation — decouples the
    // motion from a direct 1:1 pointer mapping so it reads as heavier/more
    // deliberate rather than instantly following the cursor.
    controls.rotateSpeed = 0.5;
    // TrackballControls already decays into a spin on release rather than
    // stopping dead. This seed value assumes ~60fps; the actual per-frame
    // factor is re-derived every frame from SPIN_DECAY_LAMBDA + real dt
    // below, so spin-down feels the same at 60Hz vs. 120Hz+ displays
    // (TrackballControls.update() itself takes no delta-time argument).
    controls.dynamicDampingFactor = 0.04032;
    var SPIN_DECAY_LAMBDA = (-0.5 * Math.log(1 - controls.dynamicDampingFactor)) / REF_DT;
    // three.js's own built-in "no momentum" flag — rotation only ever tracks
    // the pointer's current position, never coasts on release. Simpler and
    // more robust than fighting the decay math below
    // (dynamicDampingFactor/SPIN_DECAY_LAMBDA) to approximate a dead stop.
    //
    // Assigned here AND re-asserted every frame in the animate loop, which
    // is not redundant: this line runs exactly once, at construction, while
    // noAutoMotion() is live — so a visitor toggling reduced motion
    // mid-session would otherwise keep whatever value was captured when the
    // viewer happened to be built. It's read inside controls.update(), and
    // controls.update() is called from two places (frameCamera below, and
    // the animate loop), so the flag has to be correct before each of them
    // rather than just once here.
    controls.staticMoving = noAutoMotion();

    var defaultOrbit = product["3d-viewer-camera-default"] || DEFAULT_ORBIT;
    var explicitTarget = parseTargetString(product.cameraTarget);

    var defaultCameraPosition = new THREE.Vector3();
    var defaultCameraUp = new THREE.Vector3();
    var defaultRollRad = 0;
    var defaultRadius = 0;
    var nudgeWaypoints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

    // Positions the camera instantly (no animation) at the given orbit,
    // re-measuring the model's current bounding sphere each time — used
    // both for the initial default framing and as the direct replacement
    // for model-viewer's jumpCameraToGoal()+camera-orbit combo in
    // scripts/auto-render.js's top-shot render path.
    function frameCamera(orbitConfig) {
      if (!modelRoot) return;
      var orbit = parseOrbitConfig(orbitConfig);
      // A blueprint viewer's model sits in a group that the specs stage
      // shrinks (see updateBlueprint); the framing is always the model's own
      // size, so that scale is set aside while measuring.
      if (fitGroup) {
        fitGroup.scale.setScalar(1);
        fitGroup.position.set(0, 0, 0);
        fitGroup.updateMatrixWorld(true);
      }
      var box = new THREE.Box3().setFromObject(modelRoot);
      var sphere = box.getBoundingSphere(new THREE.Sphere());
      frameSphere = sphere.clone();
      framedRadius = sphere.radius * (orbit.radiusPercent / 100);
      if (fitGroup) needsRender = true;
      var target = orbit.target || explicitTarget || sphere.center;
      if (orbit.fov !== null && orbit.fov !== camera.fov) {
        camera.fov = orbit.fov;
        camera.updateProjectionMatrix();
      }
      var fovRad = (camera.fov * Math.PI) / 180;
      var distance = (sphere.radius / Math.sin(fovRad / 2)) * (orbit.radiusPercent / 100);
      // Tightened from the constructor's generic 0.01/1000 now that the
      // real scene scale is known — that wide a near:far span concentrates
      // depth-buffer precision too close to the camera, risking z-fighting
      // on the double-sided thin ring-band geometry.
      camera.near = Math.max(0.01, distance - sphere.radius * 2);
      camera.far = distance + sphere.radius * 4;
      var offset = new THREE.Vector3(
        distance * Math.sin(orbit.phiRad) * Math.sin(orbit.thetaRad),
        distance * Math.cos(orbit.phiRad),
        distance * Math.sin(orbit.phiRad) * Math.cos(orbit.thetaRad)
      );

      controls.target.copy(target);
      camera.position.copy(target).add(offset);

      // camera.up needs to be more than a WORLD_UP stand-in now that roll
      // is a real, savable degree of freedom (see parseOrbitConfig above):
      // restUpRaw() — WORLD_UP's own component perpendicular to the eye
      // direction (the "level" up for this exact position), rotated around
      // that same eye direction by orbit.rollRad. For roll 0 this lands on
      // exactly the same final orientation camera.up = WORLD_UP always
      // produced here before — lookAt() only ever uses the up hint's
      // component perpendicular to the view direction, and the two differ
      // only by a component parallel to it — so it only changes the *value*
      // left in camera.up, which is what the animate loop needs: the
      // ease-back-to-default tween slerps toward defaultCameraUp (captured
      // right below), and the leveling drift and idle nudge both rebuild
      // their reference from restUpRaw() with defaultRollRad, so the
      // resting pose — authored roll included — is an exact fixed point of
      // all three rather than something they slowly flatten back to level.
      var eyeDir = offset.clone().normalize();
      restUpRaw(camera.up, eyeDir, orbit.rollRad);
      // Degenerates exactly at the poles (tilt 0/180, eyeDir parallel to
      // WORLD_UP) — which auto-render's top shots always sit on (tilt 0).
      // Falls back to level-up's own limit along this rotation's meridian,
      // (-cos(tilt)·sin(rotation), 0, -cos(tilt)·cos(rotation)). At
      // rotation 0 that's -Z (north pole) / +Z (south), exactly what
      // lookAt()'s own parallel-up nudge produced back when up was
      // WORLD_UP — so top shots keep the orientation the hero-hand
      // overlays' rotation values were tuned against. An arbitrary axis
      // here (+Z was tried) turns every top shot 180 degrees.
      if (camera.up.lengthSq() < 1e-8) {
        var cosTilt = Math.cos(orbit.phiRad);
        camera.up
          .set(-cosTilt * Math.sin(orbit.thetaRad), 0, -cosTilt * Math.cos(orbit.thetaRad))
          .applyAxisAngle(eyeDir, orbit.rollRad);
      }
      camera.up.normalize();
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      controls.update();

      defaultCameraPosition.copy(camera.position);
      defaultCameraUp.copy(camera.up);
      defaultRollRad = orbit.rollRad;
      defaultRadius = camera.position.distanceTo(controls.target);

      // Idle-nudge waypoints: the default eye direction, and that same
      // direction rotated +/- NUDGE_ANGLE_RAD around world-up. The nudge
      // itself re-derives up per frame from whichever eye direction it's
      // at (restUpRaw), so the authored roll holds steady through the
      // yaw instead of wobbling — a fixed up vector only stays roll-free
      // under a yaw when it's literally WORLD_UP.
      nudgeWaypoints[0].copy(defaultCameraPosition).sub(controls.target).normalize();
      nudgeWaypoints[1].copy(nudgeWaypoints[0]).applyAxisAngle(WORLD_UP, NUDGE_ANGLE_RAD);
      nudgeWaypoints[2].copy(nudgeWaypoints[0]).applyAxisAngle(WORLD_UP, -NUDGE_ANGLE_RAD);
    }

    // currentMetal is read by applyMaterial(), and also by applyMetal()
    // once the model has already loaded — this is what lets a metal
    // switch after load re-run the same material assignment.
    var currentMetal = metalKey;
    var modelRoot = null;
    var modelLoaded = false;

    function applyMaterial() {
      if (!modelRoot) return;
      modelRoot.traverse(function (node) {
        if (!node.isMesh) return;
        var params = metalToStandardMaterialParams(currentMetal);
        // Always a fresh material, never mutating whatever the GLTF's own
        // mesh already had (GLTFLoader produces MeshStandardMaterial by
        // default, so a "reuse if already the right type" shortcut would
        // silently keep the artist's original textures/maps and skip the
        // DoubleSide fix below on every model). The band's geometry is
        // thin/open enough that some angles look straight through a
        // back-culled face into the inside — rendering both sides fixes
        // it, applied unconditionally to every mesh.
        var previous = node.material;
        node.material = new THREE.MeshStandardMaterial({
          color: params.color,
          metalness: params.metalness,
          roughness: params.roughness,
          side: THREE.DoubleSide
        });
        if (blueprint) blueprintMaterial(node.material);
        // Every metal switch used to leave the material it replaced (and, the
        // first time, the glTF's own textured one) allocated for the life of
        // the viewer.
        disposeMaterial(previous);
      });
    }

    /* ---- blueprint (options.blueprint) ------------------------------------
       Everything the product page's specs stage draws, driven by two
       numbers, handle.setBlueprint(sweep, fit), 0 to 1 each (the page makes
       the second start where the first ends), and handle.setSize(factor):
       - the sweep: BLUEPRINT_FRAGMENT on every mesh's material, the cut at
         uScanY (view space) going from under the model (0: all metal) to
         over it (1: all fill); handle.scanSpan() says where on screen that
         is, so the page can ride a band on it;
       - the edges: one LineSegments per mesh, clipped to below the cut, so
         they draw in behind it;
       - the fit: the model, edges and brackets shrink together about the
         orbit target so the brackets and their labels fit the canvas — and
         scale with the size factor (the chosen ring size over the model's
         base size), so a bigger size draws a bigger model;
       - the brackets: three dimension lines meeting at one corner of the
         minimum-volume box (product.geometry["min-box"],
         scripts/measure-models.js), fading in over the end of the fit, each
         labelled in HTML.
       None of it exists without options.blueprint. --------------------- */
    var blueprintSweep = 0;
    var blueprintFit = 0;
    var sizeFactor = 1;
    var viewerPaused = false;
    var bpUniforms = null;
    if (blueprint) {
      var fillRgb = new THREE.Color().setStyle(blueprint.fill || "#f8f8f8").getRGB({}, THREE.SRGBColorSpace);
      bpUniforms = {
        uScanY: { value: -1e6 },
        uScanOn: { value: 0 },
        uFill: { value: new THREE.Vector3(fillRgb.r, fillRgb.g, fillRgb.b) }
      };
    }
    // The model, its edges and the brackets, in the group the fit scales.
    var fitGroup = null;
    var fitScale = 1;
    // What frameCamera() framed: the sphere (the cut travels across it) and
    // the radius the view actually fits (the sphere, times the orbit's zoom).
    var frameSphere = null;
    var framedRadius = 0;
    var wirePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -1e6);
    var wireMaterial = null;
    var wireLines = [];
    // The edge lists, as JavaScript arrays, until each has been uploaded.
    var wireCpuBytes = 0;
    var minBox = null;
    var bracketLines = null;
    var boxMesh = null;
    var bracketLabels = [];
    // polygonOffset pushes the fill back a hair so the edges, which lie
    // exactly on its triangles, win the depth test rather than flicker
    // through it; the edges on the far side still lose to the near fill.
    function blueprintMaterial(material) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      material.onBeforeCompile = function (shader) {
        shader.uniforms.uScanY = bpUniforms.uScanY;
        shader.uniforms.uScanOn = bpUniforms.uScanOn;
        shader.uniforms.uFill = bpUniforms.uFill;
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform float uScanY;\nuniform float uScanOn;\nuniform vec3 uFill;")
          .replace("#include <colorspace_fragment>", "#include <colorspace_fragment>\n" + BLUEPRINT_FRAGMENT);
      };
      material.customProgramCacheKey = function () { return "emjive-blueprint"; };
    }

    // Each edge once. A closed mesh with consistent winding walks every
    // edge twice, once each way, so keeping only the a < b direction halves
    // the list without a lookup — and an edge drawn twice would be darker
    // than its neighbours, at this opacity. (The odd edge of an open mesh
    // is walked once, and kept or not by the same rule.)
    function meshEdges(geometry) {
      var index = geometry.index ? geometry.index.array : null;
      var corners = index ? index.length : geometry.attributes.position.count;
      if (!corners) return null;
      var out = new (geometry.attributes.position.count > 65535 ? Uint32Array : Uint16Array)(corners * 2);
      var n = 0;
      for (var t = 0; t + 2 < corners; t += 3) {
        var a = index ? index[t] : t;
        var b = index ? index[t + 1] : t + 1;
        var c = index ? index[t + 2] : t + 2;
        if (!index || a < b) { out[n++] = a; out[n++] = b; }
        if (!index || b < c) { out[n++] = b; out[n++] = c; }
        if (!index || c < a) { out[n++] = c; out[n++] = a; }
      }
      return out.slice(0, n);
    }

    // Once uploaded (this runs right after the line's first draw), the edge
    // list isn't needed in JavaScript any more — the same reasoning as
    // releaseGeometryArrays, for the one buffer that function doesn't see.
    function releaseEdgesAfterDraw() {
      var index = this.geometry.index;
      if (index && index.array) {
        wireCpuBytes -= index.array.byteLength;
        window.EmjiveMem.cpuGeometryBytes -= index.array.byteLength;
        index.array = null;
      }
      this.onAfterRender = function () {};
    }

    // Built while the model's arrays are still there (they go after its
    // first frame). Each line set shares its mesh's position buffer — the
    // same BufferAttribute object, so the GPU holds it once — and is a
    // child of that mesh, so it follows it exactly.
    function buildWire(root) {
      wireMaterial = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: BLUEPRINT_WIRE_OPACITY,
        depthWrite: false,
        toneMapped: false,
        clippingPlanes: [wirePlane]
      });
      var meshes = [];
      root.traverse(function (node) {
        if (node.isMesh && node.geometry && node.geometry.attributes.position) meshes.push(node);
      });
      meshes.forEach(function (mesh) {
        var edges = meshEdges(mesh.geometry);
        if (!edges || !edges.length) return;
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingSphere === null) mesh.geometry.computeBoundingSphere();
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", mesh.geometry.attributes.position);
        geometry.setIndex(new THREE.BufferAttribute(edges, 1));
        // Copied rather than computed: computing them would read positions
        // that are about to be released.
        geometry.boundingBox = mesh.geometry.boundingBox.clone();
        geometry.boundingSphere = mesh.geometry.boundingSphere.clone();
        var lines = new THREE.LineSegments(geometry, wireMaterial);
        lines.visible = false;
        lines.onAfterRender = releaseEdgesAfterDraw;
        wireCpuBytes += edges.byteLength;
        window.EmjiveMem.cpuGeometryBytes += edges.byteLength;
        mesh.add(lines);
        wireLines.push(lines);
      });
    }

    // Three dimension lines — one per box axis, axes[k] measured as
    // dimensions-mm[k] — in one pre-allocated LineSegments, rewritten whenever
    // the view changes. Drawn over everything (depthTest off): an annotation
    // that the model could hide wouldn't be one. No box (an old products
    // file, a missing field) means no brackets; the page then shows the
    // dimensions as text instead (handle.hasBrackets).
    function buildBrackets() {
      var geometry = product.geometry || {};
      var pose = geometry["min-box"];
      var dims = geometry["dimensions-mm"];
      if (!pose || !Array.isArray(pose.axes) || pose.axes.length !== 3 || !Array.isArray(dims) || dims.length !== 3) return;
      minBox = {
        center: new THREE.Vector3().fromArray(pose.center),
        axes: pose.axes.map(function (a) { return new THREE.Vector3().fromArray(a).normalize(); }),
        half: dims.map(function (d) { return d / 2; }),
        dims: dims.slice(),
        gap: BRACKET_GAP * Math.max(dims[0], dims[1], dims[2]),
        // The distance from the centre to any corner, which the box is scaled
        // by (to make the gap) about the centre.
        outScale: 1 + BRACKET_GAP * Math.max(dims[0], dims[1], dims[2]) /
          Math.sqrt(dims[0] * dims[0] / 4 + dims[1] * dims[1] / 4 + dims[2] * dims[2] / 4),
        // The run of edges the lines are on now (see updateBrackets).
        chain: ""
      };
      // Three segments, rewritten in place whenever the view changes: the
      // geometry's own buffer (start and end, six numbers a segment) is what
      // updateBrackets fills, and instanceCount how many of them are drawn.
      var lineGeometry = new LineSegmentsGeometry();
      lineGeometry.setPositions(new Float32Array(3 * 2 * 3));
      lineGeometry.attributes.instanceStart.data.setUsage(THREE.DynamicDrawUsage);
      bracketLines = new LineSegments2(lineGeometry, new LineMaterial({
        color: new THREE.Color().setStyle(blueprint.lineColor || "#727272"),
        // In CSS pixels, against the viewer's size (see applySize).
        linewidth: BRACKET_LINE_DEVICE_PX / renderer.getPixelRatio(),
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      }));
      bracketLines.material.resolution.set(currentWidth, currentHeight);
      bracketLines.frustumCulled = false;
      bracketLines.renderOrder = 10;
      bracketLines.visible = false;
      fitGroup.add(bracketLines);
      // The box itself: a unit cube stretched onto the minimum-volume box,
      // translucent and unlit, in the lines' colour. Depth-tested (the model
      // stands in front of its far faces) but writing no depth, so it never
      // hides the model or the edges.
      boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
        color: new THREE.Color().setStyle(blueprint.lineColor || "#727272"),
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      }));
      boxMesh.matrixAutoUpdate = false;
      boxMesh.matrix.makeBasis(
        minBox.axes[0].clone().multiplyScalar(dims[0]),
        minBox.axes[1].clone().multiplyScalar(dims[1]),
        minBox.axes[2].clone().multiplyScalar(dims[2])
      ).setPosition(minBox.center);
      boxMesh.frustumCulled = false;
      boxMesh.renderOrder = 5;
      boxMesh.visible = false;
      fitGroup.add(boxMesh);
      dims.forEach(function () {
        var label = document.createElement("span");
        label.className = "emjive-3d-viewer__dim";
        label.setAttribute("aria-hidden", "true");
        wrapper.appendChild(label);
        bracketLabels.push(label);
      });
      paintLabels();
    }

    // The labels read what is drawn: the box's own dimensions times the size
    // factor.
    function paintLabels() {
      if (!minBox) return;
      bracketLabels.forEach(function (label, k) {
        label.textContent = formatCm(minBox.dims[k] * sizeFactor);
      });
    }

    // The shrink that makes room for the brackets: the farthest a bracket
    // line reaches from the orbit target, against the radius the view fits —
    // at the largest size the page scales to. The labels aren't counted:
    // they're HTML, free to sit past the canvas' edge. Measured once the
    // camera is framed.
    function computeFit() {
      fitScale = 1;
      if (!framedRadius) return;
      var reach = frameSphere ? frameSphere.radius : 0;
      if (minBox) {
        var corner = new THREE.Vector3();
        reach = 0;
        for (var s = 0; s < 8; s++) {
          corner.copy(minBox.center);
          for (var k = 0; k < 3; k++) corner.addScaledVector(minBox.axes[k], (s & (1 << k) ? 1 : -1) * minBox.half[k]);
          reach = Math.max(reach, corner.distanceTo(controls.target));
        }
        reach += minBox.gap;
      }
      var room = framedRadius * 0.95;
      fitScale = Math.min(1, room / (reach * BLUEPRINT_SIZE_MAX));
    }

    var bpCenter = new THREE.Vector3();
    var bpScratch = new THREE.Vector3();
    var bpUp = new THREE.Vector3();
    var bpNdc = new THREE.Vector3();
    var bpA = new THREE.Vector3();
    var bpCamLocal = new THREE.Vector3();

    // Called right before every draw of a blueprint viewer (and before its
    // very first): the view decides the cut's height on screen and which
    // corner the brackets meet at, so both follow every orbit frame.
    function updateBlueprint() {
      if (!fitGroup || !frameSphere) return;
      var sweep = blueprintSweep;
      // The scale the fit goes to: the page's (px to a mm, brought to world
      // units), or the one that makes the box and its brackets fit.
      var target = fitScale * sizeFactor;
      var scale = 1 + (target - 1) * blueprintFit;
      fitGroup.scale.setScalar(scale);
      fitGroup.position.copy(controls.target).multiplyScalar(1 - scale);
      fitGroup.updateMatrixWorld(true);
      camera.updateMatrixWorld();

      // The cut: a plane level in view space, from just under the (scaled)
      // sphere to just over it.
      bpCenter.copy(frameSphere.center).applyMatrix4(fitGroup.matrixWorld);
      var radius = frameSphere.radius * scale * 1.02;
      var cutY = bpScratch.copy(bpCenter).applyMatrix4(camera.matrixWorldInverse).y + (2 * sweep - 1) * radius;
      bpUniforms.uScanY.value = cutY;
      bpUniforms.uScanOn.value = sweep > 0 && sweep < 1 ? 1 : 0;
      // The same plane for the edges, in world space: through the view-space
      // point (0, cutY, 0), facing down — three keeps the side its normal
      // points to.
      bpUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      bpScratch.copy(camera.position).addScaledVector(bpUp, cutY);
      wirePlane.setFromNormalAndCoplanarPoint(bpUp.negate(), bpScratch);
      wireLines.forEach(function (lines) { lines.visible = sweep > 0; });

      var fade = smoothstep01(BRACKET_FADE_FROM, 1, blueprintFit);
      if (minBox) updateBrackets(fade);
    }

    // A dimension label beside its line, on screen: from the line's middle,
    // perpendicular to it, away from the point (cx, cy) the line measures —
    // far enough that the label's own box clears the line.
    function placeLabel(label, ax, ay, bx, by, cx, cy, opacity) {
      var lx = bx - ax, ly = by - ay;
      var len = Math.sqrt(lx * lx + ly * ly) || 1;
      var px = -ly / len, py = lx / len;
      var mx = (ax + bx) / 2, my = (ay + by) / 2;
      if ((mx - cx) * px + (my - cy) * py < 0) { px = -px; py = -py; }
      var reach = BRACKET_LABEL_PX + Math.abs(px) * label.offsetWidth / 2 + Math.abs(py) * label.offsetHeight / 2;
      label.style.transform = "translate(" + (mx + px * reach).toFixed(1) + "px, " + (my + py * reach).toFixed(1) +
        "px) translate(-50%, -50%)";
      label.style.opacity = String(opacity);
    }

    // Model-space point -> pixels from the viewer's top-left, into `out`.
    var bpPxA = { x: 0, y: 0 };
    var bpPxB = { x: 0, y: 0 };
    var bpPxC = { x: 0, y: 0 };
    function toPx(point, out) {
      toNdc(point);
      out.x = (bpNdc.x + 1) / 2 * currentWidth;
      out.y = (1 - bpNdc.y) / 2 * currentHeight;
      return out;
    }

    // Model-space point -> NDC, into bpNdc.
    function toNdc(point) {
      return bpNdc.copy(point).applyMatrix4(fitGroup.matrixWorld).project(camera);
    }

    // The brackets are three dimension lines that join end to end, outside
    // the model: three consecutive edges of the outline of the box as seen,
    // with the box scaled up a little about its centre (outScale) to leave
    // the gap, so the lines are parallel to the real edges and meet at the
    // outline's corners. Which three: the run lowest on screen, leaning right
    // (the left of the model is where the page's own figures stand), and
    // it stays put until another is clearly better, so the lines don't
    // flicker between two while the model turns. A line whose edge points at
    // the camera is too short to read and goes, label and all.
    //
    // A corner is a number 0-7, a bit per axis for which side of the centre
    // it is on; an edge runs along one axis between two corners that differ
    // in that bit only.
    var bpEdges = [];
    var bpCornerPos = [];
    for (var cm = 0; cm < 8; cm++) bpCornerPos.push(new THREE.Vector3());

    function cornerSign(m, axis) {
      return m & (1 << axis) ? 1 : -1;
    }

    // Whether the face of the box on one side of an axis turns to the camera
    // (bpScratch is free for it).
    function faceToCamera(axis, sign, camLocal) {
      bpScratch.copy(camLocal).sub(minBox.center).addScaledVector(minBox.axes[axis], -sign * minBox.half[axis]);
      return bpScratch.dot(minBox.axes[axis]) * sign > 0;
    }

    function updateBrackets(opacity) {
      boxMesh.material.opacity = opacity * BOX_OPACITY;
      boxMesh.visible = opacity > 0;
      bracketLines.material.opacity = opacity;
      bracketLines.visible = opacity > 0;
      if (opacity <= 0) {
        bracketLabels.forEach(function (label) { label.style.opacity = "0"; });
        return;
      }
      var c = minBox.center;
      for (var m = 0; m < 8; m++) {
        bpCornerPos[m].copy(c);
        for (var k = 0; k < 3; k++) bpCornerPos[m].addScaledVector(minBox.axes[k], cornerSign(m, k) * minBox.half[k] * minBox.outScale);
      }
      fitGroup.worldToLocal(bpCamLocal.copy(camera.position));

      // The edges on the outline: one of the two faces beside it turns to
      // the camera, the other away.
      bpEdges.length = 0;
      for (var axis = 0; axis < 3; axis++) {
        var i = (axis + 1) % 3;
        var j = (axis + 2) % 3;
        for (var low = 0; low < 8; low++) {
          if (low & (1 << axis)) continue;
          var faceI = faceToCamera(i, cornerSign(low, i), bpCamLocal);
          var faceJ = faceToCamera(j, cornerSign(low, j), bpCamLocal);
          if (faceI !== faceJ) bpEdges.push({ axis: axis, a: low, b: low | (1 << axis) });
        }
      }

      // Walk the outline round: corner to corner along its edges.
      var loop = [];
      if (bpEdges.length >= 4) {
        var used = [];
        var first = bpEdges[0];
        loop.push({ corner: first.a, edge: first });
        var at = first.b;
        used[0] = true;
        for (var guard = 0; guard < bpEdges.length; guard++) {
          var next = -1;
          for (var e = 0; e < bpEdges.length; e++) {
            if (!used[e] && (bpEdges[e].a === at || bpEdges[e].b === at)) { next = e; break; }
          }
          if (next < 0) break;
          used[next] = true;
          loop.push({ corner: at, edge: bpEdges[next] });
          at = bpEdges[next].a === at ? bpEdges[next].b : bpEdges[next].a;
        }
      }

      // Each run of three edges, scored by how low and right its edges sit.
      var best = null;
      var bestScore = Infinity;
      var keptScore = Infinity;
      var n = loop.length;
      for (var start = 0; start < n && n >= 4; start++) {
        var run = [loop[start].edge, loop[(start + 1) % n].edge, loop[(start + 2) % n].edge];
        var total = 0;
        var key = "";
        for (var r = 0; r < 3; r++) {
          toNdc(bpA.copy(bpCornerPos[run[r].a]).add(bpCornerPos[run[r].b]).multiplyScalar(0.5));
          total += bpNdc.y - 0.35 * bpNdc.x;
          key += run[r].axis + ":" + run[r].a + ",";
        }
        if (key === minBox.chain) keptScore = total;
        if (total < bestScore) {
          bestScore = total;
          best = { run: run, key: key };
        }
      }
      var lineBuffer = bracketLines.geometry.attributes.instanceStart.data;
      var positions = lineBuffer.array;
      positions.fill(0);
      var segments = 0;
      bracketLabels.forEach(function (label) { label.style.opacity = "0"; });
      if (!best) {
        minBox.chain = "";
        bracketLines.geometry.instanceCount = 0;
        lineBuffer.needsUpdate = true;
        return;
      }
      if (keptScore < bestScore + BRACKET_HYSTERESIS * 3) {
        // Rebuild the kept run from its key.
        for (var s0 = 0; s0 < n; s0++) {
          var cand = [loop[s0].edge, loop[(s0 + 1) % n].edge, loop[(s0 + 2) % n].edge];
          var ckey = "";
          for (var q = 0; q < 3; q++) ckey += cand[q].axis + ":" + cand[q].a + ",";
          if (ckey === minBox.chain) { best = { run: cand, key: ckey }; break; }
        }
      }
      minBox.chain = best.key;

      var middle = toPx(bpScratch.copy(c), bpPxC);
      var drawn = [false, false, false];
      for (var d = 0; d < 3; d++) {
        var edge = best.run[d];
        // A run that comes round on itself (an outline of four) repeats an
        // axis; each axis is drawn once.
        if (drawn[edge.axis]) continue;
        var label = bracketLabels[edge.axis];
        var startPx = toPx(bpCornerPos[edge.a], bpPxA);
        var sx = startPx.x, sy = startPx.y;
        var endPx = toPx(bpCornerPos[edge.b], bpPxB);
        var lx = endPx.x - sx, ly = endPx.y - sy;
        var llen = Math.sqrt(lx * lx + ly * ly);
        if (llen < BRACKET_MIN_PX) continue;
        drawn[edge.axis] = true;
        var o = segments++ * 6;
        positions[o] = bpCornerPos[edge.a].x; positions[o + 1] = bpCornerPos[edge.a].y; positions[o + 2] = bpCornerPos[edge.a].z;
        positions[o + 3] = bpCornerPos[edge.b].x; positions[o + 4] = bpCornerPos[edge.b].y; positions[o + 5] = bpCornerPos[edge.b].z;

        // The label goes beside its line, away from the model.
        placeLabel(label, sx, sy, endPx.x, endPx.y, middle.x, middle.y, opacity);
      }
      bracketLines.geometry.instanceCount = segments;
      lineBuffer.needsUpdate = true;
    }

    function disposeBlueprint() {
      wireLines.forEach(function (lines) {
        if (lines.parent) lines.parent.remove(lines);
        lines.geometry.dispose();
      });
      wireLines.length = 0;
      if (wireMaterial) wireMaterial.dispose();
      window.EmjiveMem.cpuGeometryBytes -= wireCpuBytes;
      wireCpuBytes = 0;
      if (bracketLines) {
        bracketLines.geometry.dispose();
        bracketLines.material.dispose();
        bracketLines = null;
      }
      if (boxMesh) {
        boxMesh.geometry.dispose();
        boxMesh.material.dispose();
        boxMesh = null;
      }
      bracketLabels.forEach(function (label) { if (label.parentNode) label.parentNode.removeChild(label); });
      bracketLabels.length = 0;
    }

    // options.swatch (scene-tool.html's swatch mode, and
    // scripts/auto-render.js's swatch renderer) is truthy, and swaps a loaded
    // GLTF for the swatch sphere (lit by options.hdri, as any model is) —
    // everything downstream (frameCamera's bounding-
    // sphere measurement, applyMaterial's mesh traversal, controls, the
    // animate loop, freeOrbit, dispose) is already agnostic to how
    // modelRoot was built, so this is the only branch needed. `product` in
    // this mode can be a minimal stub (just "3d-viewer-camera-default" —
    // swatchOrbit()'s result — and "name"); product.assets is never touched
    // on this path.
    var modelPromise;
    if (options.swatch) {
      modelRoot = buildSwatchStack();
      applyMaterial();
      scene.add(modelRoot);
      modelPromise = Promise.resolve();
    } else {
      // Overlaps the Draco decoder's own ~336KB fetch with this model's
      // (always larger) download instead of letting it serialize after it.
      // Safe to call for a non-Draco model too — GLTFLoader simply never
      // asks the decoder for anything.
      preloadDracoDecoder();
      modelPromise = new Promise(function (resolve, reject) {
        var loadTimer = setTimeout(function () {
          reject(new Error("Timed out loading " + product.assets.model));
        }, LOAD_TIMEOUT_MS);
        loadModelFile(
          product.assets.model,
          function (gltf) {
            clearTimeout(loadTimer);
            // Same late-arrival case as the environment above, and the
            // more expensive of the two: this is the fully decoded
            // geometry of a model that can be tens of MB on the wire and
            // several times that in memory. Freed immediately rather than
            // added to a scene belonging to a released renderer.
            if (isDisposed) {
              disposeObject3D(gltf.scene);
              resolve();
              return;
            }
            modelRoot = gltf.scene;
            heldCpuBytes = cpuGeometryBytes(modelRoot);
            window.EmjiveMem.cpuGeometryBytes += heldCpuBytes;
            applyMaterial();
            if (blueprint) {
              // Now, while the arrays the edges are read from still exist.
              buildWire(modelRoot);
              fitGroup = new THREE.Group();
              fitGroup.add(modelRoot);
              buildBrackets();
              scene.add(fitGroup);
            } else {
              scene.add(modelRoot);
            }
            resolve();
          },
          function (err) {
            clearTimeout(loadTimer);
            console.error("emjive: failed to load model", product.assets.model, err);
            reject(err);
          }
        );
      });
    }

    Promise.all([modelPromise, environmentPromise])
      .then(function () {
        // Both halves already free their own late arrivals above; this
        // guard is what stops the rest of the ready path from running on a
        // torn-down viewer — frameCamera() and especially
        // renderer.render() against a context that forceContextLoss() has
        // already killed, which is what filled the console with repeating
        // "THREE.WebGLRenderer: Context Lost" on every fast scroll.
        if (isDisposed) return;

        frameCamera(defaultOrbit);
        modelLoaded = true;
        // The page may already be in its specs stage (a reload mid-page, a
        // rebuild after the Modify sheet), so the first frame is drawn the
        // way the rest will be.
        if (blueprint) {
          computeFit();
          updateBlueprint();
        }

        renderer.render(scene, camera);
        // That draw uploaded every buffer to the GPU; the JavaScript copies
        // are dead weight from here (see releaseGeometryArrays).
        if (!isStatic && !isFreeOrbit) releaseGeometryArrays(modelRoot);
        if (posterEl) {
          // Instant when a loader was involved: the viewer pops in, it does
          // not crossfade with its own poster.
          if (loadGate) posterEl.style.transition = "none";
          posterEl.style.opacity = "0";
          posterEl.style.pointerEvents = "none";
        }

        // The model is on screen and can be dragged from this moment. The
        // loader is let go of NOW, not waited for: releasing it only tells it
        // that nothing is loading any more, and it then finishes the crossing
        // it is in (faster than its loading pace) and goes inside its own
        // safe window, never mid-part (see js/loader.js). Meanwhile it plays
        // out over the live model — it is click-through and above the canvas,
        // so a drag started under it works. Before, the viewer sat invisible
        // behind the poster until that crossing was over, up to most of a
        // 4-second cycle after the model was ready.
        if (loadGate) loadGate.done();

        scheduleIdleNudge();
        if (options.onReady) options.onReady();
      })
      // Previously absent, which made any model/HDRI failure an unhandled
      // promise rejection — noisy, and on a page with several viewers,
      // repeating. Both branches already logged the real cause on their
      // way to rejecting, so there's nothing to add here: the viewer just
      // stops at "poster still showing", the same degraded state a product
      // with no model at all gets. reportError() (shared with
      // handleContextLost above) is what actually calls options.onError,
      // letting a caller (the grid, the product-page carousel) put its own
      // static icon back instead of leaving a dead box.
      .catch(reportError);

    // ---- idle reset / nudge / drift state (per-instance) ----
    var isDragging = false;
    var waitingForSettle = false;
    var pauseTimeoutId = null;
    var resetTweenActive = false;
    var resetTweenStartTime = 0;
    var resetTweenFromPosition = new THREE.Vector3();
    var resetTweenFromUp = new THREE.Vector3();
    var nudgeActive = false;
    var nudgePhase = 0;
    var nudgePhaseStartTime = 0;
    var idleTimeoutId = null;
    var lastFrameTime = null;
    var lastAngularSpeed = 0; // rad/s, previous frame's spin rate — see PROGRESSIVE_BOOST_* above

    var eyeDirection = new THREE.Vector3();
    var eyeDirectionPrev = new THREE.Vector3();
    var preFrameUp = new THREE.Vector3();
    var tangentTowardUp = new THREE.Vector3();
    var restRef = new THREE.Vector3();
    var driftDelta = new THREE.Vector3();
    var fromDirection = new THREE.Vector3();
    var toDirection = new THREE.Vector3();
    var tweenDirection = new THREE.Vector3();

    function cancelReturnToPose() {
      waitingForSettle = false;
      resetTweenActive = false;
      if (pauseTimeoutId) {
        clearTimeout(pauseTimeoutId);
        pauseTimeoutId = null;
      }
    }

    function clearIdleTimer() {
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
    }

    function cancelNudge() {
      nudgeActive = false;
      clearIdleTimer();
      nudgeHandEl.style.opacity = "0";
    }
    allCancelNudgeFns.push(cancelNudge);

    var nudgePlays = 0;
    function scheduleIdleNudge() {
      clearIdleTimer();
      if (options.nudge === false || interactionSuppressed || isStatic || noAutoMotion() || viewerPaused) return;
      if (touchDevice && nudgePlays >= NUDGE_MAX_PLAYS_TOUCH) return;
      idleTimeoutId = setTimeout(function () {
        idleTimeoutId = null;
        nudgePlays++;
        nudgePhase = 0;
        nudgePhaseStartTime = performance.now();
        nudgeActive = true;
      }, IDLE_NUDGE_DELAY);
    }

    controls.addEventListener("start", function () {
      isDragging = true;
      cancelReturnToPose();
      cancelNudge();
    });
    controls.addEventListener("end", function () {
      isDragging = false;
      waitingForSettle = true;
    });

    // Detected via our own pointer tracking (not TrackballControls' "start"
    // event, which fires on any pointerdown regardless of movement) so a
    // bare tap/click doesn't count as "they've discovered it's draggable" —
    // only a real drag past a small threshold suppresses the nudge. Skipped
    // entirely in static/harness mode — headless, nothing to ever suppress.
    //
    // Registered through wrapperListeners rather than directly, so
    // dispose() can take them off again. This matters far more than it
    // looks: each of these handlers is a closure over the whole
    // buildThreeViewer() invocation — renderer, scene, controls, the
    // decoded model — and a listener on an element is reachable from that
    // element. As long as anything anywhere still referenced this
    // wrapper's <div> (and something does: three.js's own WebGL context
    // teardown keeps the canvas reachable for a while after
    // forceContextLoss), every viewer the grid had ever built stayed
    // fully in memory, disposed or not. Measured on the Bones grid before
    // this: 26 live WebGLRenderers after two scroll passes with zero
    // viewers actually on screen, growing linearly with every further
    // pass.
    var wrapperListeners = [];
    function addWrapperListener(type, handler) {
      wrapperListeners.push([type, handler]);
      wrapper.addEventListener(type, handler);
    }

    // Same idea for listeners this viewer has to put on shared objects
    // (document/window) rather than on its own DOM. These are the ones it
    // would be easiest to leak — nothing about a document-level listener
    // goes away when the wrapper is removed from the page — and each is a
    // closure over this whole invocation, exactly like the wrapper
    // listeners above. Populated further down (see the render-on-demand
    // block); torn down in dispose() alongside them.
    var globalListeners = [];
    function addGlobalListener(targetEl, type, handler) {
      globalListeners.push([targetEl, type, handler]);
      targetEl.addEventListener(type, handler);
    }

    if (!isStatic) {
      var suppressDragStartX = null;
      var suppressDragStartY = null;
      addWrapperListener("pointerdown", function (e) {
        suppressDragStartX = e.clientX;
        suppressDragStartY = e.clientY;
      });
      addWrapperListener("pointermove", function (e) {
        if (interactionSuppressed || suppressDragStartX === null) return;
        var dx = e.clientX - suppressDragStartX;
        var dy = e.clientY - suppressDragStartY;
        if (Math.sqrt(dx * dx + dy * dy) > 6) suppressNudgeEverywhere();
      });
      addWrapperListener("pointerup", function () {
        suppressDragStartX = null;
        suppressDragStartY = null;
      });
    }

    function ignore() {}
    var handle = {
      el: wrapper,
      // Resolves when the model's download-and-decode and the environment
      // have both finished, one way or the other — and, unlike onReady and
      // onError, whether or not the viewer was disposed first. A dispose
      // cannot cancel a decode that is already running (three's loaders take
      // no abort signal), so the work carries on to completion and frees its
      // result on arrival; this is how a caller that rations concurrent
      // loads (js/main.js's grid) can wait for the work to actually end
      // instead of assuming that discarding the viewer ended it.
      whenSettled: Promise.all([modelPromise.then(ignore, ignore), environmentPromise.then(ignore, ignore)]),
      applyMetal: function (newMetalKey) {
        currentMetal = newMetalKey;
        if (modelLoaded) applyMaterial();
        // The camera hasn't moved, so the render-on-demand loop below
        // would otherwise skip every frame and leave the old finish on
        // screen indefinitely — this is the "something changed that isn't
        // camera motion" signal it watches for.
        needsRender = true;
      },
      setCameraOrbit: function (orbitConfig) {
        frameCamera(orbitConfig);
        renderer.render(scene, camera);
      },
      // Blueprint viewers only (options.blueprint; a no-op otherwise): how
      // far the metal -> wireframe sweep has gone (`sweep`) and how far the
      // fit has (`fit`: the shrink that makes room for the brackets, which
      // fade in over its end), 0 to 1 each. Can be set before the model has
      // arrived — its first frame is then drawn at those amounts.
      setBlueprint: function (sweep, fit) {
        if (!blueprint) return;
        sweep = Math.max(0, Math.min(1, Number(sweep) || 0));
        fit = Math.max(0, Math.min(1, Number(fit) || 0));
        if (sweep === blueprintSweep && fit === blueprintFit) return;
        blueprintSweep = sweep;
        blueprintFit = fit;
        needsRender = true;
      },
      // The chosen ring size over the model's base size: the model (once the
      // fit has been made) and its dimension labels scale with it.
      setSize: function (factor) {
        if (!blueprint) return;
        factor = Math.max(0.3, Math.min(1.5, Number(factor) || 1));
        if (factor === sizeFactor) return;
        sizeFactor = factor;
        paintLabels();
        needsRender = true;
      },
      // Where the sweep's cut is on screen — pixels from the top of this
      // viewer — when it is at the very bottom of the model (`bottom`) and
      // at the very top (`top`), for the model as it is before the fit. The
      // cut moves in a straight line between the two with `sweep`. null
      // until the model is in.
      scanSpan: function () {
        if (!blueprint || !frameSphere || !modelLoaded) return null;
        camera.updateMatrixWorld();
        var v = bpScratch.copy(frameSphere.center).applyMatrix4(camera.matrixWorldInverse);
        var depth = -v.z;
        if (!(depth > 0)) return null;
        var r = frameSphere.radius * 1.02;
        var k = camera.projectionMatrix.elements[5] / depth;
        return {
          bottom: (1 - (v.y - r) * k) / 2 * currentHeight,
          top: (1 - (v.y + r) * k) / 2 * currentHeight
        };
      },
      // The viewer is out of sight: no drawing and no idle nudge until it's
      // back (it then redraws once, in case the canvas was discarded).
      setPaused: function (paused) {
        paused = !!paused;
        if (paused === viewerPaused) return;
        viewerPaused = paused;
        if (paused) {
          cancelNudge();
        } else {
          needsRender = true;
          if (modelLoaded) scheduleIdleNudge();
        }
      },
      // Whether the dimension brackets exist (a blueprint viewer whose
      // product has its min-box, once the model is in).
      hasBrackets: function () {
        return !!minBox;
      },
      // Internal handles, unused by the interactive site — exist so
      // scripts/auto-render.js's render harness can add its own top-shot-
      // only lighting/shadow-plane setup without that scope leaking into
      // the shared production builder itself. `target` (scene-tool.html
      // only) is the live orbit-center Vector3 controls.target itself —
      // mutated in place via .copy(), never reassigned, so exposing the
      // reference once here stays correct for as long as the handle lives.
      scene: scene,
      camera: camera,
      renderer: renderer,
      target: controls.target,
      // Teardown for any caller that builds-and-replaces a viewer
      // mid-session — scene-tool.html, and js/main.js's grid, which
      // disposes a card's viewer as soon as it scrolls clear. Without it,
      // rebuilding mid-session would leak: the animate loop keeps
      // recursing on a detached canvas forever, TrackballControls' own
      // window-level keydown/keyup listeners are never released, and the
      // ResizeObserver is never disconnected. Idempotent — a double
      // dispose (or a dispose racing a caller's own cleanup) is a no-op
      // rather than a second forceContextLoss() on a dead context.
      dispose: function () {
        if (isDisposed) return;
        isDisposed = true;
        // A loader still waiting on this viewer has nothing left to wait for.
        if (loadGate) loadGate.done();
        cancelReturnToPose();
        clearIdleTimer();
        // The one piece of teardown that isn't about GPU resources, and
        // the one that was missing: without it this viewer's cancelNudge
        // — and through it the entire closure, model geometry included —
        // stays reachable from the module-level registry forever. See the
        // comment on allCancelNudgeFns.
        unregisterCancelNudge(cancelNudge);
        // Same reasoning as the registry above, for the DOM side — see
        // wrapperListeners' own comment. controls.dispose() below only
        // covers TrackballControls' own listeners, not these.
        wrapperListeners.forEach(function (pair) {
          wrapper.removeEventListener(pair[0], pair[1]);
        });
        wrapperListeners.length = 0;
        // The document/window ones matter more than the wrapper ones: the
        // shared targets they're attached to outlive this viewer by the
        // whole page, so a missed removal here retains the entire closure
        // (renderer, scene, decoded model) for good.
        globalListeners.forEach(function (triple) {
          triple[0].removeEventListener(triple[1], triple[2]);
        });
        globalListeners.length = 0;
        // Same closure-retention concern as wrapperListeners above, just on
        // the canvas rather than the wrapper — handleContextLost is a
        // closure over this entire buildThreeViewer() invocation too.
        renderer.domElement.removeEventListener("webglcontextlost", handleContextLost, false);
        resizeObserver.disconnect();
        controls.dispose();
        // Beyond the renderer/controls/observer teardown above, the loaded
        // model's own GPU buffers and the environment's PMREM texture are
        // real GPU memory too, tied to THIS renderer's context — freeing
        // just the renderer/controls left both to linger until GC. Needed
        // now that js/main.js's grid lazily builds/disposes a viewer per
        // card on scroll rather than building one, page-lifetime — without
        // a real teardown here, repeated build/dispose cycles would leak
        // exactly the GPU memory this whole lazy scheme exists to cap.
        // Anything still in flight at this point is freed by the
        // isDisposed branches in the two load callbacks instead.
        // Before the model: the edge lines share its position buffers, and
        // disposing either geometry deletes those (a second delete is a
        // no-op).
        disposeBlueprint();
        disposeObject3D(modelRoot);
        releaseHeldCpuBytes();
        if (environmentTarget) environmentTarget.dispose();
        scene.environment = null;
        renderer.dispose();
        var liveIndex = liveRenderers.indexOf(renderer);
        if (liveIndex !== -1) liveRenderers.splice(liveIndex, 1);
        // renderer.dispose() alone frees the renderer's own bookkeeping
        // (shader program cache, render lists) but doesn't reliably return
        // the underlying WebGL context to the browser — forceContextLoss
        // does, and is what actually frees up a slot against the browser's
        // finite per-page WebGL context budget (js/main.js's grid can hit
        // this repeatedly now, unlike the old build-once-per-page-load
        // caller this method was originally written for).
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        // Neither call above shrinks the canvas, and WebKit keeps a canvas's
        // backing store (its multisample buffer included) until the element
        // itself is garbage-collected — which, for a canvas that something
        // still happens to reference for a while, can be long after this.
        // Resizing it to a single pixel hands that memory back now.
        renderer.domElement.width = 1;
        renderer.domElement.height = 1;
      }
    };

    // Static/harness mode never starts this loop — only explicit render()
    // calls happen (from the load callback above, and from
    // setCameraOrbit()), so nothing (release inertia, the leveling drift,
    // the idle nudge) can shift the framing between the harness's onReady
    // firing and its screenshot actually being taken a few ms later.
    if (isStatic) return handle;

    // ---- render-on-demand bookkeeping ---------------------------------
    // The pose the canvas currently SHOWS, as opposed to the pose the
    // camera currently holds. Every frame below updates the camera, then
    // only actually draws if the two have diverged by more than a
    // sub-pixel amount (or if needsRender flags a non-camera change).
    //
    // This loop used to end in an unconditional renderer.render(), so a
    // viewer that had finished loading and was sitting perfectly still
    // still issued a full WebGL draw 60+ times a second, forever, for as
    // long as it existed. On the homepage that's every live card in the
    // grid at once, permanently — a constant GPU/battery/thermal draw for
    // pixels identical to the ones already on screen, and on a phone the
    // thermal throttling that causes makes the *next* real interaction
    // worse. Comparing angles rather than world-space distances keeps the
    // threshold meaningful regardless of how large a given model is.
    //
    // The catch, and it is not hypothetical: skipping redundant draws is
    // only safe while the canvas actually KEEPS what was last drawn into
    // it. Every viewer here is created with preserveDrawingBuffer: false
    // (the default; only auto-render.js's harness sets it true), which
    // explicitly licenses the browser to throw the drawing buffer away
    // after compositing it — and iOS Safari genuinely does, under memory
    // pressure, on tab/app backgrounding, and on a bfcache restore. No
    // webglcontextlost fires for this: the context stays perfectly alive,
    // only the pixels are gone, so handleContextLost's icon fallback never
    // triggers either. The old unconditional per-frame render hid this
    // completely by repainting within ~16ms of any discard; with
    // render-on-demand, an idle viewer that has settled never draws again,
    // and the blank canvas is permanent until the page is reloaded. On
    // this site the easiest way to hit it is the most ordinary navigation
    // there is: tap a product, press Back, and every model on the restored
    // homepage is gone.
    //
    // So: flag a redraw on each documented occasion the buffer can come
    // back empty. needsRender (rather than a direct render() call) so the
    // repaint lands in the normal animate-loop path — on a bfcache restore
    // or a tab return, rAF is paused at the moment these fire, and drawing
    // straight into a context the compositor isn't servicing yet is how
    // you get a frame that's silently dropped anyway.
    function requestRepaint() {
      needsRender = true;
    }
    // Tab/app switch return. Fires on the way out too (visibilityState
    // "hidden"), which is harmless — the flag just sits set until the loop
    // resumes, which is exactly when it's wanted.
    addGlobalListener(document, "visibilitychange", requestRepaint);
    // Back/forward bfcache restore — the case above that this site hits
    // most. Not gated on event.persisted: a normal load fires pageshow too,
    // where the flag is redundant rather than wrong (the load path renders
    // once itself), and the gate would only add a way to get this wrong.
    addGlobalListener(window, "pageshow", requestRepaint);
    // If the browser DOES restore a genuinely lost context, three.js
    // re-initializes its GL state automatically, but nothing asks for the
    // first frame back. Costs one listener to not leave that blank.
    addGlobalListener(renderer.domElement, "webglcontextrestored", requestRepaint);

    var renderedEye = new THREE.Vector3();
    var renderedUp = new THREE.Vector3();
    // Its own scratch vector rather than reusing eyeDirection: that one is
    // the else-branch's frame-to-frame angular-speed state (it's read via
    // eyeDirectionPrev at the top of the next frame), and writing to it
    // from here — which also runs during the nudge/reset tweens, where the
    // else branch isn't maintaining it — would quietly feed a bogus dt
    // into lastAngularSpeed on the first frame after a tween ends.
    var currentEye = new THREE.Vector3();
    var hasRenderedOnce = false;
    // ~0.006 degrees: far below one pixel of movement at any canvas size
    // this site uses, so nothing perceptible is ever skipped. Also smaller
    // than SETTLE_ANGULAR_VELOCITY * dt, so a release always registers as
    // settled (arming the ease-back-to-default) BEFORE drawing stops —
    // never the other way round, which would strand the camera wherever
    // the inertia happened to fade out.
    var STILL_ANGLE_EPSILON = 1e-4;

    function drawIfChanged() {
      currentEye.copy(camera.position).sub(controls.target).normalize();
      var changed = needsRender ||
                    !hasRenderedOnce ||
                    currentEye.angleTo(renderedEye) > STILL_ANGLE_EPSILON ||
                    camera.up.angleTo(renderedUp) > STILL_ANGLE_EPSILON;
      if (!changed) return;

      needsRender = false;
      hasRenderedOnce = true;
      renderedEye.copy(currentEye);
      renderedUp.copy(camera.up);
      if (blueprint) updateBlueprint();
      renderer.render(scene, camera);
    }

    (function animate(now) {
      if (isDisposed) return; // torn down mid-session (scene-tool.html) — stop recursing for good
      requestAnimationFrame(animate);

      // requestAnimationFrame hands us a real timestamp, so dt is measured
      // rather than assumed — everything below scales with it instead of
      // running at a fixed per-frame rate. Clamped so a backgrounded-tab
      // resume (or a long GC pause) doesn't apply minutes of decay/drift in
      // one jump.
      var dt = lastFrameTime === null ? REF_DT : Math.min((now - lastFrameTime) / 1000, 1 / 15);
      lastFrameTime = now;

      // handle.setPaused(true): the viewer is out of sight (the product
      // page's last stage), so nothing moves and nothing is drawn.
      if (viewerPaused) return;

      if (!modelLoaded) {
        return; // nothing to render/animate yet — poster is showing
      }

      if (nudgeActive) {
        var nt = Math.min(1, (performance.now() - nudgePhaseStartTime) / ROLLBACK_DURATION);
        var neased = cubicBezierEase(nt, ROLLBACK_BEZIER[0], ROLLBACK_BEZIER[1], ROLLBACK_BEZIER[2], ROLLBACK_BEZIER[3]);

        slerpVectors(tweenDirection, nudgeWaypoints[nudgePhase], nudgeWaypoints[(nudgePhase + 1) % 3], neased);
        camera.position.copy(tweenDirection).multiplyScalar(defaultRadius).add(controls.target);
        restUpRaw(camera.up, tweenDirection, defaultRollRad);
        if (camera.up.lengthSq() < 1e-8) camera.up.copy(defaultCameraUp);
        else camera.up.normalize();
        camera.lookAt(controls.target);

        var handFrom = HAND_OFFSETS[nudgePhase];
        var handTo = HAND_OFFSETS[(nudgePhase + 1) % 3];
        var handOffsetPx = handFrom + (handTo - handFrom) * neased;
        nudgeHandEl.style.opacity = "1";
        // The source art's index-fingertip isn't at the image's own center
        // (it's the pointer's *tip* that needs to land on the model's
        // center, not the icon's bounding-box middle) — a fixed 40px
        // downward nudge past the normal center-anchor closes that gap.
        nudgeHandEl.style.transform = "translate(-50%, -50%) translateY(20px) translateX(" + handOffsetPx + "px)";

        if (nt >= 1) {
          nudgePhase++;
          if (nudgePhase >= 3) {
            nudgeActive = false;
            nudgeHandEl.style.opacity = "0";
            scheduleIdleNudge();
          } else {
            nudgePhaseStartTime = performance.now();
          }
        }
      } else if (resetTweenActive) {
        var t = Math.min(1, (performance.now() - resetTweenStartTime) / ROLLBACK_DURATION);
        var eased = cubicBezierEase(t, ROLLBACK_BEZIER[0], ROLLBACK_BEZIER[1], ROLLBACK_BEZIER[2], ROLLBACK_BEZIER[3]);

        fromDirection.copy(resetTweenFromPosition).sub(controls.target).normalize();
        toDirection.copy(defaultCameraPosition).sub(controls.target).normalize();
        slerpVectors(tweenDirection, fromDirection, toDirection, eased);
        camera.position.copy(tweenDirection).multiplyScalar(defaultRadius).add(controls.target);

        slerpVectors(camera.up, resetTweenFromUp, defaultCameraUp, eased);
        camera.lookAt(controls.target);
        if (t >= 1) {
          resetTweenActive = false;
          scheduleIdleNudge();
        }
      } else {
        // Both the spin's own momentum (TrackballControls rotating .up
        // right along with the eye) and the leveling drift want to move
        // .up this frame. Taking drift's delta from .up as it stood BEFORE
        // this frame's momentum update, then adding it to .up as
        // controls.update() leaves it, means drift isn't reacting to (and
        // partially undoing) whatever momentum just did.
        preFrameUp.copy(camera.up);
        var slowness = 1 - Math.min(1, lastAngularSpeed / PROGRESSIVE_BOOST_SPEED);
        var lambdaThisFrame = SPIN_DECAY_LAMBDA * (1 + slowness * PROGRESSIVE_BOOST_MAX);
        controls.dynamicDampingFactor = 1 - Math.exp(-2 * lambdaThisFrame * dt);
        // Re-asserted per frame, not just at construction — see its own
        // comment there. controls.update() reads it, so it has to be right
        // for the frame that is about to consume it.
        controls.staticMoving = noAutoMotion();
        controls.update();

        eyeDirectionPrev.copy(eyeDirection);
        eyeDirection.copy(camera.position).sub(controls.target).normalize();
        lastAngularSpeed = eyeDirectionPrev.angleTo(eyeDirection) / dt;

        var poleAlignment = Math.abs(eyeDirection.dot(WORLD_UP));

        // freeOrbit and reduced motion both skip this leveling-drift
        // correction entirely — camera.up (and therefore the framing) stays
        // exactly wherever the drag left it, with no auto-correction ever
        // nudging it back toward level. It's the subtlest of the four, and
        // the most unsettling to watch if you didn't ask for it: the image
        // rotates slowly under a stationary pointer. freeOrbit wants this
        // off for a second reason beyond "let a pose stay put": roll (the
        // camera's orientation around its own view axis) is now a real,
        // savable part of a product's `3d-viewer-camera-default` — see
        // frameCamera()'s `roll` handling above — and this drift would
        // otherwise fight whatever roll a free-drag just dialed in.
        //
        // The attractor is the resting up for the current eye direction
        // (restUpRaw with the product's own roll), not WORLD_UP itself: the
        // resting pose then sits exactly on a fixed point (tangent is 0),
        // so an authored roll holds instead of decaying toward level, and a
        // roll-0 model stops churning camera.up along the view axis (an
        // invisible change that still defeated render-on-demand). Left
        // unnormalized, its length is sin(angle from the pole), which makes
        // the in-plane pull for roll 0 identical to the old WORLD_UP-based
        // one, sin^2 fade near the poles included. It flips sign crossing a
        // pole, but s and tangentTowardUp flip together, so driftDelta
        // doesn't — the same two-attractor continuity as before, the two
        // attractors now being the authored roll and roll + 180deg.
        if (!noAutoMotion()) {
          restUpRaw(restRef, eyeDirection, defaultRollRad);
          var s = preFrameUp.dot(restRef);
          tangentTowardUp.copy(restRef).addScaledVector(preFrameUp, -s);
          var driftRateThisFrame = 1 - Math.exp(-DRIFT_RATE * dt);
          driftDelta.copy(tangentTowardUp).multiplyScalar(driftRateThisFrame * s * (1 - poleAlignment));
          camera.up.add(driftDelta).normalize();
        }
        camera.lookAt(controls.target);

        if (waitingForSettle && !isDragging) {
          var frameAngle = eyeDirectionPrev.angleTo(eyeDirection);
          if (frameAngle < SETTLE_ANGULAR_VELOCITY * dt) {
            waitingForSettle = false;
            // freeOrbit and reduced motion both skip arming the
            // ease-back-to-default reset too — combined with staticMoving
            // above (no coasting) and the drift skip just above (no
            // up-vector correction), the camera simply stays exactly where
            // the drag left it once released.
            if (!noAutoMotion()) {
              pauseTimeoutId = setTimeout(function () {
                pauseTimeoutId = null;
                resetTweenFromPosition.copy(camera.position);
                resetTweenFromUp.copy(camera.up);
                resetTweenStartTime = performance.now();
                resetTweenActive = true;
              }, POST_INERTIA_PAUSE);
            }
          }
        }
      }

      drawIfChanged();
    })();

    return handle;
  }

  window.EmjiveModelViewer = buildThreeViewer;
  // Tool-only (scene-tool.html) — a live reference to the module's one
  // METAL_PRESETS object, not a copy. applyMetal()/buildThreeViewer's own
  // material application always re-reads METAL_PRESETS[metalKey] fresh on
  // every call, so the tool's shader-tuning sliders can mutate this object
  // in place (color/metalness/roughness for whichever metal is selected)
  // and just re-invoke applyMetal()/rebuild to preview the change — no
  // separate override-parameter mechanism needed. Never read by the
  // interactive site or by scripts/auto-render.js.
  window.EmjiveModelViewer.METAL_PRESETS = METAL_PRESETS;
  // Tool/render-only, like the above: the swatch scene's camera for a
  // { rotation, tilt, roll }.
  window.EmjiveModelViewer.swatchOrbit = swatchOrbit;
})();
