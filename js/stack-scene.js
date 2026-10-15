/* ==========================================================================
   em·ji·ve — the homepage gallery's 3D stack

   Every product's model in ONE canvas over the whole screen. js/gallery-stack.js
   owns everything about the stack that isn't drawing — the circle, the
   camera's pull-back, the rings, the plate's turning, the taps — and drives
   this through the handle returned by createStackScene(): it hands over a
   pose for each model whenever anything moved (setPoses). One WebGL context
   and one environment map for all of it.

   An ES module and a lazy chunk of its own (window.EmjiveLoadStack(), in
   js/viewer-entry.js): three-viewer.js's toolkit gives it everything a model
   needs to look the way it does in a viewer — the page's one Draco decoder
   and HDR cache, the metals, the renderer's settings, the default camera's
   orientation, and the viewers' own spin (toolkit.spinFor) for the focused
   model.

   Coordinates: one world unit is PX CSS pixels; x to the right from the
   screen's left edge, y up from its top edge (so a point on screen is at
   (x / PX, -y / PX)), z towards the visitor; an orthographic camera looking
   down -Z sees exactly the screen. A model turned by the inverse of its
   default orbit camera's orientation then shows the face its fallback-img
   does, at the size the image shows it when its box is `size` px: the
   handover from the pictures moves nothing.

   The focused model (setFocus) turns slowly on its own, like a turntable;
   under a drag on the element the page lays over it, it turns exactly as a
   viewer's model does — coasting, then easing back to its default view once
   let go, and turning on its own again after a pause.
   ========================================================================== */

import * as T from "three";
import { toolkit } from "./three-viewer.js";

// CSS pixels per world unit.
var PX = 100;
var MAX_PIXEL_RATIO = 1.5;
// A frame's dt is never taken as more than this (a tab coming back).
var MAX_DT = 1 / 15;
// A clipping plane's constant that cuts nothing.
var NO_CUT = 1e9;
// The top shot's perspective, put back on a model lying on the hand
// (placeOnHand()): each point drawn as the shot's camera saw it, nearer
// points spread out from the model's middle, farther ones drawn in.
var SHOT_VERTEX = [
  "if (uShotAmount > 0.0) {",
  "  float shotK = uShotDist / max(uShotDist - (mvPosition.z - uShotCenter.z), 1e-4);",
  "  mvPosition.xy = uShotCenter.xy + (mvPosition.xy - uShotCenter.xy) * mix(1.0, shotK, uShotAmount);",
  "  gl_Position = projectionMatrix * mvPosition;",
  "}"
].join("\n");

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function smoothstep(a, b, x) {
  var t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function createStackScene(options) {
  if (!toolkit) return null;

  var renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    // The page's WebGL contexts are a finite budget; the pictures stay.
    console.error("emjive: no WebGL context for the 3D stack", err);
    return null;
  }
  toolkit.configureRenderer(renderer, MAX_PIXEL_RATIO);
  // The finger a ring on the hand is worn on (placeCut()).
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
  // The focused model, and the element a drag on it starts on.
  var focusId = null;
  var focusEl = null;

  // What a top shot is, as a rotation of the model.
  var qTop = toolkit.orbitOrientation({ "3d-viewer-camera-default": { rotation: 0, tilt: 0, zoom: 100 } }).invert();
  var zAxis = new T.Vector3(0, 0, 1);
  var tmpQ = new T.Quaternion();
  var yAxis = new T.Vector3(0, 1, 0);
  var tmpPlane = new T.Plane();

  function rotZ(deg, out) {
    // Clockwise on screen is about -Z in a y-up world.
    return (out || new T.Quaternion()).setFromAxisAngle(zAxis, -deg * Math.PI / 180);
  }

  /* ---- loading ---------------------------------------------------------------- */

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

  // As js/three-viewer.js does once a model has drawn: the GPU has its own
  // copy, and nothing here reads the arrays again — the bounds are computed
  // first, and taps are tested by the page against the poses, not the
  // meshes. Mesh by mesh, and only once that mesh has really been drawn
  // (onAfterRender): a model hidden by the filter has never been uploaded,
  // and drawing it later from arrays that are gone would fail.
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

  // A model: its bounding sphere (what a viewer frames, so what the
  // fallback-img shows), in its own frame.
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
    // Where a top shot cuts it (scripts/auto-render.js's finger occluder:
    // half way up its bounding box, along the axis the shot looks down),
    // and the plane that cuts it so here (placeCut()).
    entry.cutMin = box.min.y;
    entry.cutHeight = box.max.y - box.min.y;
    entry.clip = new T.Plane(yAxis.clone(), NO_CUT);
    entry.material.clippingPlanes = [entry.clip];
    // How far the top shot's camera stood from the model's middle
    // (js/three-viewer.js frameCamera: the default zoom, straight down), in
    // the model's own units; and the uniforms that draw it so.
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
      disposeMaterial(node.material);
      node.material = entry.material;
      // A dozen models on one screen: culling saves nothing, and a model
      // still off the screen as the camera pulls back has to be uploaded too.
      node.frustumCulled = false;
      node.onAfterRender = markDrawn;
      if (node.geometry) countBytes(meshBytes(node.geometry));
    });
    entry.holder.add(root);
  }

  // No model, or one that wouldn't load: its picture, facing the camera,
  // standing in for it in the stack.
  function setSprite(entry, texture) {
    if (disposed) {
      texture.dispose();
      return;
    }
    entry.material = new T.SpriteMaterial({ map: texture, transparent: true, toneMapped: false });
    entry.sprite = new T.Sprite(entry.material);
    entry.holder.add(entry.sprite);
  }

  function pictureOf(product) {
    var assets = product.assets || {};
    var metal = product["default-metal"];
    return (assets["fallback-img"] && assets["fallback-img"][metal]) || (assets.icons && assets.icons[metal]) || "";
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
      // Its resting turn: its default view, or wherever a drag has it.
      restQ: viewQ.clone(),
      size: 0,
      visible: true,
      opacity: 1,
      pose: null,
      // The viewers' spin, built the first time it is focused.
      spin: null
    };
    var model = item.product.assets && item.product.assets.model;
    var picture = pictureOf(item.product);
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

  /* ---- sizes ---------------------------------------------------------------------
     An item `size` px across: its model scaled the way its fallback-img shows
     it in a box that size (the default camera's fov and zoom fit its bounding
     sphere), its sphere's centre on the group's origin. A pose's own size is
     the group's scale on top of that. */
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

  /* ---- the camera and the canvas ------------------------------------------------- */
  // The canvas as big as the layer it fills (css/style.css .gallery-stage:
  // the screen without a phone's browser bars, so their coming and going
  // leaves it as it is).
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

  /* ---- placing a model ----------------------------------------------------------- */
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

  // A pose (js/gallery-stack.js): its middle (x, y) and size in px of the
  // screen, its turn on the screen (rot, degrees clockwise), how far through
  // a ring's flight off the hand it is (fromRing, ringRot: the turn it lay at
  // on the hand, u: 0 to 1 — the model swings from its top view to its rest
  // as it flies), what's left of its top shot (ring) and how much of it shows
  // at all (alpha).
  function placeFromPose(entry, pose) {
    entry.pose = pose;
    entry.group.position.set(pose.x / PX, -pose.y / PX, 0);
    if (pose.fromRing && pose.u < 1) {
      rotZ(pose.ringRot, tmpQ).multiply(qTop);
      entry.group.quaternion.slerpQuaternions(tmpQ, entry.restQ, clamp01(pose.u));
    } else {
      rotZ(pose.rot || 0, entry.group.quaternion).multiply(entry.restQ);
    }
    entry.group.scale.setScalar(entry.size ? pose.size / entry.size : 1);
    placeOnHand(entry, pose);
    twistSprite(entry);
    var alpha = pose.alpha === undefined ? 1 : pose.alpha;
    setOpacity(entry, alpha * (1 - (pose.ring || 0)));
  }

  // A ring on the hand is drawn as its top shot shows it, so it lands
  // exactly on the picture it crossfades with (scripts/auto-render.js):
  //   - cut as the shot is: the shots were rendered with an invisible
  //     finger through the ring, hiding everything below half its height
  //     (addFingerOccluder) — the band under the finger, the inside of a
  //     cuff. The model wears the same finger, which slides out of it (the
  //     cut going down to its foot) as it swings off the hand;
  //   - in the shot's perspective: the shot's camera stood close, so the
  //     ring's top spreads wider than this scene's flat camera draws it.
  // Both are whole on the hand and gone by the time its top shot has faded
  // (the same stretch of the slide, 0 to 0.5).
  function placeOnHand(entry, pose) {
    if (!entry.clip) return;
    var share = pose.fromRing && pose.u < 1 ? 1 - smoothstep(0, 0.5, pose.u) : 0;
    entry.shot.uShotAmount.value = share;
    if (share <= 0) {
      entry.clip.normal.copy(yAxis);
      entry.clip.constant = NO_CUT;
      return;
    }
    tmpPlane.normal.copy(yAxis);
    tmpPlane.constant = -(entry.cutMin + entry.cutHeight * 0.5 * share);
    entry.group.updateMatrixWorld(true);
    // The box was measured in the holder's frame (the model's parent).
    entry.clip.copy(tmpPlane).applyMatrix4(entry.holder.matrixWorld);
    // The model's middle as the camera sees it, and the shot's distance at
    // the size the model is drawn.
    camera.updateMatrixWorld();
    entry.shot.uShotCenter.value.setFromMatrixPosition(entry.group.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    entry.shot.uShotDist.value = entry.shotDist * entry.holder.scale.x * entry.group.scale.x;
  }

  // A picture standing in for a model always faces the camera; it turns with
  // its group about the view axis only.
  function twistSprite(entry) {
    if (!entry.sprite) return;
    var q = entry.group.quaternion;
    entry.material.rotation = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  /* ---- the focused model's spin ---------------------------------------------------
     Each model with a spin of its own steps it while it is focused (turning
     on its own, or by hand) or still on its way home; its resting turn is then the inverse of the spin's
     stand-in camera (at home: its default view). */
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

  /* ---- the loop ---------------------------------------------------------------------
     Draws only when something moved: a new set of poses, a spin. */
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

  /* ---- teardown --------------------------------------------------------------------- */
  function disposeMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
      return;
    }
    Object.keys(material).forEach(function (key) {
      if (material[key] && material[key].isTexture) material[key].dispose();
    });
    material.dispose();
  }

  function disposeObject(root) {
    root.traverse(function (node) {
      if (node.geometry) node.geometry.dispose();
      if (node.material) disposeMaterial(node.material);
    });
  }

  function onContextLost() {
    contextLost = true;
    console.error("emjive: the 3D stack's WebGL context was lost");
    if (options.onLost) options.onLost();
  }
  canvas.addEventListener("webglcontextlost", onContextLost, false);

  // The browser may throw a canvas's drawing away (a tab coming back, a page
  // restored), and a still stack draws nothing on its own: draw again.
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

  /* ---- build -------------------------------------------------------------------- */
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
    // Shaders compiled now, before the handover's first frame needs them.
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

    // The pictures hand over: every model where its picture is (poses, by
    // id — those missing are hidden by the filter), drawn at once, in the same
    // frame the page hides the pictures.
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

    // Every model's pose, by id: whenever anything moved.
    setPoses: applyPoses,

    // The layout changed (the filter, the screen): the size a pose's size is
    // measured against.
    setBaseSize: function (px) {
      baseSize = px;
      entries.forEach(function (entry) {
        setSize(entry, px);
        if (entry.pose) placeFromPose(entry, entry.pose);
      });
      dirty = true;
    },

    // The filter: those not listed leave the stack; those listed again come
    // back (the next poses place them).
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

    // The model that turns on its own and that a drag on el turns (null:
    // none). The one focused before goes home on its own.
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
