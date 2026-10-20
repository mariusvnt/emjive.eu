// The wheel's 3D scene: every product's model in one full-screen canvas (one
// WebGL context, one environment map). js/gallery-stack.js owns the layout and
// interaction and drives this through createStackScene()'s handle (setPoses).
// A lazy module chunk (window.EmjiveLoadStack); three-viewer.js's toolkit
// supplies the decoder, HDR cache, the studio's sun, metals, renderer settings,
// camera orientation and the viewers' spin (toolkit.spinFor).
//
// Coordinates: one world unit is PX CSS px; screen point (x, y) is at
// (x / PX, -y / PX); an orthographic camera down -Z sees exactly the screen.
// A model turned by the inverse of its default orbit orientation shows its
// fallback-img's face at that image's size, so the handover moves nothing.
//
// The focused model (setFocus) turns slowly on its own and, under a drag,
// behaves like a viewer's model (coast, ease home, resume).

import * as T from "three";
import { toolkit } from "./three-viewer.js";

// CSS pixels per world unit.
var PX = 100;
var MAX_PIXEL_RATIO = 2;
// dt cap (a tab coming back).
var MAX_DT = 1 / 15;
// A clipping plane's constant that cuts nothing.
var NO_CUT = 1e9;
// The hand view's perspective, applied to a model lying on the hand
// (placeOnHand()): a close camera straight above spreads nearer points outward.
var HAND_VERTEX = [
  "vHandFade = dot( uHandFadePlane.xyz, ( modelMatrix * vec4( transformed, 1.0 ) ).xyz ) + uHandFadePlane.w;",
  "if (uHand > 0.0) {",
  "  float handK = uHandDist / max(uHandDist - (mvPosition.z - uHandCenter.z), 1e-4);",
  "  mvPosition.xy = uHandCenter.xy + (mvPosition.xy - uHandCenter.xy) * mix(1.0, handK, uHand);",
  "  gl_Position = projectionMatrix * mvPosition;",
  "}"
].join("\n");
// The hand view's x-ray look, mixed over the metal by uHand: metal is the
// densest thing on a radiograph, so near-black on this negative, darkest where
// the surface turns away (a ray crosses more metal there), with the
// environment's reflections as a faint grey sheen. Set by data/series.json's
// "hand-shader" (handUniforms()). Appended after <colorspace_fragment>, so the
// greys are sRGB values. The finger hides the ring's far side: it fades out
// with depth over the band placeOnHand() sets (vHandFade, the distance above
// the band's far end).
var HAND_FRAGMENT = [
  "gl_FragColor.a *= smoothstep( 0.0, 1.0, vHandFade / max( uHandFadeWidth, 1e-5 ) );",
  "if ( gl_FragColor.a <= 0.0 ) discard;",
  "if (uHand > 0.0) {",
  "  float xrFacing = abs( dot( geometryNormal, geometryViewDir ) );",
  "  float xrGrey = mix( uHandTone.x, uHandTone.y, pow( xrFacing, uHandTone.z ) );",
  "  #ifdef USE_ENVMAP",
  "  float xrLum = dot( getIBLRadiance( geometryViewDir, geometryNormal, uHandSheen.w ), vec3( 0.2126, 0.7152, 0.0722 ) );",
  "  xrGrey += uHandSheen.x * smoothstep( uHandSheen.y, uHandSheen.z, xrLum / ( 1.0 + xrLum ) );",
  "  #endif",
  "  gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( xrGrey ), uHand );",
  "}"
].join("\n");

// The "hand-shader" settings as HAND_FRAGMENT's uniforms: uHandTone (edge,
// face, falloff), uHandSheen (amount, from, to, roughness), greys 0-1. The
// fade's band is read by placeOnHand().
function handUniforms() {
  var s = toolkit.handShader();
  return {
    uHandTone: { value: new T.Vector3(s.edge / 255, s.face / 255, s.falloff) },
    uHandSheen: { value: new T.Vector4(s.sheen / 255, s["sheen-from"], s["sheen-to"], s["sheen-roughness"]) }
  };
}

var H = window.EmjiveHelpers;

export function createStackScene(options) {
  if (!toolkit) return null;

  var renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    // WebGL contexts are a finite budget; the pictures stay.
    console.error("emjive: no WebGL context for the 3D stack", err);
    return null;
  }
  toolkit.configureRenderer(renderer, MAX_PIXEL_RATIO);
  // The hero's wipe (setWipe()): nothing above it is drawn. Always set, at
  // NO_CUT when idle, as adding or removing a plane recompiles every shader.
  var wipePlane = new T.Plane(new T.Vector3(0, -1, 0), NO_CUT);
  renderer.clippingPlanes = [wipePlane];
  toolkit.trackRenderer(renderer);
  var canvas = renderer.domElement;
  canvas.className = "stack-canvas";
  canvas.setAttribute("aria-hidden", "true");
  options.host.insertBefore(canvas, options.host.firstChild);

  var scene = new T.Scene();
  toolkit.addSun(scene);
  var camera = new T.OrthographicCamera(0, 1, 0, -1, 0.1, 400);
  camera.position.set(0, 0, 200);

  var disposed = false;
  var contextLost = false;
  var paused = false;
  var dirty = true;
  var baseSize = 100;
  var entries = [];
  var byId = {};
  var environmentTarget = null;
  var heldCpuBytes = 0;
  var focusId = null;
  var focusEl = null;
  // Shared by every model's material.
  var handLook = handUniforms();

  // The hand view (straight down), as a rotation of the model.
  var qTop = toolkit.orbitOrientation({ "3d-viewer-camera-default": { rotation: 0, tilt: 0, zoom: 100 } }).invert();
  var zAxis = new T.Vector3(0, 0, 1);
  var tmpQ = new T.Quaternion();
  var yAxis = new T.Vector3(0, 1, 0);
  var tmpPlane = new T.Plane();
  var tmpPlaneTop = new T.Plane();

  function rotZ(deg, out) {
    // Clockwise on screen is about -Z in a y-up world.
    return (out || new T.Quaternion()).setFromAxisAngle(zAxis, -deg * Math.PI / 180);
  }

  /* ---- loading ---- */

  function meshBytes(g) {
    var bytes = 0;
    Object.keys(g.attributes).forEach(function (name) {
      if (g.attributes[name].isBufferAttribute && g.attributes[name].array) bytes += g.attributes[name].array.byteLength;
    });
    if (g.index && g.index.array) bytes += g.index.array.byteLength;
    return bytes;
  }

  function countBytes(bytes) {
    heldCpuBytes += bytes;
    if (window.EmjiveMem) window.EmjiveMem.cpuGeometryBytes += bytes;
  }

  // Free a mesh's CPU arrays once it has drawn (the GPU holds a copy; bounds
  // are computed first, and taps test poses, not meshes). Only after
  // onAfterRender: a model hidden by the filter isn't uploaded yet.
  var drawnMeshes = [];
  function markDrawn() {
    if (!this.userData.released) drawnMeshes.push(this);
  }

  function releaseDrawn() {
    while (drawnMeshes.length) {
      var mesh = drawnMeshes.pop();
      if (mesh.userData.released) continue;
      mesh.userData.released = true;
      mesh.onAfterRender = function () {};
      var g = mesh.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      if (g.boundingSphere === null) g.computeBoundingSphere();
      countBytes(-meshBytes(g));
      Object.keys(g.attributes).forEach(function (name) {
        if (g.attributes[name].isBufferAttribute) g.attributes[name].array = null;
      });
      if (g.index) g.index.array = null;
    }
  }

  function loadModel(src) {
    return new Promise(function (resolve, reject) {
      toolkit.loadModelFile(src, function (gltf) { resolve(gltf.scene); }, reject);
    });
  }

  function loadTexture(src) {
    return new Promise(function (resolve, reject) {
      new T.TextureLoader().load(src, function (texture) {
        texture.colorSpace = T.SRGBColorSpace;
        resolve(texture);
      }, undefined, reject);
    });
  }

  // Bounding sphere in its own frame: what a viewer frames, so what the fallback-img shows.
  function setModel(entry, root) {
    if (disposed) {
      disposeObject(root);
      return;
    }
    var box = new T.Box3().setFromObject(root);
    var sphere = box.getBoundingSphere(new T.Sphere());
    entry.model = root;
    entry.center = sphere.center.clone();
    entry.radius = sphere.radius || 1;
    entry.material = toolkit.metalMaterial(entry.product["default-metal"]);
    // On the hand, the finger hides the far side of its box (its depth there
    // is the box's y): where that box sits.
    entry.cutMin = box.min.y;
    entry.cutHeight = box.max.y - box.min.y;
    // The hand view's camera distance from the model's middle (a viewer's
    // framing at its default zoom, straight down), in model units, and the
    // uniforms: uHand is the hand view's share (perspective, x-ray look, fade);
    // the fade's plane (world, at the band's far end) and width (world units).
    var framing = toolkit.defaultFraming(entry.product);
    entry.handDist = entry.radius * framing.zoom / Math.sin(framing.fovDeg * Math.PI / 360);
    entry.hand = {
      uHandCenter: { value: new T.Vector3() },
      uHandDist: { value: 1 },
      uHand: { value: 0 },
      uHandFadePlane: { value: new T.Vector4(0, 1, 0, NO_CUT) },
      uHandFadeWidth: { value: 1 }
    };
    entry.material.onBeforeCompile = function (shader) {
      shader.uniforms.uHandCenter = entry.hand.uHandCenter;
      shader.uniforms.uHandDist = entry.hand.uHandDist;
      shader.uniforms.uHand = entry.hand.uHand;
      shader.uniforms.uHandFadePlane = entry.hand.uHandFadePlane;
      shader.uniforms.uHandFadeWidth = entry.hand.uHandFadeWidth;
      shader.uniforms.uHandTone = handLook.uHandTone;
      shader.uniforms.uHandSheen = handLook.uHandSheen;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform vec3 uHandCenter;\nuniform float uHandDist;\nuniform float uHand;\nuniform vec4 uHandFadePlane;\nvarying float vHandFade;")
        .replace("#include <project_vertex>", "#include <project_vertex>\n" + HAND_VERTEX);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uHand;\nuniform vec3 uHandTone;\nuniform vec4 uHandSheen;\nuniform float uHandFadeWidth;\nvarying float vHandFade;")
        .replace("#include <colorspace_fragment>", "#include <colorspace_fragment>\n" + HAND_FRAGMENT);
    };
    entry.material.customProgramCacheKey = function () { return "emjive-stack-hand"; };
    root.traverse(function (node) {
      if (!node.isMesh) return;
      toolkit.disposeMaterial(node.material);
      node.material = entry.material;
      // Few models on screen, and off-screen ones must be uploaded before the pull-back reveals them.
      node.frustumCulled = false;
      node.onAfterRender = markDrawn;
      if (node.geometry) countBytes(meshBytes(node.geometry));
    });
    entry.holder.add(root);
  }

  // No model, or one that failed: its picture as a camera-facing sprite.
  function setSprite(entry, texture) {
    if (disposed) {
      texture.dispose();
      return;
    }
    entry.material = new T.SpriteMaterial({ map: texture, transparent: true, toneMapped: false });
    entry.sprite = new T.Sprite(entry.material);
    entry.holder.add(entry.sprite);
  }

  function buildEntry(item) {
    var group = new T.Group();
    var holder = new T.Group();
    group.add(holder);
    scene.add(group);
    var viewQ = toolkit.orbitOrientation(item.product).invert();
    var entry = {
      id: String(item.id),
      product: item.product,
      group: group,
      holder: holder,
      viewQ: viewQ,
      // Resting turn: the default view, or where a drag left it.
      restQ: viewQ.clone(),
      size: 0,
      visible: true,
      opacity: 1,
      pose: null,
      // The viewers' spin, built on first focus.
      spin: null
    };
    var model = item.product.assets && item.product.assets.model;
    var picture = H.posterFor(item.product, item.product["default-metal"]);
    var load = model
      ? loadModel(model).then(function (root) { setModel(entry, root); }, function (err) {
        console.error("emjive: a stack model failed to load", model, err);
        return picture ? loadTexture(picture).then(function (t) { setSprite(entry, t); }) : null;
      })
      : (picture ? loadTexture(picture).then(function (t) { setSprite(entry, t); }) : Promise.resolve());
    entries.push(entry);
    byId[entry.id] = entry;
    return load.catch(function (err) {
      console.error("emjive: a stack item has nothing to show", err);
    });
  }

  /* ---- sizes ----
     An item `size` px across: scaled as its fallback-img shows it in a box that
     size, its sphere centred on the group's origin. A pose's size is the
     group's scale on top. */
  function framingScale(entry, sizePx) {
    var framing = toolkit.defaultFraming(entry.product);
    var halfFov = framing.fovDeg * Math.PI / 360;
    return (sizePx * Math.cos(halfFov)) / (2 * entry.radius * framing.zoom) / PX;
  }

  function setSize(entry, sizePx) {
    if (Math.abs(sizePx - entry.size) < 0.5) return;
    entry.size = sizePx;
    if (entry.model) {
      var k = framingScale(entry, sizePx);
      entry.holder.scale.setScalar(k);
      entry.holder.position.copy(entry.center).multiplyScalar(-k);
    } else if (entry.sprite) {
      var s = sizePx / PX;
      entry.sprite.scale.set(s, s, 1);
    }
  }

  /* ---- camera and canvas ---- */
  // Sized to its layer (.gallery-stage), which ignores the phone's browser bars.
  function resize() {
    var w = Math.max(1, options.host.clientWidth || window.innerWidth);
    var h = Math.max(1, options.host.clientHeight || window.innerHeight);
    renderer.setSize(w, h, false);
    camera.left = 0;
    camera.right = w / PX;
    camera.top = 0;
    camera.bottom = -h / PX;
    camera.updateProjectionMatrix();
    kick();
  }

  /* ---- placing a model ---- */
  function setOpacity(entry, opacity) {
    if (!entry.material) return;
    if (Math.abs(opacity - entry.opacity) >= 1e-3) {
      entry.opacity = opacity;
      entry.material.opacity = opacity;
    }
    if (entry.sprite) return;
    // The hand's fade blends too.
    var transparent = entry.opacity < 1 || entry.hand.uHand.value > 0;
    if (transparent !== entry.material.transparent) {
      entry.material.transparent = transparent;
      entry.material.needsUpdate = true;
    }
  }

  // A pose (js/gallery-stack.js): centre (x, y) and size in screen px, rot
  // (degrees clockwise); fromRing/ringRot/u for a ring's flight off the hand
  // (hand view swinging to rest as u goes 0 -> 1); ring: the hand look's
  // remaining share; alpha.
  function placeFromPose(entry, pose) {
    entry.pose = pose;
    entry.group.position.set(pose.x / PX, -pose.y / PX, 0);
    if (pose.fromRing && pose.u < 1) {
      rotZ(pose.ringRot, tmpQ).multiply(qTop);
      entry.group.quaternion.slerpQuaternions(tmpQ, entry.restQ, H.clamp01(pose.u));
    } else {
      rotZ(pose.rot || 0, entry.group.quaternion).multiply(entry.restQ);
    }
    entry.group.scale.setScalar(entry.size ? pose.size / entry.size : 1);
    placeOnHand(entry, pose);
    twistSprite(entry);
    var alpha = pose.alpha === undefined ? 1 : pose.alpha;
    // A model carries the hand look itself; a sprite (its picture) fades in
    // as the page's hand poster fades out.
    setOpacity(entry, entry.model ? alpha : alpha * (1 - (pose.ring || 0)));
  }

  // On the hand, a ring is drawn in the hand view: faded out with depth where
  // the finger hides it ("hand-shader" fade-top to fade-bottom, fractions of
  // its height from its far side), in a close perspective and the x-ray look.
  // All three give way over u 0 to 0.5 as it swings off, as the hand poster's
  // crossfade does in the pictures.
  function placeOnHand(entry, pose) {
    if (!entry.hand) return;
    var share = pose.fromRing && pose.u < 1 ? 1 - H.smoothstep(0, 0.5, pose.u) : 0;
    entry.hand.uHand.value = share;
    if (share <= 0) {
      entry.hand.uHandFadePlane.value.set(0, 1, 0, NO_CUT);
      return;
    }
    var look = toolkit.handShader();
    tmpPlane.set(yAxis, -(entry.cutMin + entry.cutHeight * look["fade-bottom"] * share));
    tmpPlaneTop.set(yAxis, -(entry.cutMin + entry.cutHeight * look["fade-top"] * share));
    entry.group.updateMatrixWorld(true);
    // The box was measured in the holder's frame.
    tmpPlane.applyMatrix4(entry.holder.matrixWorld);
    tmpPlaneTop.applyMatrix4(entry.holder.matrixWorld);
    entry.hand.uHandFadePlane.value.set(tmpPlane.normal.x, tmpPlane.normal.y, tmpPlane.normal.z, tmpPlane.constant);
    entry.hand.uHandFadeWidth.value = tmpPlane.constant - tmpPlaneTop.constant;
    // The model's middle in view space, and the camera distance at its drawn size.
    camera.updateMatrixWorld();
    entry.hand.uHandCenter.value.setFromMatrixPosition(entry.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    entry.hand.uHandDist.value = entry.handDist * entry.holder.scale.x * entry.group.scale.x;
  }

  // A sprite always faces the camera; it only turns about the view axis.
  function twistSprite(entry) {
    if (!entry.sprite) return;
    var q = entry.group.quaternion;
    entry.material.rotation = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  /* ---- the focused model's spin ----
     A spin steps while its model is focused or still easing home; the resting
     turn is the inverse of the spin's camera. */
  var spunQ = new T.Quaternion();
  function stepSpins(dt) {
    var moved = false;
    entries.forEach(function (entry) {
      if (!entry.spin || !entry.visible) return;
      if (entry.id !== focusId && !entry.spin.isBusy()) return;
      entry.spin.step(dt);
      spunQ.copy(entry.spin.quaternion).invert();
      if (spunQ.angleTo(entry.restQ) < 1e-5) return;
      entry.restQ.copy(spunQ);
      if (entry.pose) placeFromPose(entry, entry.pose);
      moved = true;
    });
    return moved;
  }

  // Whether a spin needs the next frame: the focused one turning or about to,
  // another still easing home.
  function spinsMoving() {
    return entries.some(function (entry) {
      if (!entry.spin || !entry.visible) return false;
      return entry.id === focusId ? entry.spin.wantsFrames() : entry.spin.isBusy();
    });
  }

  /* ---- the loop: draws only when something moved ----
     It runs from the handover, stops when nothing is dirty and no spin moves
     (and while paused), and kick() restarts it: every change marks the scene
     dirty through it. */
  var raf = 0;
  var lastFrame = null;
  var running = false;

  function kick() {
    dirty = true;
    if (!running || disposed || raf) return;
    raf = requestAnimationFrame(frame);
  }

  function draw() {
    if (contextLost) return;
    renderer.render(scene, camera);
    releaseDrawn();
  }

  function frame(now) {
    raf = 0;
    var dt = lastFrame === null ? 1 / 60 : Math.min((now - lastFrame) / 1000, MAX_DT);
    lastFrame = now;
    if (paused || disposed) {
      lastFrame = null;
      return;
    }
    var changed = dirty;
    dirty = false;
    if (stepSpins(Math.max(dt, 1e-3))) changed = true;
    if (changed) draw();
    if (changed || spinsMoving()) raf = requestAnimationFrame(frame);
    else lastFrame = null;
  }

  /* ---- teardown ---- */
  function disposeObject(root) {
    root.traverse(function (node) {
      if (node.geometry) node.geometry.dispose();
      toolkit.disposeMaterial(node.material);
    });
  }

  function onContextLost() {
    contextLost = true;
    console.error("emjive: the 3D stack's WebGL context was lost");
    if (options.onLost) options.onLost();
  }
  canvas.addEventListener("webglcontextlost", onContextLost, false);

  // The browser may discard a canvas's drawing (tab return, page restore).
  function repaint() { kick(); }
  document.addEventListener("visibilitychange", repaint);
  window.addEventListener("pageshow", repaint);

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("webglcontextlost", onContextLost, false);
    document.removeEventListener("visibilitychange", repaint);
    window.removeEventListener("pageshow", repaint);
    entries.forEach(function (entry) {
      if (entry.spin) entry.spin.dispose();
      disposeObject(entry.group);
    });
    if (environmentTarget) environmentTarget.dispose();
    if (window.EmjiveMem) window.EmjiveMem.cpuGeometryBytes -= heldCpuBytes;
    heldCpuBytes = 0;
    renderer.dispose();
    if (!contextLost) renderer.forceContextLoss();
    // WebKit keeps a canvas's backing store until the element is collected.
    canvas.width = 1;
    canvas.height = 1;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    toolkit.untrackRenderer(renderer);
  }

  /* ---- build ---- */
  var items = options.items || [];
  if (items.length) baseSize = items[0].size || baseSize;
  var loads = items.map(buildEntry);
  var environment = toolkit.loadEnvironment(renderer, options.hdri, function () { return disposed; }).then(function (target) {
    if (!target) return;
    if (disposed) {
      target.dispose();
      return;
    }
    environmentTarget = target;
    scene.environment = target.texture;
  });

  var ready = Promise.all([Promise.all(loads), environment]).then(function () {
    if (disposed) throw new Error("disposed");
    entries.forEach(function (entry) { setSize(entry, baseSize); });
    resize();
    // Compile shaders before the handover's first frame.
    renderer.compile(scene, camera);
  });

  function applyPoses(poses) {
    entries.forEach(function (entry) {
      var pose = poses[entry.id];
      if (pose && entry.visible) placeFromPose(entry, pose);
    });
    kick();
  }

  return {
    ready: ready,

    // Takes over from the pictures: models placed by pose (missing ids are
    // filtered out), drawn in the same frame the page hides the pictures.
    handOver: function (poses) {
      entries.forEach(function (entry) {
        setSize(entry, baseSize);
        var pose = poses[entry.id];
        entry.visible = !!pose;
        entry.group.visible = !!pose;
        if (pose) placeFromPose(entry, pose);
      });
      draw();
      dirty = false;
      running = true;
      if (!raf) raf = requestAnimationFrame(frame);
    },

    setPoses: applyPoses,

    // The hero's wipe: the screen y (px) above which nothing is drawn, or null
    // for no cut. Only rings on the hand are visible while it runs.
    setWipe: function (topPx) {
      var constant = topPx === null || topPx === undefined ? NO_CUT : -topPx / PX;
      if (constant === wipePlane.constant) return;
      wipePlane.constant = constant;
      kick();
    },

    // Whether this product is drawn as its model (else as a sprite of its picture, or not at all).
    drawsModel: function (id) {
      var entry = byId[String(id)];
      return !!(entry && entry.model);
    },

    // The size poses are measured against (layout change).
    setBaseSize: function (px) {
      baseSize = px;
      entries.forEach(function (entry) {
        setSize(entry, px);
        if (entry.pose) placeFromPose(entry, entry.pose);
      });
      kick();
    },

    // Filter: unlisted models leave; relisted ones return at the next poses.
    setVisible: function (ids) {
      var keep = {};
      ids.forEach(function (id) { keep[String(id)] = true; });
      entries.forEach(function (entry) {
        var show = !!keep[entry.id];
        entry.visible = show;
        entry.group.visible = show;
      });
      kick();
    },

    // The model that self-turns and that a drag on el turns (null: none); the
    // previous one eases home.
    setFocus: function (id, el) {
      focusId = id === null || id === undefined ? null : String(id);
      focusEl = el || focusEl;
      entries.forEach(function (entry) {
        var focused = entry.id === focusId;
        if (focused && !entry.spin && entry.model && focusEl) entry.spin = toolkit.spinFor(entry.product, focusEl, kick);
        if (!entry.spin) return;
        entry.spin.setEnabled(focused);
        entry.spin.setIdle(focused);
      });
      // The new focus idles, the old one eases home.
      kick();
    },

    // The element a drag starts on moved or changed size.
    focusMoved: function () {
      var entry = focusId !== null ? byId[focusId] : null;
      if (entry && entry.spin) entry.spin.handleResize();
    },

    setPaused: function (on) {
      paused = !!on;
      if (!paused) kick();
    },

    resize: resize,

    dispose: dispose
  };
}
