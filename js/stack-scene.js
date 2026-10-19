// The wheel's 3D scene: every product's model in one full-screen canvas (one
// WebGL context, one environment map). js/gallery-stack.js owns the layout and
// interaction and drives this through createStackScene()'s handle (setPoses).
// A lazy module chunk (window.EmjiveLoadStack); three-viewer.js's toolkit
// supplies the decoder, HDR cache, metals, renderer settings, camera
// orientation and the viewers' spin (toolkit.spinFor).
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
var MAX_PIXEL_RATIO = 1.5;
// dt cap (a tab coming back).
var MAX_DT = 1 / 15;
// A clipping plane's constant that cuts nothing.
var NO_CUT = 1e9;
// The top shot's perspective, applied to a model lying on the hand
// (placeOnHand()): its close camera spreads nearer points outward.
var SHOT_VERTEX = [
  "if (uShotAmount > 0.0) {",
  "  float shotK = uShotDist / max(uShotDist - (mvPosition.z - uShotCenter.z), 1e-4);",
  "  mvPosition.xy = uShotCenter.xy + (mvPosition.xy - uShotCenter.xy) * mix(1.0, shotK, uShotAmount);",
  "  gl_Position = projectionMatrix * mvPosition;",
  "}"
].join("\n");

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
  // For the finger a ring on the hand is cut by (placeOnHand()).
  renderer.localClippingEnabled = true;
  toolkit.trackRenderer(renderer);
  var canvas = renderer.domElement;
  canvas.className = "stack-canvas";
  canvas.setAttribute("aria-hidden", "true");
  options.host.insertBefore(canvas, options.host.firstChild);

  var scene = new T.Scene();
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

  // A top shot's view, as a rotation of the model.
  var qTop = toolkit.orbitOrientation({ "3d-viewer-camera-default": { rotation: 0, tilt: 0, zoom: 100 } }).invert();
  var zAxis = new T.Vector3(0, 0, 1);
  var tmpQ = new T.Quaternion();
  var yAxis = new T.Vector3(0, 1, 0);
  var tmpPlane = new T.Plane();

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
    // Where the top shot's finger occluder cuts it (half its box height,
    // scripts/auto-render.js) and the plane that reproduces it.
    entry.cutMin = box.min.y;
    entry.cutHeight = box.max.y - box.min.y;
    entry.clip = new T.Plane(yAxis.clone(), NO_CUT);
    entry.material.clippingPlanes = [entry.clip];
    // The top shot camera's distance from the model's middle (frameCamera:
    // default zoom, straight down), in model units, and its uniforms.
    var framing = toolkit.defaultFraming(entry.product);
    entry.shotDist = entry.radius * framing.zoom / Math.sin(framing.fovDeg * Math.PI / 360);
    entry.shot = {
      uShotCenter: { value: new T.Vector3() },
      uShotDist: { value: 1 },
      uShotAmount: { value: 0 }
    };
    entry.material.onBeforeCompile = function (shader) {
      shader.uniforms.uShotCenter = entry.shot.uShotCenter;
      shader.uniforms.uShotDist = entry.shot.uShotDist;
      shader.uniforms.uShotAmount = entry.shot.uShotAmount;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform vec3 uShotCenter;\nuniform float uShotDist;\nuniform float uShotAmount;")
        .replace("#include <project_vertex>", "#include <project_vertex>\n" + SHOT_VERTEX);
    };
    entry.material.customProgramCacheKey = function () { return "emjive-stack-shot"; };
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
    dirty = true;
  }

  /* ---- placing a model ---- */
  function setOpacity(entry, opacity) {
    if (!entry.material || Math.abs(opacity - entry.opacity) < 1e-3) return;
    var wasTransparent = entry.material.transparent;
    entry.opacity = opacity;
    entry.material.opacity = opacity;
    if (!entry.sprite) {
      entry.material.transparent = opacity < 1;
      if (wasTransparent !== entry.material.transparent) entry.material.needsUpdate = true;
    }
  }

  // A pose (js/gallery-stack.js): centre (x, y) and size in screen px, rot
  // (degrees clockwise); fromRing/ringRot/u for a ring's flight off the hand
  // (top view swinging to rest as u goes 0 -> 1); ring: the top shot's
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
    setOpacity(entry, alpha * (1 - (pose.ring || 0)));
  }

  // On the hand, a ring is drawn as its top shot shows it so the crossfade
  // lands exactly: cut by the same finger (below half its height), sliding out
  // as it swings off, and in the shot's close perspective. Both fade out over
  // u 0 to 0.5, as the top shot does.
  function placeOnHand(entry, pose) {
    if (!entry.clip) return;
    var share = pose.fromRing && pose.u < 1 ? 1 - H.smoothstep(0, 0.5, pose.u) : 0;
    entry.shot.uShotAmount.value = share;
    if (share <= 0) {
      entry.clip.normal.copy(yAxis);
      entry.clip.constant = NO_CUT;
      return;
    }
    tmpPlane.normal.copy(yAxis);
    tmpPlane.constant = -(entry.cutMin + entry.cutHeight * 0.5 * share);
    entry.group.updateMatrixWorld(true);
    // The box was measured in the holder's frame.
    entry.clip.copy(tmpPlane).applyMatrix4(entry.holder.matrixWorld);
    // The model's middle in view space, and the shot distance at its drawn size.
    camera.updateMatrixWorld();
    entry.shot.uShotCenter.value.setFromMatrixPosition(entry.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    entry.shot.uShotDist.value = entry.shotDist * entry.holder.scale.x * entry.group.scale.x;
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

  /* ---- the loop: draws only when something moved ---- */
  var raf = 0;
  var lastFrame = null;

  function draw() {
    if (contextLost) return;
    renderer.render(scene, camera);
    releaseDrawn();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = lastFrame === null ? 1 / 60 : Math.min((now - lastFrame) / 1000, MAX_DT);
    lastFrame = now;
    if (paused || disposed) return;
    var changed = dirty;
    dirty = false;
    if (stepSpins(Math.max(dt, 1e-3))) changed = true;
    if (changed) draw();
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
  function repaint() { dirty = true; }
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
    dirty = true;
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
      raf = requestAnimationFrame(frame);
    },

    setPoses: applyPoses,

    // The size poses are measured against (layout change).
    setBaseSize: function (px) {
      baseSize = px;
      entries.forEach(function (entry) {
        setSize(entry, px);
        if (entry.pose) placeFromPose(entry, entry.pose);
      });
      dirty = true;
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
      dirty = true;
    },

    // The model that self-turns and that a drag on el turns (null: none); the
    // previous one eases home.
    setFocus: function (id, el) {
      focusId = id === null || id === undefined ? null : String(id);
      focusEl = el || focusEl;
      entries.forEach(function (entry) {
        var focused = entry.id === focusId;
        if (focused && !entry.spin && entry.model && focusEl) entry.spin = toolkit.spinFor(entry.product, focusEl);
        if (!entry.spin) return;
        entry.spin.setEnabled(focused);
        entry.spin.setIdle(focused);
      });
    },

    // The element a drag starts on moved or changed size.
    focusMoved: function () {
      var entry = focusId !== null ? byId[focusId] : null;
      if (entry && entry.spin) entry.spin.handleResize();
    },

    setPaused: function (on) {
      paused = !!on;
      if (!paused) dirty = true;
    },

    resize: resize,

    dispose: dispose
  };
}
