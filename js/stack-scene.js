/* ==========================================================================
   em·ji·ve — the homepage gallery's 3D stack

   Every product's model in ONE canvas over the whole screen. js/gallery-stack.js
   owns everything about the stack that isn't drawing — the layout, the wave,
   the rings, the taps — and drives this through the handle returned by
   createStackScene(). One WebGL context and one environment map for all of
   it, where the old grid had one of each per card.

   An ES module and a lazy chunk of its own (window.EmjiveLoadStack(), in
   js/viewer-entry.js): three-viewer.js's toolkit gives it everything a model
   needs to look the way it does in a viewer — the page's one Draco decoder
   and HDR cache, the metals, the renderer's settings, and the default
   camera's orientation.

   Coordinates: one world unit is PX CSS pixels; x to the right from the
   screen's left edge, y up from its top edge (so a point on screen is at
   (x / PX, -y / PX)), z towards the visitor; an orthographic camera looking
   down -Z sees exactly the screen. A model turned by the inverse of its
   default orbit camera's orientation then shows the face its fallback-img
   does, at the size the image shows it when its box is `size` px: the
   handover from the pictures moves nothing.

   Phases, as gallery-stack.js publishes them:
     the entrance (setEntrance(p < 1))  each model is placed where the shared
                                        wave puts it (options.poseAt)
     floating (p = 1)                   each model stays in its place and
                                        rocks, very slowly, about the axis
                                        pointing at the visitor
   ========================================================================== */

import * as T from "three";
import { toolkit } from "./three-viewer.js";

// CSS pixels per world unit.
var PX = 100;
var MAX_PIXEL_RATIO = 1.5;

// Floating: each model rocks about the axis pointing at the visitor, this far
// either side of its resting turn (degrees), once every ROCK_PERIOD seconds,
// about (each has its own period and its own place in the cycle). It eases in
// over ROCK_RAMP seconds from landing, so the handover from the pictures
// moves nothing.
var ROCK_DEG = 5;
var ROCK_PERIOD = 26;
var ROCK_RAMP = 4;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function smoothstep(a, b, x) {
  var t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function hash(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
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
  // The entrance: true while it's under way, false once landed (floating).
  var kinematic = true;
  var floatStart = 0;
  var targets = options.targets ? options.targets() : {};
  var entries = [];
  var byId = {};
  var environmentTarget = null;
  var heldCpuBytes = 0;

  // What the default view and a top shot are, as rotations of the model.
  var qTop = toolkit.orbitOrientation({ "3d-viewer-camera-default": { rotation: 0, tilt: 0, zoom: 100 } }).invert();
  var zAxis = new T.Vector3(0, 0, 1);
  var tmpQ = new T.Quaternion();

  function rotZ(deg, out) {
    // Clockwise on screen is about -Z in a y-up world.
    return (out || new T.Quaternion()).setFromAxisAngle(zAxis, -deg * Math.PI / 180);
  }

  function restFor(entry, target) {
    return rotZ(target ? target.rot : 0).multiply(entry.viewQ);
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
  // first, and taps are tested against the boxes, not the meshes. Mesh
  // by mesh, and only once that mesh has really been drawn (onAfterRender):
  // a model hidden by the filter, or focused, has never been uploaded, and
  // drawing it later from arrays that are gone would fail.
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
  // fallback-img shows) and its minimum box (data/: what a tap is tested
  // against), both in its own frame.
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
    entry.box = box;
    entry.material = toolkit.metalMaterial(entry.product["default-metal"]);
    root.traverse(function (node) {
      if (!node.isMesh) return;
      disposeMaterial(node.material);
      node.material = entry.material;
      // A dozen models on one screen: culling saves nothing, and a model
      // still below the screen during the entrance has to be uploaded too.
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
    var entry = {
      id: String(item.id),
      product: item.product,
      group: group,
      holder: holder,
      viewQ: toolkit.orbitOrientation(item.product).invert(),
      restQ: new T.Quaternion(),
      size: 0,
      hit: null,
      visible: true,
      // Where it is in its rocking, and how fast it goes round.
      phase: hash(String(item.id)) * Math.PI * 2,
      period: ROCK_PERIOD * (0.75 + 0.5 * hash(String(item.id) + "|rock")),
      opacity: 1
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

  /* ---- sizes and hit boxes ----------------------------------------------------
     An item `size` px across in the stack: its model scaled the way its
     fallback-img shows it in a box that size (the default camera's fov and
     zoom fit its bounding sphere), its sphere's centre on the group's origin,
     and a box on its minimum box, which is what a tap is tested against. */
  function framingScale(entry, sizePx) {
    var framing = toolkit.defaultFraming(entry.product);
    var halfFov = framing.fovDeg * Math.PI / 360;
    return (sizePx * Math.cos(halfFov)) / (2 * entry.radius * framing.zoom) / PX;
  }

  var basis = new T.Matrix4();
  function minBox(entry, k) {
    var geometry = entry.product.geometry || {};
    var box = geometry["min-box"];
    var dims = geometry["dimensions-mm"];
    var half;
    var offset;
    var orient = new T.Quaternion();
    if (box && dims && box.axes && box.axes.length === 3) {
      var a = box.axes.map(function (v) { return new T.Vector3(v[0], v[1], v[2]); });
      // A box is the same either way round: a left-handed set of axes just
      // has its third one turned over, so it reads as a rotation.
      if (a[0].clone().cross(a[1]).dot(a[2]) < 0) a[2].negate();
      basis.makeBasis(a[0], a[1], a[2]);
      orient.setFromRotationMatrix(basis);
      half = new T.Vector3(dims[0], dims[1], dims[2]).multiplyScalar(k / 2);
      offset = new T.Vector3(box.center[0], box.center[1], box.center[2]).sub(entry.center).multiplyScalar(k);
    } else {
      var size = entry.box.getSize(new T.Vector3());
      half = size.multiplyScalar(k / 2);
      offset = entry.box.getCenter(new T.Vector3()).sub(entry.center).multiplyScalar(k);
    }
    // Never thinner than a sliver, or a flat one is missed by a tap.
    half.x = Math.max(half.x, 0.02);
    half.y = Math.max(half.y, 0.02);
    half.z = Math.max(half.z, 0.02);
    return { half: half, offset: offset, orient: orient };
  }

  function setSize(entry, sizePx) {
    if (Math.abs(sizePx - entry.size) < 0.5 && entry.hit) return;
    entry.size = sizePx;
    if (entry.model) {
      var k = framingScale(entry, sizePx);
      entry.holder.scale.setScalar(k);
      entry.holder.position.copy(entry.center).multiplyScalar(-k);
      entry.hit = minBox(entry, k);
    } else {
      var s = sizePx / PX;
      if (entry.sprite) entry.sprite.scale.set(s, s, 1);
      entry.hit = { half: new T.Vector3(s * 0.35, s * 0.35, s * 0.2), offset: new T.Vector3(), orient: new T.Quaternion() };
    }
  }

  /* ---- the camera and the canvas ------------------------------------------------- */
  function resize() {
    var w = Math.max(1, window.innerWidth);
    var h = Math.max(1, window.innerHeight);
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

  function placeFromPose(entry, pose) {
    entry.group.position.set(pose.x / PX, -pose.y / PX, 0);
    if (pose.fromRing) {
      rotZ(pose.ringRot, tmpQ).multiply(qTop);
      entry.group.quaternion.slerpQuaternions(tmpQ, entry.restQ, clamp01(pose.u));
    } else {
      rotZ(pose.spin, entry.group.quaternion).multiply(entry.restQ);
    }
    entry.group.scale.setScalar(entry.size ? pose.size / entry.size : 1);
    twistSprite(entry);
    setOpacity(entry, 1 - (pose.ring || 0));
  }

  // The entrance has landed: the models float from where they are.
  function land() {
    kinematic = false;
    floatStart = performance.now();
    dirty = true;
  }

  /* ---- the loop ---------------------------------------------------------------------
     Draws only when something moved: the entrance (on each new progress), a
     floating stack (always). */
  var raf = 0;

  // Floating, a model's idle: it rocks about the axis pointing at the
  // visitor, around its resting turn, and doesn't drift from its place.
  function rock(now) {
    var seconds = (now - floatStart) / 1000;
    var ramp = smoothstep(0, ROCK_RAMP, seconds);
    var moved = false;
    entries.forEach(function (entry) {
      if (!entry.visible) return;
      var angle = ROCK_DEG * ramp * Math.sin(seconds * 2 * Math.PI / entry.period + entry.phase);
      rotZ(angle, entry.group.quaternion).multiply(entry.restQ);
      twistSprite(entry);
      moved = true;
    });
    return moved;
  }

  // A picture standing in for a model always faces the camera; it turns with
  // its group about the view axis only.
  function twistSprite(entry) {
    if (!entry.sprite) return;
    var q = entry.group.quaternion;
    entry.material.rotation = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  function draw() {
    if (contextLost) return;
    renderer.render(scene, camera);
    releaseDrawn();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (paused || disposed) return;
    var changed = dirty;
    dirty = false;
    if (!kinematic && rock(now)) changed = true;
    if (changed) draw();
  }

  /* ---- taps ------------------------------------------------------------------------
     A ray straight into the screen, through each model's box in the box's own
     frame; the nearest hit wins. */
  var rayOrigin = new T.Vector3();
  var rayDir = new T.Vector3();
  var boxCenter = new T.Vector3();
  var inv = new T.Quaternion();

  function hitBox(entry) {
    var g = entry.group;
    var hit = entry.hit;
    var scale = g.scale.x;
    tmpQ.copy(g.quaternion);
    var boxQ = tmpQ.clone().multiply(hit.orient);
    boxCenter.copy(hit.offset).multiplyScalar(scale).applyQuaternion(tmpQ).add(g.position);
    inv.copy(boxQ).invert();
    var o = rayOrigin.clone().sub(boxCenter).applyQuaternion(inv);
    var d = rayDir.clone().applyQuaternion(inv);
    var h = hit.half;
    var tMin = -Infinity;
    var tMax = Infinity;
    var axes = ["x", "y", "z"];
    for (var i = 0; i < 3; i++) {
      var axis = axes[i];
      var extent = h[axis] * scale;
      if (Math.abs(d[axis]) < 1e-9) {
        if (Math.abs(o[axis]) > extent) return null;
        continue;
      }
      var t1 = (-extent - o[axis]) / d[axis];
      var t2 = (extent - o[axis]) / d[axis];
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) return null;
    }
    return tMax >= 0 ? Math.max(0, tMin) : null;
  }

  function pick(x, y) {
    rayOrigin.set(x / PX, -y / PX, 200);
    rayDir.set(0, 0, -1);
    var best = null;
    var bestT = Infinity;
    entries.forEach(function (entry) {
      if (!entry.visible || !entry.hit) return;
      var t = hitBox(entry);
      if (t !== null && t < bestT) {
        bestT = t;
        best = entry.id;
      }
    });
    return best;
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
  // restored), and a stack that isn't floating draws nothing on its own: draw
  // again.
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
    entries.forEach(function (entry) { disposeObject(entry.group); });
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
  var loads = (options.items || []).map(buildEntry);
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
    targets = options.targets ? options.targets() : targets;
    entries.forEach(function (entry) {
      var target = targets[entry.id];
      setSize(entry, target ? target.size : 100);
      entry.restQ.copy(restFor(entry, target));
    });
    resize();
    // Shaders compiled now, before the handover's first frame needs them.
    renderer.compile(scene, camera);
  });

  return {
    ready: ready,

    // The pictures hand over: every model where its picture is (poses, by
    // id — those missing are hidden by the filter), drawn at once, in the same
    // frame the page hides the pictures.
    handOver: function (poses, state) {
      targets = options.targets ? options.targets() : targets;
      entries.forEach(function (entry) {
        var target = targets[entry.id];
        if (target) setSize(entry, target.size);
        entry.restQ.copy(restFor(entry, target));
        var pose = poses[entry.id];
        entry.visible = !!pose;
        entry.group.visible = !!pose;
        if (pose) placeFromPose(entry, pose);
      });
      if (state.entrance >= 1) land();
      else kinematic = true;
      draw();
      raf = requestAnimationFrame(frame);
    },

    setEntrance: function (p) {
      if (p >= 1) {
        if (kinematic) {
          entries.forEach(function (entry) {
            if (!entry.visible) return;
            var pose = options.poseAt(entry.id, 1);
            if (pose) placeFromPose(entry, pose);
          });
          land();
        }
        return;
      }
      // Back into the entrance, from the models' resting turns.
      kinematic = true;
      entries.forEach(function (entry) {
        if (!entry.visible) return;
        var pose = options.poseAt(entry.id, p);
        if (pose) placeFromPose(entry, pose);
      });
      dirty = true;
    },

    // The layout changed (the filter, the screen): every model's new place,
    // size and resting turn. Once landed they are there at once.
    setTargets: function (map) {
      targets = map || targets;
      entries.forEach(function (entry) {
        var target = targets[entry.id];
        if (!target) return;
        setSize(entry, target.size);
        entry.restQ.copy(restFor(entry, target));
        if (kinematic || !entry.visible) return;
        entry.group.position.set(target.x / PX, -target.y / PX, 0);
        entry.group.scale.setScalar(1);
      });
      dirty = true;
    },

    // The id of the model at (x, y) on the screen, or null.
    pick: function (x, y) {
      return kinematic ? null : pick(x, y);
    },

    // The filter: those not listed leave the stack; those listed again come
    // back, in their places.
    setVisible: function (ids) {
      var keep = {};
      ids.forEach(function (id) { keep[String(id)] = true; });
      entries.forEach(function (entry) {
        var show = !!keep[entry.id];
        if (show === entry.visible) return;
        entry.visible = show;
        entry.group.visible = show;
        if (!show || kinematic) return;
        var target = targets[entry.id];
        if (target) entry.group.position.set(target.x / PX, -target.y / PX, 0);
        entry.group.scale.setScalar(1);
      });
      dirty = true;
    },

    setPaused: function (on) {
      paused = !!on;
      if (!paused) dirty = true;
    },

    resize: resize,

    dispose: dispose
  };
}
