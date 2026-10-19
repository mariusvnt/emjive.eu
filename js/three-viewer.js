// The 3D viewer (three.js + TrackballControls): free pole-crossing rotation,
// release inertia, a leveling drift, an idle nudge hint and an ease back to
// the default pose. Instanced and parameterized per product and container.
// Exposes window.EmjiveModelViewer(product, metalKey, options) -> handle, also
// used by scripts/auto-render.js and scene-tool.html.
//
// An ES module because it imports "three" (resolved by Vite). The classic
// scripts reach window.EmjiveModelViewer through window.EmjiveLoadViewer()
// (js/viewer-entry.js), which resolves once this module has run.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";

// Shared with js/stack-scene.js (a lazy chunk importing this module) so both
// draw models identically: the Draco decoder, HDR cache, metals, renderer
// settings and camera orientation. Assigned at the end of the function below.
var toolkit = null;
export { toolkit };

(function () {
  "use strict";

  var H = window.EmjiveHelpers;

  // ---- Draco decoding ----
  // ONE decoder for the page: a DRACOLoader per load is the most-reported cause
  // of Draco failing on iOS Safari (three.js#22445), each spawning its own
  // workers and WASM heap. Self-hosted (assets/draco/, copied from three's
  // package) to keep the site free of external requests; only Draco models
  // fetch it.
  var dracoLoader = new DRACOLoader();
  // Resolved against the document: DRACOLoader resolves relative paths against
  // the page URL, which breaks for pages outside the root. vite.config.js drops
  // three's own bundled decoder copies because of this call.
  dracoLoader.setDecoderPath(new URL("assets/draco/", document.baseURI).href);
  // At most 2 workers: each viewer decodes one model, and every worker holds its
  // own copy of the WASM heap, which phones can't afford.
  dracoLoader.setWorkerLimit(Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1)));

  // Preload the decoder alongside the first .glb instead of after it. Only on
  // pages that show a model, and only once.
  var dracoPreloaded = false;
  function preloadDracoDecoder() {
    if (dracoPreloaded) return;
    dracoPreloaded = true;
    dracoLoader.preload();
  }

  // One GLTFLoader for every load: it holds no per-context state.
  var gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // ---- counters for the ?mem=1 overlay (js/viewer-entry.js) ----
  // cpuGeometryBytes: live geometry still held as JS arrays, which should fall
  // to ~0 once every live model has drawn (see releaseGeometryArrays).
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

  // ---- releasing the Draco workers ----
  // A worker's WASM heap only grows with the models it decodes;
  // terminating an idle one frees it, and DRACOLoader starts a new one on the
  // next decode. Not DRACOLoader.dispose(), which revokes the worker source URL
  // the loader still uses. workerPool is a private field, hence the guard.
  // Delayed after the last load so close loads don't each pay for a new
  // worker; immediate when the page hides, when iOS reclaims memory.
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

  // GLTFLoader.load, counted, so the release knows when no decode is running.
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

  // Fallback only: callers pass options.hdri from data/series.json's "hdris"
  // (this module is series-unaware, and the render harness never loads js/series.js).
  // The one HDRI path outside data/series.json: keep it in step with the file.
  var DEFAULT_HDRI_SRC = "assets/hdri/studio_kontrast_04_1k.hdr";
  var DEFAULT_ORBIT = { rotation: 0, tilt: 75, zoom: 105 };
  var WORLD_UP = new THREE.Vector3(0, 1, 0);

  // The PBR material replacing every model's own, per metal: data/series.json's
  // "metal-shaders". Read from the loaded index on the site; the tools, which
  // don't load js/series.js, hand it over with setMetalShaders().
  var metalShaders = null;
  var FALLBACK_SHADER = { color: [128, 128, 128], metalness: 1, roughness: 0.2 };

  function shaderFor(metalKey) {
    var series = window.EmjiveSeries;
    var all = metalShaders || (series && series.index && series.index["metal-shaders"]) || {};
    return all[metalKey] || FALLBACK_SHADER;
  }

  // Always a fresh material, so a glTF's own maps never survive. DoubleSide:
  // the thin open bands show their back faces at some angles.
  function metalMaterial(metalKey) {
    var shader = shaderFor(metalKey);
    return new THREE.MeshStandardMaterial({
      // The channels are linear factors, applied as they are.
      color: new THREE.Color(shader.color[0] / 255, shader.color[1] / 255, shader.color[2] / 255),
      metalness: shader.metalness,
      roughness: shader.roughness,
      side: THREE.DoubleSide
    });
  }

  // ---- blueprint (options.blueprint, the product page's specs stage) ----
  // A horizontal cut, level on screen, sweeps up the model: above it the metal,
  // below it a flat grey shaded like a 3D editor's solid view (one fixed light,
  // no reflections). Appended after <colorspace_fragment>, so the grey is an
  // sRGB value. The cut is a thin black line while sweeping.
  var BLUEPRINT_FRAGMENT = [
    "{",
    "  float bpY = -vViewPosition.y;",
    "  float bpLit = dot( normalize( normal ), normalize( vec3( -0.35, 0.5, 0.8 ) ) );",
    "  vec3 bpGrey = vec3( mix( 0.4, 0.84, clamp( bpLit * 0.5 + 0.5, 0.0, 1.0 ) ) );",
    "  gl_FragColor.rgb = mix( gl_FragColor.rgb, bpGrey, step( bpY, uScanY ) );",
    "  float bpPx = fwidth( bpY );",
    "  float bpCut = 1.0 - smoothstep( bpPx * 0.5, bpPx * 1.5, abs( bpY - uScanY ) );",
    "  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 0.0 ), bpCut * uScanOn );",
    "}"
  ].join("\n");

  // The size factors the page scales a model by: its "size-range" over the
  // size it's drawn at, and 1 (no size given). The fit leaves room for the largest.
  function sizeFactors(product) {
    var range = H.sizeRange(product);
    return {
      min: Math.min(1, range.min / H.REFERENCE_SIZE_MM),
      max: Math.max(1, range.max / H.REFERENCE_SIZE_MM)
    };
  }

  // { rotation, tilt, zoom, roll } -> radians and a zoom percent (100% exactly
  // frames the bounding sphere). rotation turns around, tilt is up/down (90 =
  // eye level), roll turns the picture (optional, default 0).
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
      // Optional [x, y, z] to orbit instead of the model's centre (swatchOrbit).
      target: Array.isArray(cfg.target) ? new THREE.Vector3(cfg.target[0], cfg.target[1], cfg.target[2]) : null,
      // Optional vertical fov in degrees (the swatch); null keeps the camera's.
      fov: typeof cfg.fov === "number" ? cfg.fov : null
    };
  }

  // The resting up for an eye direction: WORLD_UP's component perpendicular to
  // it, turned by rollRad. Unnormalized on purpose: its length, sin(angle from
  // the pole), is the fade the leveling drift wants, and it goes to zero (not
  // NaN) at the poles.
  function restUpRaw(out, eyeDir, rollRad) {
    out.copy(WORLD_UP).addScaledVector(eyeDir, -WORLD_UP.dot(eyeDir));
    return out.applyAxisAngle(eyeDir, rollRad);
  }

  // The metal swatches (scene-tool.html, scripts/auto-render.js): one scene of a
  // single sphere under an HDRI, the material swapped between renders
  // (applyMetal), so only the metal differs. applyMaterial() gives it the metal.
  var SWATCH_SPHERE_RADIUS = 1;
  // Camera distance in sphere radii: a mild perspective.
  var SWATCH_DISTANCE = 12;

  function buildSwatchStack() {
    var group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.SphereGeometry(SWATCH_SPHERE_RADIUS, 96, 64)));
    return group;
  }

  // frameCamera() measures the bounding sphere of the bounding box: sqrt(3) radii.
  var SWATCH_GROUP_RADIUS = Math.sqrt(3) * SWATCH_SPHERE_RADIUS;

  // The swatch camera for `angles` ({ rotation, tilt, roll } in degrees,
  // data/series.json "swatch-camera"; defaults 0, 90, 0), looking at the
  // centre. The rest is solved: at distance d the sphere's silhouette has
  // angular radius asin(r / d), and the frame is the largest square inside that
  // disc, so fov = 2 * atan(tan(asin(r / d)) / sqrt(2)). frameCamera() stands at
  // sphereRadius / sin(fov / 2) * zoom / 100, giving zoom = d * sin(fov / 2) / sphereRadius.
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

  // Cubic-bezier easing (control points (x1, y1), (x2, y2)), solved by
  // Newton-Raphson as browsers do for CSS.
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
      u = H.clamp01(u - x / dx);
    }
    return componentAt(u, y1, y2);
  }

  // Slerp between unit vectors: constant angular speed and stable near
  // antipodal pairs, which a free spin across a pole can produce.
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

  // ---- HDRI environment ----
  // Built per viewer: a PMREM texture belongs to the renderer that made it, and
  // a shared one renders other contexts' models black (the scene has no lights).
  // The decoded pixels are context-free, though, so the fetch and decode are
  // cached per URL (one in-flight promise for simultaneous viewers), each
  // viewer wrapping them in its own throwaway DataTexture. A failed load evicts
  // its entry so a later viewer can retry.
  // hdriSrc comes from the caller (js/series.js hdriPath()), else DEFAULT_HDRI_SRC.
  var hdrSourceCache = {};
  var hdrLoadsInFlight = 0;

  // three's loaders take no AbortSignal: a stalled request is rejected after
  // this (generous: a large model on a slow link) and abandoned.
  var LOAD_TIMEOUT_MS = 90000;

  // ---- decoding off the main thread ----
  // Downloaded here (matching the page's preload) and decoded by
  // js/hdr-worker.js. Only when bundled by Vite (import.meta.env defined); any
  // failure falls back to HDRLoader.parse() on the main thread, the same code.
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

  // The fields loadEnvironment() reads; a DataTexture is made per renderer from them.
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
      // Copied, not transferred, so the buffer remains for the fallback.
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
          // Evicted so a later viewer can retry.
          delete hdrSourceCache[src];
          throw err;
        }
      );
    }
    return hdrSourceCache[src];
  }

  // The decoded HDRI (half-float RGBA, several times its file) lives outside the JS
  // heap for the document's life. Released when the page hides or is frozen,
  // when iOS wants the memory; the next viewer re-decodes. Not while loads are
  // in flight: clearing then would only trigger a second decode.
  function releaseHdrSources() {
    if (hdrLoadsInFlight > 0) return;
    hdrSourceCache = {};
  }

  window.addEventListener("pagehide", releaseHdrSources);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") releaseHdrSources();
  });

  // isStale(): the viewer was torn down while this loaded; resolve null rather
  // than render PMREM into a dead context.
  // blurPx (optional): a gaussian blur of the HDRI, sigma in HDRI pixels
  // ("swatch-blur"). fromEquirectangular() can't blur, so the HDRI becomes a
  // scene background through fromScene(), whose sigma is in radians.
  function loadEnvironment(renderer, hdriSrc, isStale, blurPx) {
    var src = hdriSrc || DEFAULT_HDRI_SRC;
    var pmremGenerator = new THREE.PMREMGenerator(renderer);
    // Synchronous: catch it so it rejects like every other failure, rather than
    // throwing out of the viewer's constructor and leaking its context.
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
        // A per-call DataTexture sharing the cached pixels; disposing it frees only
        // the GPU copy, so the cache survives.
        var image = sourceTexture.image;
        var equirect = new THREE.DataTexture(image.data, image.width, image.height, sourceTexture.format, sourceTexture.type);
        equirect.colorSpace = sourceTexture.colorSpace;
        equirect.magFilter = sourceTexture.magFilter;
        equirect.minFilter = sourceTexture.minFilter;
        equirect.generateMipmaps = sourceTexture.generateMipmaps;
        equirect.flipY = sourceTexture.flipY;
        equirect.needsUpdate = true;

        // The caller owns the whole render target (pmremGenerator.dispose() frees only
        // its scratch resources).
        var renderTarget;
        if (blurPx > 0) {
          // A full turn of longitude is image.width px; cube faces a quarter of that, as fromEquirectangular() makes them.
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
      // Reject so a failed HDRI falls through to the poster fallback instead of hanging.
      function (err) {
        pmremGenerator.dispose();
        console.error("emjive: failed to load HDRI environment", src, err);
        throw err;
      }
    );
  }

  // ---- session-wide nudge suppression ----
  // Once the visitor has dragged any viewer this session, no viewer nudges.
  // sessionStorage, so a new visit gets the hint again; per page where it's unavailable.
  var INTERACTION_SEEN_KEY = "emjive_model_interacted";
  var interactionSuppressed = H.readStorage("sessionStorage", INTERACTION_SEEN_KEY) === "1";
  // Live viewers' cancelNudge functions. Each closes over its whole viewer
  // (scene, renderer, geometry), so dispose() must unregister it or every viewer
  // ever built stays in memory.
  var allCancelNudgeFns = [];

  function unregisterCancelNudge(cancel) {
    var i = allCancelNudgeFns.indexOf(cancel);
    if (i !== -1) allCancelNudgeFns.splice(i, 1);
  }

  function suppressNudgeEverywhere() {
    interactionSuppressed = true;
    // Copied first: a cancel may unregister itself mid-loop.
    allCancelNudgeFns.slice().forEach(function (cancel) {
      cancel();
    });
    H.writeStorage("sessionStorage", INTERACTION_SEEN_KEY, "1");
  }

  var POST_INERTIA_PAUSE = 420; // ms of stillness after stopping, before easing back
  var ROLLBACK_DURATION = 1200; // ms
  var ROLLBACK_BEZIER = [0.65, 0, 0.35, 1]; // gentle at both ends
  var IDLE_NUDGE_DELAY = 3000; // ms without interaction before the nudge plays
  // On touch devices the nudge plays this many times per viewer and then rests:
  // endlessly replaying it keeps every live model redrawing, against a phone's
  // thermal and memory budget. A mouse keeps it endless.
  var NUDGE_MAX_PLAYS_TOUCH = 2;
  var touchDevice = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  var NUDGE_ANGLE_RAD = (15 * Math.PI) / 180;
  var HAND_OFFSETS = [0, -40, 40]; // px, index-matched to the three nudge waypoints
  var DRIFT_RATE = 1.5; // 1/s, continuous leveling rate
  var SETTLE_ANGULAR_VELOCITY = 0.024; // rad/s treated as stopped
  // How much harder a model brakes when stopping to go home (reset button) than when coasting.
  var HOME_BRAKE_SCALE = 4;
  var REF_DT = 1 / 60;
  // Progressive braking: plain exponential decay trails off forever. Below
  // PROGRESSIVE_BOOST_SPEED the decay rate ramps up toward PROGRESSIVE_BOOST_MAX
  // times its base as the speed nears zero, so a spin stops crisply.
  var PROGRESSIVE_BOOST_SPEED = 0.5; // rad/s
  var PROGRESSIVE_BOOST_MAX = 4;

  // ---- prefers-reduced-motion ----
  // A live MediaQueryList, read per frame and per timer, so an OS toggle applies
  // without a listener to clean up. Local rather than shared: scene-tool.html
  // loads this module without js/series.js.
  var reducedMotion = H.reducedMotion;

  // ---- the spin ----
  // How a model turns under a drag and comes home: TrackballControls rotation
  // (heavier than the pointer), coasting with progressive braking, the leveling
  // drift, then a pause and the ease back to the default pose. Shared by every
  // viewer and the wheel's focused model (toolkit.spinFor).
  //
  // `camera` orbits `controls.target`. options:
  //   noAutoMotion()  true: no coasting, drift or ease back
  //   home()          the default pose: { position, up, rollRad, radius }
  //   pauseScale()    optional multiplier of POST_INERTIA_PAUSE
  //   onHome()        optional: the ease back has arrived
  //   autoReturn()    optional, default true: false leaves a released model where
  //                   it is; only goHome(true) brings it back
  //   onAway(away)    optional: turned off its default pose (true) or back/returning (false)
  //
  // The damping seed assumes 60fps; step() re-derives the per-frame factor from
  // SPIN_DECAY_LAMBDA and the real dt, so the spin-down is frame-rate independent
  // (TrackballControls.update() takes no dt).
  var SPIN_DAMPING_SEED = 0.04032;
  var SPIN_DECAY_LAMBDA = (-0.5 * Math.log(1 - SPIN_DAMPING_SEED)) / REF_DT;

  function createSpin(camera, controls, options) {
    // Rotation only.
    controls.noZoom = true;
    controls.noPan = true;
    // Less rotation per drag distance: a heavier feel.
    controls.rotateSpeed = 0.5;
    controls.dynamicDampingFactor = SPIN_DAMPING_SEED;
    // No momentum under noAutoMotion. Re-asserted every frame in step(), since
    // reduced motion can change and controls.update() is called from several places.
    controls.staticMoving = options.noAutoMotion();

    var isDragging = false;
    var waitingForSettle = false;
    // goHome(true) during a coast: stop first (waitingForSettle), then roll home.
    var homeWhenSettled = false;
    var pauseTimeoutId = null;
    var resetTweenActive = false;
    var resetTweenStartTime = 0;
    var resetTweenFromPosition = new THREE.Vector3();
    var resetTweenFromUp = new THREE.Vector3();
    var lastAngularSpeed = 0; // rad/s, the previous frame's spin rate (progressive braking)
    // Whether the eye stands more than AWAY_ANGLE off the default pose (reported via onAway).
    var away = false;
    var AWAY_ANGLE = 0.03; // rad, ~1.7 degrees
    function setAway(value) {
      if (value === away) return;
      away = value;
      if (options.onAway) options.onAway(away);
    }

    var eyeDirection = new THREE.Vector3();
    var eyeDirectionPrev = new THREE.Vector3();
    var preFrameUp = new THREE.Vector3();
    var tangentTowardUp = new THREE.Vector3();
    var restRef = new THREE.Vector3();
    var driftDelta = new THREE.Vector3();
    var fromDirection = new THREE.Vector3();
    var toDirection = new THREE.Vector3();
    var tweenDirection = new THREE.Vector3();

    function cancelReturn() {
      waitingForSettle = false;
      homeWhenSettled = false;
      resetTweenActive = false;
      if (pauseTimeoutId) {
        clearTimeout(pauseTimeoutId);
        pauseTimeoutId = null;
      }
    }

    function onStart() {
      isDragging = true;
      cancelReturn();
    }
    function onEnd() {
      isDragging = false;
      waitingForSettle = true;
    }
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);

    // One frame; dt in seconds.
    function step(dt) {
      var home = options.home();
      if (resetTweenActive) {
        var t = Math.min(1, (performance.now() - resetTweenStartTime) / ROLLBACK_DURATION);
        var eased = cubicBezierEase(t, ROLLBACK_BEZIER[0], ROLLBACK_BEZIER[1], ROLLBACK_BEZIER[2], ROLLBACK_BEZIER[3]);

        fromDirection.copy(resetTweenFromPosition).sub(controls.target).normalize();
        toDirection.copy(home.position).sub(controls.target).normalize();
        slerpVectors(tweenDirection, fromDirection, toDirection, eased);
        camera.position.copy(tweenDirection).multiplyScalar(home.radius).add(controls.target);

        slerpVectors(camera.up, resetTweenFromUp, home.up, eased);
        camera.lookAt(controls.target);
        if (t >= 1) {
          resetTweenActive = false;
          setAway(false);
          if (options.onHome) options.onHome();
        }
        return;
      }

      // The drift's delta is taken from .up before this frame's momentum update and
      // added after it, so the drift doesn't partly undo the momentum.
      preFrameUp.copy(camera.up);
      var slowness = 1 - Math.min(1, lastAngularSpeed / PROGRESSIVE_BOOST_SPEED);
      var lambdaThisFrame = SPIN_DECAY_LAMBDA * (1 + slowness * PROGRESSIVE_BOOST_MAX) * (homeWhenSettled ? HOME_BRAKE_SCALE : 1);
      controls.dynamicDampingFactor = 1 - Math.exp(-2 * lambdaThisFrame * dt);
      // Re-asserted per frame (see the constructor).
      controls.staticMoving = options.noAutoMotion();
      controls.update();

      eyeDirectionPrev.copy(eyeDirection);
      eyeDirection.copy(camera.position).sub(controls.target).normalize();
      lastAngularSpeed = eyeDirectionPrev.angleTo(eyeDirection) / dt;

      var poleAlignment = Math.abs(eyeDirection.dot(WORLD_UP));

      // The leveling drift, pulling .up toward the resting up for the current eye
      // direction (with the product's roll), so an authored roll holds and a level
      // model stops churning. Its length fades the pull near the poles; its sign
      // flips crossing a pole together with s, so driftDelta stays continuous.
      // Skipped under noAutoMotion and when autoReturn is off.
      if (!options.noAutoMotion() && (!options.autoReturn || options.autoReturn())) {
        restUpRaw(restRef, eyeDirection, home.rollRad);
        var s = preFrameUp.dot(restRef);
        tangentTowardUp.copy(restRef).addScaledVector(preFrameUp, -s);
        var driftRateThisFrame = 1 - Math.exp(-DRIFT_RATE * dt);
        driftDelta.copy(tangentTowardUp).multiplyScalar(driftRateThisFrame * s * (1 - poleAlignment));
        camera.up.add(driftDelta).normalize();
      }
      camera.lookAt(controls.target);

      if (options.onAway && !away && !homeWhenSettled) {
        toDirection.copy(home.position).sub(controls.target).normalize();
        if (eyeDirection.angleTo(toDirection) > AWAY_ANGLE) setAway(true);
      }

      if (waitingForSettle && !isDragging) {
        var frameAngle = eyeDirectionPrev.angleTo(eyeDirection);
        if (frameAngle < SETTLE_ANGULAR_VELOCITY * dt) {
          waitingForSettle = false;
          if (homeWhenSettled) {
            homeWhenSettled = false;
            beginHome();
            return;
          }
          // The ease back is armed only with auto motion and autoReturn; otherwise the
          // camera stays where the drag left it.
          if (!options.noAutoMotion() && (!options.autoReturn || options.autoReturn())) {
            pauseTimeoutId = setTimeout(function () {
              pauseTimeoutId = null;
              resetTweenFromPosition.copy(camera.position);
              resetTweenFromUp.copy(camera.up);
              resetTweenStartTime = performance.now();
              resetTweenActive = true;
            }, POST_INERTIA_PAUSE * (options.pauseScale ? options.pauseScale() : 1));
          }
        }
      }
    }

    // Straight into the ease back, no pause. Skipped under noAutoMotion unless
    // forced (a visitor's request); nothing to do if already home.
    function goHome(force) {
      if ((!force && options.noAutoMotion()) || isDragging) return;
      // Still coasting: brake harder (HOME_BRAKE_SCALE) to a stop, then the settle
      // in step() sends it home.
      if (!controls.staticMoving && lastAngularSpeed > SETTLE_ANGULAR_VELOCITY) {
        cancelReturn();
        waitingForSettle = true;
        homeWhenSettled = true;
        setAway(false);
        return;
      }
      beginHome();
    }
    function beginHome() {
      // Discard TrackballControls' stored release momentum, or it resumes at the home pose.
      controls._lastAngle = 0;
      controls._movePrev.copy(controls._moveCurr);
      lastAngularSpeed = 0;
      var home = options.home();
      fromDirection.copy(camera.position).sub(controls.target).normalize();
      toDirection.copy(home.position).sub(controls.target).normalize();
      if (fromDirection.angleTo(toDirection) < 1e-4 && camera.up.angleTo(home.up) < 1e-4) {
        setAway(false);
        return;
      }
      cancelReturn();
      // On its way: not away, unless a drag takes it again.
      setAway(false);
      resetTweenFromPosition.copy(camera.position);
      resetTweenFromUp.copy(camera.up);
      resetTweenStartTime = performance.now();
      resetTweenActive = true;
    }

    return {
      step: step,
      cancelReturn: cancelReturn,
      goHome: goHome,
      isAway: function () { return away; },
      // Not at rest in its default pose: dragging, coasting, pausing or easing back.
      isBusy: function () {
        return isDragging || waitingForSettle || pauseTimeoutId !== null || resetTweenActive;
      },
      dispose: function () {
        cancelReturn();
        controls.removeEventListener("start", onStart);
        controls.removeEventListener("end", onEnd);
      }
    };
  }

  // Builds a viewer for a product and returns a handle (metal swaps keep the
  // loaded model and the camera). options.onReady fires once the model is
  // loaded, framed and painted; options.onError when the model or HDRI never
  // arrives, or the context is lost, so the caller can restore its fallback.
  function buildThreeViewer(product, metalKey, options) {
    options = options || {};
    // Render-harness only (scripts/auto-render.js): `static` has no animate loop
    // or nudge, rendering only on explicit calls, so nothing shifts the framing
    // before the screenshot.
    var isStatic = !!options.static;
    // scene-tool.html only: full dragging, but nothing moves the pose afterwards,
    // so it can be read back and saved (roll included).
    var isFreeOrbit = !!options.freeOrbit;
    // Reduced motion wants the same four behaviors off as freeOrbit (inertia, the
    // ease back, the leveling drift, the nudge): nothing moves that the visitor
    // didn't move. Dragging stays. A function, so the media query stays live.
    function noAutoMotion() {
      return isFreeOrbit || reducedMotion.matches;
    }
    // The canvas is always transparent; this only enables preserveDrawingBuffer
    // for the harness's screenshot readback.
    var preserveBuffer = !!options.transparentBackground;
    // js/product.js only: { lineColor }. Enables the metal -> blueprint sweep,
    // the wireframe and the fit scale, driven by handle.setBlueprint(sweep, fit);
    // at 0, 0 it draws like a plain viewer.
    var blueprint = options.blueprint && !options.swatch ? options.blueprint : null;

    var wrapper = document.createElement("div");
    wrapper.className = "emjive-3d-viewer";
    // One named picture for screen readers.
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
      // The page's WebGL contexts are finite and the constructor throws once
      // they're exhausted; null lets callers fall back to the icon.
      console.error("emjive: could not create a WebGL context for", product.name, err);
      return null;
    }
    liveRenderers.push(renderer);
    // Canvas memory is width * height * pixelRatio^2 * 4 bytes, doubled by MSAA,
    // and iOS Safari caps the page's total; callers with several viewers pass a
    // lower maxPixelRatio.
    var maxPixelRatio = typeof options.maxPixelRatio === "number" ? options.maxPixelRatio : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    // The wireframe's clipping plane needs this.
    if (blueprint) renderer.localClippingEnabled = true;
    renderer.domElement.className = "emjive-3d-viewer__canvas";
    wrapper.appendChild(renderer.domElement);

    // The pre-load poster: fallback-img, the model's own default-orbit capture,
    // so it lines up with the first frame (the icon is cropped differently).
    // Fixed to the initial metal. options.poster: false for callers with their
    // own image behind the viewer.
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

    // The loader over the poster while the model and environment load; released
    // when the model is ready, finishing its crossing over the live model.
    //   options.loader = a hold   a loader the caller mounted elsewhere, released here
    //   options.loader = false    none
    //   otherwise                 one inside this viewer's box; options.loaderBleed
    //                             lets it reach the clipping ancestor's edges
    // Never for the static harness or pages without js/loader.js.
    var loadGate = null;
    if (!isStatic && options.loader !== false && window.EmjiveLoader) {
      loadGate = options.loader && typeof options.loader.done === "function"
        ? options.loader
        : window.EmjiveLoader.mount(wrapper, { bleed: !!options.loaderBleed });
    }

    // Its pixels come from a backdrop-filter invert masked to the hand's shape (CSS).
    var nudgeHandEl = document.createElement("div");
    nudgeHandEl.className = "emjive-3d-viewer__nudge-hand";
    wrapper.appendChild(nudgeHandEl);

    // options.hitCircle: the margin share of the width around a circle that
    // alone takes drags (0.25: radius three quarters of the viewer's). An overlay
    // clipped to it carries the controls; clip-path clips hit-testing, so presses
    // outside fall through (to the page's scrolling).
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

    // Read by both async load chains: a viewer disposed before its downloads
    // land is the normal case during a fast scroll.
    var isDisposed = false;

    // onError fires at most once, from either a load failure or a later context loss.
    var hasErrored = false;
    function reportError() {
      if (isDisposed || hasErrored) return;
      hasErrored = true;
      // The loader's wait is over; the poster or the caller's icon stays.
      if (loadGate) loadGate.done();
      if (options.onError) options.onError();
    }

    // iOS Safari reclaims WebGL contexts under memory pressure, often long after
    // loading, leaving a blank canvas nothing else would notice. Not restored
    // (such losses are often unrecoverable): reported like a load failure, so
    // the caller shows its icon.
    function handleContextLost() {
      console.error("emjive: WebGL context lost for", product.name);
      reportError();
    }
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost, false);

    // Frees a model's GPU resources; also used for models arriving after dispose().
    function disposeObject3D(root) {
      if (!root) return;
      root.traverse(function (node) {
        if (!node.isMesh) return;
        if (node.geometry) node.geometry.dispose();
        disposeMaterial(node.material);
      });
    }

    // A Draco model decodes to typed arrays many times its file's size, which
    // three.js keeps for the geometry's life, though the GPU has its own copy.
    function eachGeometryBuffer(root, visit) {
      root.traverse(function (node) {
        if (!node.isMesh || !node.geometry) return;
        var geometry = node.geometry;
        Object.keys(geometry.attributes).forEach(function (name) {
          // Only plain buffer attributes (Draco produces no interleaved ones).
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

    // After the first frame nothing reads the arrays again (metal swaps only
    // replace materials, bounds are computed before release, a lost context
    // rebuilds from the file), so they are freed. Not for the harness or the scene
    // tool, which re-frame and read the scene back.
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

    // Awaited together with the model (Promise.all), so the first frame never
    // renders before the environment lands. The whole render target is kept so
    // dispose() can free it.
    var environmentTarget = null;
    // options.environment === false: none (a blueprint-only viewer).
    var environmentPromise = options.environment === false ? Promise.resolve() : loadEnvironment(renderer, options.hdri, function () { return isDisposed; }, options.environmentBlur).then(function (renderTarget) {
      // Arrived after dispose(): free it. (null when loadEnvironment saw the teardown first.)
      if (isDisposed) {
        if (renderTarget) renderTarget.dispose();
        return;
      }
      environmentTarget = renderTarget;
      scene.environment = renderTarget.texture;
    });

    // Sized synchronously so the first frame is right before the observer fires.
    var currentWidth = 1;
    var currentHeight = 1;
    // Set by changes that need a repaint without camera motion (resize, metal
    // swap); consumed once per frame by the animate loop.
    var needsRender = false;
    // The animate loop's pending frame (startLoop); 0 while stopped.
    var loopRaf = 0;
    // Every such change goes through here, which also restarts a stopped loop.
    function invalidate() {
      needsRender = true;
      startLoop();
    }
    // `controls` is hoisted and assigned before this runs again.
    function applySize(w, h) {
      w = Math.max(1, w);
      h = Math.max(1, h);
      if (w === currentWidth && h === currentHeight) return;
      currentWidth = w;
      currentHeight = h;
      renderer.setSize(w, h, false); // false: leave CSS sizing alone
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // The render-on-demand loop only redraws on camera motion.
      invalidate();
      // A static viewer has no loop, and setSize() just cleared the canvas: redraw,
      // or the harness can screenshot a blank one. Not after dispose or detachment
      // (auto-render clears the page between renders).
      if (isStatic && modelLoaded && !isDisposed && wrapper.isConnected) {
        renderer.render(scene, camera);
      }
      // TrackballControls caches the element rect only at construction, when the
      // wrapper is still detached (0x0, making every drag NaN). Re-sync on every resize.
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
    // The shared spin (createSpin), easing back to frameCamera's defaults; the
    // idle nudge is scheduled once home.
    var spin = createSpin(camera, controls, {
      noAutoMotion: noAutoMotion,
      home: function () {
        return { position: defaultCameraPosition, up: defaultCameraUp, rollRad: defaultRollRad, radius: defaultRadius };
      },
      pauseScale: function () { return rollbackPauseScale; },
      autoReturn: function () { return autoReturn; },
      onAway: options.onAway,
      onHome: function () { scheduleIdleNudge(); }
    });

    var defaultOrbit = product["3d-viewer-camera-default"] || DEFAULT_ORBIT;
    var explicitTarget = parseTargetString(product.cameraTarget);

    var defaultCameraPosition = new THREE.Vector3();
    var defaultCameraUp = new THREE.Vector3();
    var defaultRollRad = 0;
    var defaultRadius = 0;
    var nudgeWaypoints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

    // The model's bounding sphere at its own size: a blueprint viewer's fit scale
    // is set aside while measuring (the next draw restores it).
    function measureModel() {
      if (fitGroup) {
        fitGroup.scale.setScalar(1);
        fitGroup.position.set(0, 0, 0);
        fitGroup.updateMatrixWorld(true);
      }
      var box = new THREE.Box3().setFromObject(modelRoot);
      return box.getBoundingSphere(new THREE.Sphere());
    }

    function frameCamera(orbitConfig) {
      if (!modelRoot) return;
      var orbit = parseOrbitConfig(orbitConfig);
      var sphere = measureModel();
      frameSphere = sphere.clone();
      framedRadius = sphere.radius * (orbit.radiusPercent / 100);
      if (fitGroup) invalidate();
      var target = orbit.target || explicitTarget || sphere.center;
      if (orbit.fov !== null && orbit.fov !== camera.fov) {
        camera.fov = orbit.fov;
        camera.updateProjectionMatrix();
      }
      var fovRad = (camera.fov * Math.PI) / 180;
      var distance = (sphere.radius / Math.sin(fovRad / 2)) * (orbit.radiusPercent / 100);
      // Near/far fitted to the scene, for depth precision on the thin double-sided bands.
      camera.near = Math.max(0.01, distance - sphere.radius * 2);
      camera.far = distance + sphere.radius * 4;
      var offset = new THREE.Vector3(
        distance * Math.sin(orbit.phiRad) * Math.sin(orbit.thetaRad),
        distance * Math.cos(orbit.phiRad),
        distance * Math.sin(orbit.phiRad) * Math.cos(orbit.thetaRad)
      );

      controls.target.copy(target);
      camera.position.copy(target).add(offset);

      // The up vector from restUpRaw() with the authored roll, so the resting pose,
      // roll included, is a fixed point of the ease back, the drift and the nudge.
      var eyeDir = offset.clone().normalize();
      restUpRaw(camera.up, eyeDir, orbit.rollRad);
      // At the poles (tilt 0, the top shots) restUpRaw() degenerates: use level-up's
      // limit along this meridian, (-cos(tilt) sin(rotation), 0, -cos(tilt) cos(rotation)),
      // the orientation the hero rings' rotations were tuned against. Another axis
      // turns every top shot 180 degrees.
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

      // Nudge waypoints: the default eye direction and it turned +/- NUDGE_ANGLE_RAD
      // about world up. The nudge re-derives up per frame (restUpRaw), so the roll holds.
      nudgeWaypoints[0].copy(defaultCameraPosition).sub(controls.target).normalize();
      nudgeWaypoints[1].copy(nudgeWaypoints[0]).applyAxisAngle(WORLD_UP, NUDGE_ANGLE_RAD);
      nudgeWaypoints[2].copy(nudgeWaypoints[0]).applyAxisAngle(WORLD_UP, -NUDGE_ANGLE_RAD);
    }

    // Read by applyMaterial() and applyMetal().
    var currentMetal = metalKey;
    var modelRoot = null;
    var modelLoaded = false;

    function applyMaterial() {
      if (!modelRoot) return;
      modelRoot.traverse(function (node) {
        if (!node.isMesh) return;
        var previous = node.material;
        node.material = metalMaterial(currentMetal);
        if (blueprint) blueprintMaterial(node.material);
        // The replaced material is freed.
        disposeMaterial(previous);
      });
    }

    /* ---- blueprint (options.blueprint) ----
       The specs stage, driven by handle.setBlueprint(sweep, fit) (0..1 each) and
       handle.setSize(factor):
       - sweep: BLUEPRINT_FRAGMENT's cut at uScanY (view space) going from below
         the model (0: all metal) to above it (1: all grey); handle.scanSpan() gives
         its screen span for the page's band.
       - fit: model and wireframe shrink about the orbit target so the size circle
         (the min-box's reach, product.geometry["min-box"]) fits the canvas, then
         scale with the size factor. */
    var blueprintSweep = 0;
    var blueprintFit = 0;
    var sizeFactor = 1;
    var viewerPaused = false;
    var bpUniforms = null;
    if (blueprint) {
      bpUniforms = {
        uScanY: { value: -1e6 },
        uScanOn: { value: 0 }
      };
    }
    // The group holding the model and wireframe, scaled by the fit.
    var fitGroup = null;
    var fitScale = 1;
    // The min-box's (or bounding sphere's) farthest reach from the orbit target, world units (computeFit).
    var fitReach = 0;
    // What frameCamera() framed: the sphere and the radius the view fits (sphere x zoom).
    var frameSphere = null;
    var framedRadius = 0;
    // The wireframe (assets.wireframe): a second glTF of thin bars in the model's
    // frame, drawn in the line colour and clipped below the cut like the grey.
    var wirePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -1e6);
    var wireRoot = null;
    var wireMaterial = null;
    var wireStarted = false;
    // Bumped when the model changes or is disposed, dropping a wireframe still loading for it.
    var wireGeneration = 0;
    // The wireframe's CPU arrays until uploaded.
    var wireCpuBytes = 0;
    // The model's min-box (readMinBox): only its reach is used.
    var minBox = null;
    function blueprintMaterial(material) {
      material.onBeforeCompile = function (shader) {
        shader.uniforms.uScanY = bpUniforms.uScanY;
        shader.uniforms.uScanOn = bpUniforms.uScanOn;
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform float uScanY;\nuniform float uScanOn;")
          .replace("#include <colorspace_fragment>", "#include <colorspace_fragment>\n" + BLUEPRINT_FRAGMENT);
      };
      material.customProgramCacheKey = function () { return "emjive-blueprint"; };
    }

    // After the first draw the arrays can go (as releaseGeometryArrays does for the model).
    function releaseWireAfterDraw() {
      var geometry = this.geometry;
      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
      Object.keys(geometry.attributes).forEach(function (name) {
        var attribute = geometry.attributes[name];
        if (attribute.array) { wireCpuBytes -= attribute.array.byteLength; window.EmjiveMem.cpuGeometryBytes -= attribute.array.byteLength; attribute.array = null; }
      });
      if (geometry.index && geometry.index.array) {
        wireCpuBytes -= geometry.index.array.byteLength;
        window.EmjiveMem.cpuGeometryBytes -= geometry.index.array.byteLength;
        geometry.index.array = null;
      }
      this.onAfterRender = function () {};
    }

    // Loaded once the model is on screen, into the fit group. None if absent or failing.
    function loadWireframe() {
      var src = product.assets && product.assets.wireframe;
      if (!blueprint || wireStarted || !src || isDisposed || !fitGroup) return;
      wireStarted = true;
      var generation = wireGeneration;
      loadModelFile(src, function (gltf) {
        if (isDisposed || generation !== wireGeneration) {
          disposeObject3D(gltf.scene);
          return;
        }
        wireRoot = gltf.scene;
        wireMaterial = new THREE.MeshBasicMaterial({
          color: new THREE.Color().setStyle(blueprint.lineColor || "#727272"),
          side: THREE.DoubleSide,
          toneMapped: false,
          clippingPlanes: [wirePlane],
          // Pulled toward the camera so the bars win the depth test on the surface,
          // while the model's far side still hides bars behind it.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        });
        wireRoot.traverse(function (node) {
          if (!node.isMesh) return;
          node.material = wireMaterial;
          node.renderOrder = 1;
          node.onAfterRender = releaseWireAfterDraw;
          Object.keys(node.geometry.attributes).forEach(function (name) {
            if (node.geometry.attributes[name].array) wireCpuBytes += node.geometry.attributes[name].array.byteLength;
          });
          if (node.geometry.index && node.geometry.index.array) wireCpuBytes += node.geometry.index.array.byteLength;
        });
        window.EmjiveMem.cpuGeometryBytes += wireCpuBytes;
        fitGroup.add(wireRoot);
        invalidate();
      }, function (err) {
        console.error("emjive: failed to load wireframe", src, err);
      });
    }

    // From product.geometry "min-box" and "dimensions-mm"; without them the bounding sphere's reach is used.
    function readMinBox() {
      var geometry = product.geometry || {};
      var pose = geometry["min-box"];
      var dims = geometry["dimensions-mm"];
      minBox = null;
      if (!pose || !Array.isArray(pose.axes) || pose.axes.length !== 3 || !Array.isArray(dims) || dims.length !== 3) return;
      minBox = {
        center: new THREE.Vector3().fromArray(pose.center),
        axes: pose.axes.map(function (a) { return new THREE.Vector3().fromArray(a).normalize(); }),
        half: dims.map(function (d) { return d / 2; })
      };
    }

    // The shrink making room for the size circle: the box's farthest corner from
    // the target against the framed radius, at the largest size. Measured once framed.
    function computeFit() {
      fitScale = 1;
      fitReach = 0;
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
      }
      fitReach = reach;
      var room = framedRadius * 0.95;
      fitScale = Math.min(1, room / (reach * sizeFactors(product).max));
    }

    var bpCenter = new THREE.Vector3();
    var bpScratch = new THREE.Vector3();
    var bpUp = new THREE.Vector3();

    // Before every draw of a blueprint viewer: the cut's screen height follows the orbit.
    function updateBlueprint() {
      if (!fitGroup || !frameSphere) return;
      var sweep = blueprintSweep;
      // The fit's scale: the circle-fitting shrink times the size factor, blended by `fit`.
      var target = fitScale * sizeFactor;
      var scale = 1 + (target - 1) * blueprintFit;
      fitGroup.scale.setScalar(scale);
      fitGroup.position.copy(controls.target).multiplyScalar(1 - scale);
      fitGroup.updateMatrixWorld(true);
      camera.updateMatrixWorld();

      // The cut: a plane level in view space, from just under the scaled sphere to just over it.
      bpCenter.copy(frameSphere.center).applyMatrix4(fitGroup.matrixWorld);
      var radius = frameSphere.radius * scale * 1.02;
      var cutY = bpScratch.copy(bpCenter).applyMatrix4(camera.matrixWorldInverse).y + (2 * sweep - 1) * radius;
      bpUniforms.uScanY.value = cutY;
      bpUniforms.uScanOn.value = sweep > 0 && sweep < 1 ? 1 : 0;
      // The same plane for the wireframe in world space, through view-space
      // (0, cutY, 0), facing down (three keeps the side its normal points to).
      bpUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      bpScratch.copy(camera.position).addScaledVector(bpUp, cutY);
      wirePlane.setFromNormalAndCoplanarPoint(bpUp.negate(), bpScratch);
    }

    // Removes and frees the blueprint's per-model parts (wireframe, box), on
    // dispose or a model swap, so the next model builds its own.
    function disposeBlueprint() {
      wireGeneration++;
      wireStarted = false;
      if (wireRoot) {
        if (wireRoot.parent) wireRoot.parent.remove(wireRoot);
        disposeObject3D(wireRoot);
        wireRoot = null;
      }
      window.EmjiveMem.cpuGeometryBytes -= wireCpuBytes;
      wireCpuBytes = 0;
      minBox = null;
    }

    // options.swatch: the swatch sphere instead of a glTF (scene-tool.html,
    // scripts/auto-render.js). Everything downstream is agnostic to how modelRoot
    // was built; `product` may be a stub ({ name, "3d-viewer-camera-default" }).
    var modelPromise;
    if (options.swatch) {
      modelRoot = buildSwatchStack();
      applyMaterial();
      scene.add(modelRoot);
      modelPromise = Promise.resolve();
    } else {
      // Overlap the decoder's fetch with the model's; harmless for non-Draco models.
      preloadDracoDecoder();
      modelPromise = new Promise(function (resolve, reject) {
        var loadTimer = setTimeout(function () {
          reject(new Error("Timed out loading " + product.assets.model));
        }, LOAD_TIMEOUT_MS);
        loadModelFile(
          product.assets.model,
          function (gltf) {
            clearTimeout(loadTimer);
            // Arrived after dispose(): free the decoded geometry.
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
              fitGroup = new THREE.Group();
              fitGroup.add(modelRoot);
              readMinBox();
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
        // Both loads free their own late arrivals; this stops the ready path from
        // rendering into a context forceContextLoss() already killed.
        if (isDisposed) return;

        frameCamera(defaultOrbit);
        modelLoaded = true;
        // The page may already be in specs (reload, rebuild): the first frame matches.
        if (blueprint) {
          computeFit();
          updateBlueprint();
        }

        renderer.render(scene, camera);
        // That draw uploaded every buffer; free the JS copies.
        if (!isStatic && !isFreeOrbit) releaseGeometryArrays(modelRoot);
        if (posterEl) {
          // With a loader, the viewer pops in instead of crossfading with its poster.
          if (loadGate) posterEl.style.transition = "none";
          posterEl.style.opacity = "0";
          posterEl.style.pointerEvents = "none";
        }

        // Draggable from now. Release the loader without waiting: it finishes its
        // crossing over the live model (click-through, above the canvas) and leaves
        // in its safe window (js/loader.js).
        if (loadGate) loadGate.done();

        scheduleIdleNudge();
        if (blueprint) loadWireframe();
        if (options.onReady) options.onReady();
        // A model requested while this one was still loading.
        if (pendingSwap) {
          var swap = pendingSwap;
          pendingSwap = null;
          swapModel(swap.next, swap.opts);
        }
      })
      // Both branches logged the cause; reportError hands over to the caller's fallback.
      .catch(reportError);

    // ---- idle nudge state (the spin keeps its own) ----
    // Multiplier of POST_INERTIA_PAUSE before easing back (handle.setRollbackPauseScale).
    var rollbackPauseScale = 1;
    // Whether a released model eases back by itself (handle.setAutoReturn).
    var autoReturn = true;
    var nudgeActive = false;
    var nudgePhase = 0;
    var nudgePhaseStartTime = 0;
    var idleTimeoutId = null;
    var lastFrameTime = null;
    var tweenDirection = new THREE.Vector3();

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
      // A model left off its pose (autoReturn off) would be snapped to the nudge's waypoints.
      if (options.nudge === false || interactionSuppressed || isStatic || noAutoMotion() || viewerPaused || spin.isAway()) return;
      if (touchDevice && nudgePlays >= NUDGE_MAX_PLAYS_TOUCH) return;
      idleTimeoutId = setTimeout(function () {
        idleTimeoutId = null;
        nudgePlays++;
        nudgePhase = 0;
        nudgePhaseStartTime = performance.now();
        nudgeActive = true;
        startLoop();
      }, IDLE_NUDGE_DELAY);
    }

    // The spin cancels its own ease back on drag start (createSpin); the loop
    // runs for the drag and whatever follows it.
    controls.addEventListener("start", cancelNudge);
    controls.addEventListener("start", startLoop);

    // Our own pointer tracking, not TrackballControls' "start" (any pointerdown),
    // so only a real drag suppresses the nudge.
    // Listeners go through wrapperListeners so dispose() removes them: each
    // closes over the whole viewer, and the wrapper stays reachable after
    // teardown (three's context teardown holds the canvas), which kept every
    // disposed viewer in memory.
    var wrapperListeners = [];
    function addWrapperListener(type, handler) {
      wrapperListeners.push([type, handler]);
      wrapper.addEventListener(type, handler);
    }

    // The same for listeners on document/window, which outlive the viewer.
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

    /* ---- swapping the model in place (handle.setProduct) ----
       The product page's design picks: a new model in this viewer rather than a
       new viewer (context, PMREM, compiles, poster) per pick. `next` is the
       product as that design (EmjiveSeries.resolveDesign). The camera stays put
       (a product's designs share one frame) and the old model stays until the new
       one is decoded; then the metal, blueprint state, box and wireframe are redone.
       The latest pick wins; one asked for before the first model waits for it.
       opts: { onReady, onError }. */
    var swapToken = 0;
    var pendingSwap = null;
    var WIRE_AFTER_SWAP_MS = 1500;
    var wireTimer = 0;
    function swapModel(next, opts) {
      opts = opts || {};
      var src = next && next.assets && next.assets.model;
      if (isDisposed || options.swatch || !src) return;
      if (!modelLoaded) {
        pendingSwap = { next: next, opts: opts };
        return;
      }
      var token = ++swapToken;
      clearTimeout(wireTimer);
      if (src === (product.assets && product.assets.model)) {
        product = next;
        if (opts.onReady) opts.onReady();
        return;
      }
      preloadDracoDecoder();
      loadModelFile(src, function (gltf) {
        if (isDisposed || token !== swapToken) {
          disposeObject3D(gltf.scene);
          return;
        }
        var old = modelRoot;
        if (blueprint) disposeBlueprint();
        if (old) {
          if (old.parent) old.parent.remove(old);
          disposeObject3D(old);
        }
        releaseHeldCpuBytes();
        product = next;
        wrapper.setAttribute("aria-label", (next.designName || next.name || "Product") + ", 3D model");
        modelRoot = gltf.scene;
        heldCpuBytes = cpuGeometryBytes(modelRoot);
        window.EmjiveMem.cpuGeometryBytes += heldCpuBytes;
        applyMaterial();
        if (blueprint && fitGroup) {
          fitGroup.add(modelRoot);
          readMinBox();
        } else {
          scene.add(modelRoot);
        }
        // The sweep spans the new model; the view keeps the radius it was framed for.
        frameSphere = measureModel();
        if (blueprint) {
          computeFit();
          updateBlueprint();
        }
        renderer.render(scene, camera);
        if (!isStatic && !isFreeOrbit) releaseGeometryArrays(modelRoot);
        invalidate();
        // Its wireframe once the picks settle, or at once if the sweep is under way.
        if (blueprint) {
          if (blueprintSweep > 0) loadWireframe();
          else wireTimer = setTimeout(loadWireframe, WIRE_AFTER_SWAP_MS);
        }
        if (opts.onReady) opts.onReady();
      }, function (err) {
        if (token !== swapToken) return;
        console.error("emjive: failed to load model", src, err);
        if (opts.onError) opts.onError(err);
      });
    }

    function ignore() {}
    var handle = {
      el: wrapper,
      // Resolves when the model and environment loads have finished either way,
      // even after dispose (three's loaders can't be aborted), for callers that
      // ration concurrent loads.
      whenSettled: Promise.all([modelPromise.then(ignore, ignore), environmentPromise.then(ignore, ignore)]),
      applyMetal: function (newMetalKey) {
        currentMetal = newMetalKey;
        if (modelLoaded) applyMaterial();
        // The render-on-demand loop only redraws on camera motion.
        invalidate();
      },
      setCameraOrbit: function (orbitConfig) {
        frameCamera(orbitConfig);
        renderer.render(scene, camera);
      },
      // Another model in this viewer, camera kept (swapModel).
      setProduct: swapModel,
      // Blueprint viewers only: the metal -> grey sweep and the fit (the shrink
      // for the size circle), 0..1 each. May be set before the model arrives.
      setBlueprint: function (sweep, fit) {
        if (!blueprint) return;
        sweep = H.clamp01(Number(sweep) || 0);
        fit = H.clamp01(Number(fit) || 0);
        if (sweep === blueprintSweep && fit === blueprintFit) return;
        blueprintSweep = sweep;
        blueprintFit = fit;
        // A swapped model's wireframe still waiting for picks to settle is wanted now.
        if (sweep > 0 && modelLoaded) loadWireframe();
        invalidate();
      },
      // The chosen size over the base size; the model scales with it once fitted.
      setSize: function (factor) {
        if (!blueprint) return;
        var bounds = sizeFactors(product);
        factor = H.clamp(Number(factor) || 1, bounds.min, bounds.max);
        if (factor === sizeFactor) return;
        sizeFactor = factor;
        invalidate();
      },
      // The cut's screen position (px from the viewer's top) at the model's bottom
      // and top, before the fit; it moves linearly between them with `sweep`. null
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
      // Multiplier of the stillness before easing back, from the next release.
      setRollbackPauseScale: function (scale) {
        rollbackPauseScale = scale > 0 ? scale : 1;
      },
      // false: a released model stays put (product design stage); onAway reports
      // when it's off its pose, returnHome() brings it back.
      setAutoReturn: function (on) {
        autoReturn = on !== false;
      },
      // Ease back now, even under reduced motion (the visitor asked).
      returnHome: function () {
        cancelNudge();
        spin.goHome(true);
        invalidate();
      },
      // For the page's size circle: the box's reach from the viewer's centre in px
      // at fit 0 and base size, and fitScale. The model's scale at fit f and size
      // factor s is 1 + (fitScale * s - 1) * f; the circle's radius is reachPx
      // times that. null until the model is in.
      sizeRing: function () {
        if (!blueprint || !modelLoaded || !fitReach) return null;
        camera.updateMatrixWorld();
        var depth = camera.position.distanceTo(controls.target);
        if (!(depth > 0)) return null;
        var perUnit = camera.projectionMatrix.elements[5] / depth * currentHeight / 2;
        return { reachPx: fitReach * perUnit, fitScale: fitScale };
      },
      // Out of sight: no drawing or nudge until resumed (then one redraw, in case the canvas was discarded).
      setPaused: function (paused) {
        paused = !!paused;
        if (paused === viewerPaused) return;
        viewerPaused = paused;
        if (paused) {
          cancelNudge();
        } else {
          invalidate();
          if (modelLoaded) scheduleIdleNudge();
        }
      },
      // For scripts/auto-render.js (top-shot lighting) and scene-tool.html
      // (`target`, the live controls.target, mutated in place).
      scene: scene,
      camera: camera,
      renderer: renderer,
      target: controls.target,
      // Idempotent teardown for callers that replace viewers: stops the loop,
      // releases controls' listeners and the ResizeObserver, frees GPU memory and
      // the context.
      dispose: function () {
        if (isDisposed) return;
        isDisposed = true;
        if (loopRaf) cancelAnimationFrame(loopRaf);
        clearTimeout(wireTimer);
        // A loader still waiting has nothing left to wait for.
        if (loadGate) loadGate.done();
        spin.dispose();
        clearIdleTimer();
        // Or the module-level registry keeps the whole viewer reachable.
        unregisterCancelNudge(cancelNudge);
        // controls.dispose() only covers TrackballControls' own listeners.
        wrapperListeners.forEach(function (pair) {
          wrapper.removeEventListener(pair[0], pair[1]);
        });
        wrapperListeners.length = 0;
        // The document/window ones would retain the viewer for the page's life.
        globalListeners.forEach(function (triple) {
          triple[0].removeEventListener(triple[1], triple[2]);
        });
        globalListeners.length = 0;
        // The canvas listener closes over the viewer too.
        renderer.domElement.removeEventListener("webglcontextlost", handleContextLost, false);
        resizeObserver.disconnect();
        controls.dispose();
        // The model's buffers and the PMREM target belong to this context; free them
        // explicitly (late arrivals are freed by the load callbacks). The blueprint's
        // parts first, then the model.
        disposeBlueprint();
        disposeObject3D(modelRoot);
        releaseHeldCpuBytes();
        if (environmentTarget) environmentTarget.dispose();
        scene.environment = null;
        renderer.dispose();
        var liveIndex = liveRenderers.indexOf(renderer);
        if (liveIndex !== -1) liveRenderers.splice(liveIndex, 1);
        // renderer.dispose() doesn't reliably return the context; forceContextLoss()
        // frees a slot in the page's finite context budget.
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        // WebKit keeps the canvas's backing store until the element is collected:
        // shrink it to hand the memory back now.
        renderer.domElement.width = 1;
        renderer.domElement.height = 1;
      }
    };

    // Static viewers never start the loop: only explicit renders, so nothing
    // shifts the framing before the harness's screenshot.
    if (isStatic) return handle;

    // ---- render-on-demand ----
    // The loop updates the camera every frame but draws only when the shown pose
    // differs by more than a sub-pixel angle, or needsRender is set: an idle
    // viewer otherwise redraws identical pixels 60+ times a second. It stops
    // once nothing moves (no drag, coast, pause, ease back, nudge or draw) and
    // while paused or still loading; startLoop() brings it back: invalidate(),
    // a drag's start, the nudge's timer.
    //
    // Drawing on demand is only safe while the canvas keeps its last frame.
    // Without preserveDrawingBuffer the browser may discard it, and iOS Safari
    // does (memory pressure, backgrounding, bfcache restore) with no context
    // loss event, leaving a settled viewer blank. So each such occasion flags a
    // repaint.
    function requestRepaint() {
      invalidate();
    }
    // Tab or app return (firing on the way out too is harmless).
    addGlobalListener(document, "visibilitychange", requestRepaint);
    // bfcache restore, the common case (Back from a product). Not gated on
    // persisted: on a normal load the flag is merely redundant.
    addGlobalListener(window, "pageshow", requestRepaint);
    // A restored context: three reinitializes, but nothing requests a frame.
    addGlobalListener(renderer.domElement, "webglcontextrestored", requestRepaint);

    var renderedEye = new THREE.Vector3();
    var renderedUp = new THREE.Vector3();
    // Not createSpin's eyeDirection, which holds the spin's frame-to-frame state.
    var currentEye = new THREE.Vector3();
    var hasRenderedOnce = false;
    // ~0.006 degrees: well under a pixel, and under SETTLE_ANGULAR_VELOCITY * dt,
    // so a release registers as settled (arming the ease back) before drawing stops.
    var STILL_ANGLE_EPSILON = 1e-4;

    // Returns whether it drew.
    function drawIfChanged() {
      currentEye.copy(camera.position).sub(controls.target).normalize();
      var changed = needsRender ||
                    !hasRenderedOnce ||
                    currentEye.angleTo(renderedEye) > STILL_ANGLE_EPSILON ||
                    camera.up.angleTo(renderedUp) > STILL_ANGLE_EPSILON;
      if (!changed) return false;

      needsRender = false;
      hasRenderedOnce = true;
      renderedEye.copy(currentEye);
      renderedUp.copy(camera.up);
      if (blueprint) updateBlueprint();
      renderer.render(scene, camera);
      return true;
    }

    // Started by rAF, not called: every frame needs rAF's timestamp for its dt.
    function startLoop() {
      if (isStatic || isDisposed || loopRaf) return;
      loopRaf = requestAnimationFrame(animate);
    }

    function animate(now) {
      loopRaf = 0;
      if (isDisposed) return;

      // Measured dt, clamped so a resumed tab doesn't apply minutes of decay at
      // once; a restarted loop's first frame takes REF_DT.
      var dt = lastFrameTime === null ? REF_DT : Math.min((now - lastFrameTime) / 1000, 1 / 15);
      lastFrameTime = now;

      // Paused (out of sight), or the poster still showing: stopped until invalidate().
      if (viewerPaused || !modelLoaded) {
        lastFrameTime = null;
        return;
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
        // The hand art's fingertip isn't its centre: offset it so the tip lands on the model's.
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
      } else {
        // The ease back, or the spin and its drift (createSpin).
        spin.step(dt);
      }

      var drew = drawIfChanged();
      if (nudgeActive || spin.isBusy() || drew || needsRender) loopRaf = requestAnimationFrame(animate);
      else lastFrameTime = null;
    }
    startLoop();

    return handle;
  }

  window.EmjiveModelViewer = buildThreeViewer;
  // The tools' "metal-shaders" (scene-tool.html, the render harness). Kept by
  // reference and re-read by applyMetal(), so the scene tool's sliders preview
  // by mutating it in place.
  window.EmjiveModelViewer.setMetalShaders = function (shaders) {
    metalShaders = shaders || null;
  };
  // The swatch camera for { rotation, tilt, roll } (tools and the render harness).
  window.EmjiveModelViewer.swatchOrbit = swatchOrbit;

  // The orientation of a product's default orbit camera, as frameCamera()
  // leaves it (up, roll, pole fallback). A model turned by its inverse, seen
  // down -Z with +Y up, shows its fallback-img's face.
  function orbitOrientation(orbitConfig) {
    var pose = defaultPose(orbitConfig);
    var camera = new THREE.Object3D();
    camera.position.copy(pose.eyeDir);
    camera.up.copy(pose.up);
    // Object3D.lookAt points +Z at the target, a camera points -Z: look away.
    camera.lookAt(pose.eyeDir.clone().multiplyScalar(2));
    return camera.quaternion.clone();
  }

  // A default orbit camera's eye direction (unit, from the target), up and roll, as frameCamera() sets them.
  function defaultPose(orbitConfig) {
    var orbit = parseOrbitConfig(orbitConfig || DEFAULT_ORBIT);
    var eyeDir = new THREE.Vector3(
      Math.sin(orbit.phiRad) * Math.sin(orbit.thetaRad),
      Math.cos(orbit.phiRad),
      Math.sin(orbit.phiRad) * Math.cos(orbit.thetaRad)
    );
    var up = restUpRaw(new THREE.Vector3(), eyeDir, orbit.rollRad);
    if (up.lengthSq() < 1e-8) {
      var cosTilt = Math.cos(orbit.phiRad);
      up.set(-cosTilt * Math.sin(orbit.thetaRad), 0, -cosTilt * Math.cos(orbit.thetaRad))
        .applyAxisAngle(eyeDir, orbit.rollRad);
    }
    up.normalize();
    return { eyeDir: eyeDir, up: up, rollRad: orbit.rollRad };
  }

  // The focused model's idle turn (spinFor): about its default view's up (a
  // face-on turntable), after IDLE_SPIN_DELAY ms at home, easing over
  // IDLE_SPIN_RAMP s to IDLE_SPIN_SPEED (a turn every 24 s). A drag takes over;
  // back home it waits again. Never under reduced motion.
  var IDLE_SPIN_DELAY = 1500;
  var IDLE_SPIN_RAMP = 1.5;
  var IDLE_SPIN_SPEED = (Math.PI * 2) / 24;

  // A model turned by hand outside a viewer (the wheel's focused model): a
  // stand-in camera on the product's default orbit, one unit out, driven by a
  // drag on hitEl through createSpin, and idling (setIdle) with a slow turn.
  // The model shows that camera's view when turned by the inverse of `quaternion`.
  // onActive(): a drag started, so the caller's stopped loop should run again.
  function spinFor(product, hitEl, onActive) {
    var pose = defaultPose(product && product["3d-viewer-camera-default"]);
    var camera = new THREE.PerspectiveCamera();
    camera.position.copy(pose.eyeDir);
    camera.up.copy(pose.up);
    camera.lookAt(0, 0, 0);
    var home = { position: pose.eyeDir.clone(), up: pose.up.clone(), rollRad: pose.rollRad, radius: 1 };
    var controls = new TrackballControls(camera, hitEl);

    // The idle turn: wanted (idleOn), and from when (idleAt, ms; Infinity until home after a drag).
    var idleOn = false;
    var idleAt = Infinity;
    function armIdle() {
      idleAt = performance.now() + IDLE_SPIN_DELAY;
    }

    var spin = createSpin(camera, controls, {
      noAutoMotion: function () { return reducedMotion.matches; },
      home: function () { return home; },
      onHome: function () { if (idleOn) armIdle(); }
    });
    function onDragStart() {
      idleAt = Infinity;
      if (onActive) onActive();
    }
    controls.addEventListener("start", onDragStart);

    function step(dt) {
      var now = performance.now();
      if (idleOn && now >= idleAt && !spin.isBusy() && !reducedMotion.matches) {
        var ramp = Math.min(1, (now - idleAt) / 1000 / IDLE_SPIN_RAMP);
        var angle = IDLE_SPIN_SPEED * H.smoothstep(0, 1, ramp) * dt;
        // About the default view's up, so the camera's up is the axis and holds still.
        camera.position.applyAxisAngle(home.up, angle);
        camera.up.copy(home.up);
        camera.lookAt(0, 0, 0);
        // Skip the spin's step: its leveling drift would tip the model off this axis.
        return;
      }
      spin.step(dt);
    }

    return {
      quaternion: camera.quaternion,
      step: step,
      // Not at rest: dragging, coasting, waiting or easing home.
      isBusy: spin.isBusy,
      // Needs frames: busy, or idling (the turn, or its delay) outside reduced motion.
      wantsFrames: function () {
        return spin.isBusy() || (idleOn && !reducedMotion.matches);
      },
      // Only the focused model answers drags on the shared hitEl.
      setEnabled: function (on) { controls.enabled = !!on; },
      // The focused model idles; one losing focus goes home.
      setIdle: function (on) {
        on = !!on;
        if (on === idleOn) return;
        idleOn = on;
        if (on) {
          armIdle();
        } else {
          idleAt = Infinity;
          spin.goHome();
        }
      },
      // hitEl moved or resized: drags are measured against it.
      handleResize: function () { controls.handleResize(); },
      dispose: function () {
        controls.removeEventListener("start", onDragStart);
        spin.dispose();
        controls.dispose();
      }
    };
  }

  // Material.dispose() doesn't free its textures, so those are disposed explicitly.
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

  toolkit = {
    loadModelFile: function (src, onLoad, onError) {
      preloadDracoDecoder();
      loadModelFile(src, onLoad, onError);
    },
    loadEnvironment: loadEnvironment,
    metalMaterial: metalMaterial,
    // The viewers' renderer settings, so models look the same in the wheel.
    configureRenderer: function (renderer, maxPixelRatio) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio || 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
    },
    // The default orbit's vertical fov and zoom (1 = bounding sphere fits exactly): what frames a fallback-img.
    defaultFraming: function (product) {
      var orbit = parseOrbitConfig(product && product["3d-viewer-camera-default"]);
      return { fovDeg: orbit.fov !== null ? orbit.fov : 30, zoom: orbit.radiusPercent / 100 };
    },
    orbitOrientation: function (product) {
      return orbitOrientation(product && product["3d-viewer-camera-default"]);
    },
    spinFor: spinFor,
    disposeMaterial: disposeMaterial,
    // For the ?mem=1 read-out (js/viewer-entry.js).
    trackRenderer: function (renderer) { liveRenderers.push(renderer); },
    untrackRenderer: function (renderer) {
      var i = liveRenderers.indexOf(renderer);
      if (i !== -1) liveRenderers.splice(i, 1);
    }
  };
})();
