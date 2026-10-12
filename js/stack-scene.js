/* ==========================================================================
   em·ji·ve — the homepage gallery's 3D stack

   Every product's model in ONE canvas over the whole screen, each one a rigid
   body in a physics world whose walls are the stack's domain (the screen,
   between the controls under the header and the selection bar) plus a thin
   slab in depth, so the pile stays a pile and never wanders off behind
   itself. js/gallery-stack.js owns everything about the stack that isn't
   drawing or physics — the layout, the wave, the rings, the focus row, the
   taps, the device's motion — and drives this through the handle returned
   by createStackScene(). One WebGL context and one environment map for all
   of it, where the old grid had one of each per card.

   An ES module and a lazy chunk of its own (window.EmjiveLoadStack(), in
   js/viewer-entry.js): cannon-es for the physics, and three-viewer.js's
   toolkit for everything a model needs to look the way it does in a viewer —
   the page's one Draco decoder and HDR cache, the metals, the renderer's
   settings, and the default camera's orientation.

   Coordinates: one world unit is PX CSS pixels; x to the right from the
   screen's left edge, y up from its top edge (so a point on screen is at
   (x / PX, -y / PX)), z towards the visitor; an orthographic camera looking
   down -Z sees exactly the screen. A model turned by the inverse of its
   default orbit camera's orientation then shows the face its fallback-img
   does, at the size the image shows it when its box is `size` px: the
   handover from the pictures moves nothing.

   Phases, as gallery-stack.js publishes them:
     the entrance (setEntrance(p < 1))  no physics: each model is placed
                                        where the shared wave puts it
                                        (options.poseAt)
     floating (p = 1, no gravity yet)   bodies drift about their places
                                        (springs and a slow noise), turning
     gravity (enableGravity)            they fall and pile up; setGravity()
                                        tilts it with the phone
   ========================================================================== */

import * as T from "three";
import * as CANNON from "cannon-es";
import { toolkit } from "./three-viewer.js";

// CSS pixels per world unit: keeps the bodies about one unit across, the
// scale cannon's own tolerances are made for.
var PX = 100;
var MAX_PIXEL_RATIO = 1.5;
// One g, in world units per second squared (3000 px/s²): a fall across a
// phone's screen takes about three quarters of a second.
var GRAVITY = 30;
var STEP = 1 / 60;
var MAX_SUBSTEPS = 3;

// Floating: a pull back towards its place (per second squared, per unit
// away), a slow drifting force, the damping that keeps both gentle, and how
// fast each one turns.
var FLOAT_SPRING = 2.5;
var FLOAT_NOISE = 0.35;
var FLOAT_DAMPING = 0.6;
var FLOAT_SPIN = 0.5;
var FLOAT_SPIN_DAMPING = 0.01;
// Falling.
var FALL_DAMPING = 0.05;
// The slab's depth, over the largest body's diagonal: room for any of them
// to turn every way between its two faces.
var DEPTH_ROOM = 1.05;

// The flight to the focus row (gallery-stack.js's FLY_MS), and how long a
// model let go of takes to shrink back to its size in the stack.
var FLY_MS = 550;
var SHRINK_MS = 350;
// A change of gravity smaller than this (in g) doesn't wake a sleeping pile.
var GRAVITY_WAKE = 0.02;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
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

  var world = new CANNON.World();
  world.allowSleep = true;
  world.solver.iterations = 10;
  world.defaultContactMaterial.friction = 0.3;
  world.defaultContactMaterial.restitution = 0.25;

  var disposed = false;
  var contextLost = false;
  var paused = false;
  var dirty = true;
  // The entrance: true while it's under way (no physics), false once landed.
  var kinematic = true;
  var gravityOn = false;
  var gravity = new CANNON.Vec3(0, -GRAVITY, 0);
  var targets = options.targets ? options.targets() : {};
  var entries = [];
  var byId = {};
  var walls = [];
  var slotBody = null;
  var environmentTarget = null;
  var heldCpuBytes = 0;

  // What the default view and a top shot are, as rotations of the model.
  var qTop = toolkit.orbitOrientation({ "3d-viewer-camera-default": { rotation: 0, tilt: 0, zoom: 100 } }).invert();
  var zAxis = new T.Vector3(0, 0, 1);
  var tmpQ = new T.Quaternion();
  var tmpQ2 = new T.Quaternion();

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
  // first, and taps are tested against the colliders, not the meshes. Mesh
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
  // fallback-img shows) and its minimum box (data/: the collider), both in
  // its own frame.
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
  // standing in for it in the pile.
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
      body: null,
      inWorld: false,
      visible: true,
      out: false,
      anim: null,
      shrink: null,
      phase: hash(String(item.id)) * Math.PI * 2,
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

  /* ---- sizes and colliders ----------------------------------------------------
     An item `size` px across in the stack: its model scaled the way its
     fallback-img shows it in a box that size (the default camera's fov and
     zoom fit its bounding sphere), its sphere's centre on the group's origin,
     and a box collider on its minimum box. */
  function framingScale(entry, sizePx) {
    var framing = toolkit.defaultFraming(entry.product);
    var halfFov = framing.fovDeg * Math.PI / 360;
    return (sizePx * Math.cos(halfFov)) / (2 * entry.radius * framing.zoom) / PX;
  }

  var basis = new T.Matrix4();
  function minBoxShape(entry, k) {
    var geometry = entry.product.geometry || {};
    var minBox = geometry["min-box"];
    var dims = geometry["dimensions-mm"];
    var half;
    var offset;
    var orient = new T.Quaternion();
    if (minBox && dims && minBox.axes && minBox.axes.length === 3) {
      var a = minBox.axes.map(function (v) { return new T.Vector3(v[0], v[1], v[2]); });
      // A box is the same either way round: a left-handed set of axes just
      // has its third one turned over, so it reads as a rotation.
      if (a[0].clone().cross(a[1]).dot(a[2]) < 0) a[2].negate();
      basis.makeBasis(a[0], a[1], a[2]);
      orient.setFromRotationMatrix(basis);
      half = new T.Vector3(dims[0], dims[1], dims[2]).multiplyScalar(k / 2);
      offset = new T.Vector3(minBox.center[0], minBox.center[1], minBox.center[2]).sub(entry.center).multiplyScalar(k);
    } else {
      var size = entry.box.getSize(new T.Vector3());
      half = size.multiplyScalar(k / 2);
      offset = entry.box.getCenter(new T.Vector3()).sub(entry.center).multiplyScalar(k);
    }
    // Never thinner than a sliver, or a flat one slips through the others.
    half.x = Math.max(half.x, 0.02);
    half.y = Math.max(half.y, 0.02);
    half.z = Math.max(half.z, 0.02);
    return { half: half, offset: offset, orient: orient };
  }

  function setSize(entry, sizePx) {
    if (Math.abs(sizePx - entry.size) < 0.5 && entry.body) return;
    entry.size = sizePx;
    var shape;
    if (entry.model) {
      var k = framingScale(entry, sizePx);
      entry.holder.scale.setScalar(k);
      entry.holder.position.copy(entry.center).multiplyScalar(-k);
      shape = minBoxShape(entry, k);
    } else {
      var s = sizePx / PX;
      if (entry.sprite) entry.sprite.scale.set(s, s, 1);
      shape = { half: new T.Vector3(s * 0.35, s * 0.35, s * 0.2), offset: new T.Vector3(), orient: new T.Quaternion() };
    }
    var body = entry.body || new CANNON.Body({ mass: 1 });
    // The screen's plane: a body moves in x and y only, and never in z (it
    // still turns every way). linearFactor stops forces and gravity moving it
    // in z, but the contact solver ignores it (a pile of tilted boxes pushed
    // z out to dozens of units in a test), so syncFromBodies() also pins z
    // and its speed to 0 after every step, before anything is drawn.
    body.linearFactor.set(1, 1, 0);
    while (body.shapes.length) body.removeShape(body.shapes[0]);
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(shape.half.x, shape.half.y, shape.half.z)),
      new CANNON.Vec3(shape.offset.x, shape.offset.y, shape.offset.z),
      new CANNON.Quaternion(shape.orient.x, shape.orient.y, shape.orient.z, shape.orient.w)
    );
    body.updateMassProperties();
    body.sleepSpeedLimit = 0.15;
    body.sleepTimeLimit = 0.6;
    entry.body = body;
    entry.halfDiagonal = shape.half.length() + shape.offset.length();
  }

  /* ---- the domain's walls ------------------------------------------------------- */
  function plane(normalEuler, x, y, z) {
    var body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromEuler(normalEuler[0], normalEuler[1], normalEuler[2]);
    body.position.set(x, y, z);
    return body;
  }

  var depth = 1;
  function buildWalls() {
    walls.forEach(function (wall) { world.removeBody(wall); });
    var d = options.domain();
    depth = 1;
    entries.forEach(function (entry) {
      if (entry.halfDiagonal) depth = Math.max(depth, entry.halfDiagonal * 2 * DEPTH_ROOM);
    });
    // A plane's normal is its +Z: each one turned to face into the domain.
    walls = [
      plane([-Math.PI / 2, 0, 0], 0, -d.bottom / PX, 0),
      plane([Math.PI / 2, 0, 0], 0, -d.top / PX, 0),
      plane([0, Math.PI / 2, 0], d.left / PX, 0, 0),
      plane([0, -Math.PI / 2, 0], d.right / PX, 0, 0),
      plane([0, 0, 0], 0, 0, -depth / 2),
      plane([0, Math.PI, 0], 0, 0, depth / 2)
    ];
    walls.forEach(function (wall) { world.addBody(wall); });
  }

  // The focus row's figure: the pile keeps off it while it's there.
  function setSlotBody(slot) {
    if (slotBody) {
      world.removeBody(slotBody);
      slotBody = null;
    }
    if (!slot) return;
    var half = slot.size * 0.4 / PX;
    slotBody = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    slotBody.addShape(new CANNON.Box(new CANNON.Vec3(half, half, depth)));
    slotBody.position.set(slot.x / PX, -slot.y / PX, 0);
    world.addBody(slotBody);
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
    buildWalls();
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

  function slotPose(entry, slot) {
    return {
      position: new T.Vector3(slot.x / PX, -slot.y / PX, 0),
      quaternion: entry.viewQ.clone(),
      scale: entry.size ? slot.size / entry.size : 1
    };
  }

  function setPose(entry, pose) {
    entry.group.position.copy(pose.position);
    entry.group.quaternion.copy(pose.quaternion);
    entry.group.scale.setScalar(pose.scale);
  }

  function addToWorld(entry) {
    if (entry.inWorld || !entry.body) return;
    var b = entry.body;
    b.position.set(entry.group.position.x, entry.group.position.y, 0);
    b.quaternion.set(entry.group.quaternion.x, entry.group.quaternion.y, entry.group.quaternion.z, entry.group.quaternion.w);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    tuneBody(entry);
    world.addBody(b);
    b.wakeUp();
    entry.inWorld = true;
  }

  function removeFromWorld(entry) {
    if (!entry.inWorld) return;
    world.removeBody(entry.body);
    entry.inWorld = false;
  }

  // Floating or falling: how a body moves.
  function tuneBody(entry) {
    var b = entry.body;
    if (gravityOn) {
      b.linearDamping = FALL_DAMPING;
      b.angularDamping = FALL_DAMPING;
      b.allowSleep = true;
    } else {
      b.linearDamping = FLOAT_DAMPING;
      b.angularDamping = FLOAT_SPIN_DAMPING;
      b.allowSleep = false;
      if (b.angularVelocity.lengthSquared() < 1e-6) {
        var a = entry.phase;
        b.angularVelocity.set(Math.cos(a), Math.sin(a * 1.7), Math.sin(a)).scale(FLOAT_SPIN, b.angularVelocity);
      }
    }
  }

  function land() {
    kinematic = false;
    entries.forEach(function (entry) {
      if (entry.visible && !entry.out && !entry.anim) addToWorld(entry);
    });
    dirty = true;
  }

  function leaveWorld() {
    kinematic = true;
    entries.forEach(function (entry) {
      removeFromWorld(entry);
      // Where it is now is where the wave takes it back from (its turn
      // included: the picture's 2D turn is long gone).
      entry.restQ.copy(entry.group.quaternion);
    });
  }

  /* ---- the loop ---------------------------------------------------------------------
     Draws only when something moved: the entrance (on each new progress), a
     flight, a floating stack (always), a pile until it sleeps. */
  var lastTime = 0;
  var raf = 0;
  var force = new CANNON.Vec3();

  function floatForces(now) {
    var t = now / 1000;
    entries.forEach(function (entry) {
      if (!entry.inWorld) return;
      var b = entry.body;
      var home = targets[entry.id];
      var hx = home ? home.x / PX : b.position.x;
      var hy = home ? -home.y / PX : b.position.y;
      force.set(
        -FLOAT_SPRING * (b.position.x - hx) + FLOAT_NOISE * Math.sin(t * 0.7 + entry.phase),
        -FLOAT_SPRING * (b.position.y - hy) + FLOAT_NOISE * Math.cos(t * 0.53 + entry.phase * 1.3),
        0
      );
      b.applyForce(force);
    });
  }

  // A picture standing in for a model always faces the camera; it turns with
  // its body about the view axis only.
  function twistSprite(entry) {
    if (!entry.sprite) return;
    var q = entry.group.quaternion;
    entry.material.rotation = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  function syncFromBodies() {
    var awake = false;
    entries.forEach(function (entry) {
      if (!entry.inWorld) return;
      var b = entry.body;
      b.position.z = 0;
      b.velocity.z = 0;
      entry.group.position.set(b.position.x, b.position.y, 0);
      entry.group.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      twistSprite(entry);
      if (b.sleepState !== CANNON.Body.SLEEPING) awake = true;
    });
    return awake;
  }

  function runAnimations(now) {
    var moved = false;
    entries.forEach(function (entry) {
      var a = entry.anim;
      if (a) {
        var t = a.ms > 0 ? clamp01((now - a.start) / a.ms) : 1;
        var e = easeInOutCubic(t);
        entry.group.position.lerpVectors(a.from.position, a.to.position, e);
        entry.group.quaternion.slerpQuaternions(a.from.quaternion, a.to.quaternion, e);
        entry.group.scale.setScalar(a.from.scale + (a.to.scale - a.from.scale) * e);
        moved = true;
        if (t >= 1) {
          entry.anim = null;
          a.resolve();
        }
      }
      var s = entry.shrink;
      if (s) {
        var u = clamp01((now - s.start) / SHRINK_MS);
        entry.group.scale.setScalar(s.from + (1 - s.from) * easeInOutCubic(u));
        moved = true;
        if (u >= 1) entry.shrink = null;
      }
    });
    return moved;
  }

  function draw() {
    if (contextLost) return;
    renderer.render(scene, camera);
    releaseDrawn();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (paused || disposed) {
      lastTime = now;
      return;
    }
    var dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : STEP;
    lastTime = now;
    var changed = dirty;
    dirty = false;
    if (!kinematic) {
      if (!gravityOn) floatForces(now);
      world.step(STEP, dt, MAX_SUBSTEPS);
      if (syncFromBodies()) changed = true;
    }
    if (runAnimations(now)) changed = true;
    if (changed) draw();
  }

  /* ---- taps ------------------------------------------------------------------------
     Against the colliders: a ray straight into the screen, through each
     body's box in the box's own frame; the nearest hit wins. */
  var rayOrigin = new T.Vector3();
  var rayDir = new T.Vector3();
  var boxCenter = new T.Vector3();
  var inv = new T.Quaternion();

  function hitBox(entry) {
    var b = entry.body;
    var shape = b.shapes[0];
    var off = b.shapeOffsets[0];
    var ori = b.shapeOrientations[0];
    tmpQ.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    tmpQ2.set(ori.x, ori.y, ori.z, ori.w);
    var boxQ = tmpQ.clone().multiply(tmpQ2);
    boxCenter.set(off.x, off.y, off.z).applyQuaternion(tmpQ).add(new T.Vector3(b.position.x, b.position.y, b.position.z));
    inv.copy(boxQ).invert();
    var o = rayOrigin.clone().sub(boxCenter).applyQuaternion(inv);
    var d = rayDir.clone().applyQuaternion(inv);
    var h = shape.halfExtents;
    var tMin = -Infinity;
    var tMax = Infinity;
    var axes = ["x", "y", "z"];
    for (var i = 0; i < 3; i++) {
      var axis = axes[i];
      if (Math.abs(d[axis]) < 1e-9) {
        if (Math.abs(o[axis]) > h[axis]) return null;
        continue;
      }
      var t1 = (-h[axis] - o[axis]) / d[axis];
      var t2 = (h[axis] - o[axis]) / d[axis];
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
      if (!entry.inWorld || !entry.visible || entry.out) return;
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
  // restored), and an idle pile draws nothing on its own: draw again.
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
      removeFromWorld(entry);
      disposeObject(entry.group);
      if (entry.anim) entry.anim.resolve();
    });
    walls.forEach(function (wall) { world.removeBody(wall); });
    if (slotBody) world.removeBody(slotBody);
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
    // id — those missing are hidden by the filter, or the focused one),
    // drawn at once, in the same frame the page hides the pictures.
    handOver: function (poses, state) {
      targets = options.targets ? options.targets() : targets;
      gravityOn = !!state.gravity;
      if (gravityOn) world.gravity.copy(gravity);
      else world.gravity.set(0, 0, 0);
      entries.forEach(function (entry) {
        var target = targets[entry.id];
        if (target) setSize(entry, target.size);
        entry.restQ.copy(restFor(entry, target));
        var pose = poses[entry.id];
        entry.out = entry.id === state.focused;
        entry.visible = !!pose || entry.out;
        entry.group.visible = !!pose;
        if (pose) placeFromPose(entry, pose);
      });
      if (state.focused !== null && state.focused !== undefined && options.slot) setSlotBody(options.slot());
      buildWalls();
      if (state.entrance >= 1) land();
      else kinematic = true;
      draw();
      lastTime = 0;
      raf = requestAnimationFrame(frame);
    },

    setEntrance: function (p) {
      if (p >= 1) {
        if (kinematic) {
          entries.forEach(function (entry) {
            if (!entry.visible || entry.out) return;
            var pose = options.poseAt(entry.id, 1);
            if (pose) placeFromPose(entry, pose);
          });
          land();
        }
        return;
      }
      if (!kinematic) leaveWorld();
      entries.forEach(function (entry) {
        if (!entry.visible || entry.out) return;
        var pose = options.poseAt(entry.id, p);
        if (pose) placeFromPose(entry, pose);
      });
      dirty = true;
    },

    setTargets: function (map) {
      targets = map || targets;
    },

    // In px, for the image stack's targets when the entrance runs backwards.
    positions: function () {
      var out = {};
      entries.forEach(function (entry) {
        out[entry.id] = { x: entry.group.position.x * PX, y: -entry.group.position.y * PX };
      });
      return out;
    },

    enableGravity: function () {
      if (gravityOn) return;
      gravityOn = true;
      world.gravity.copy(gravity);
      entries.forEach(function (entry) {
        if (!entry.inWorld) return;
        tuneBody(entry);
        entry.body.wakeUp();
      });
    },

    // In g, in the screen's axes (x right, y up, z towards the visitor).
    setGravity: function (x, y, z) {
      var next = new CANNON.Vec3(x * GRAVITY, y * GRAVITY, z * GRAVITY);
      var change = next.vsub(gravity).length() / GRAVITY;
      gravity.copy(next);
      if (!gravityOn) return;
      world.gravity.copy(gravity);
      if (change > GRAVITY_WAKE) {
        entries.forEach(function (entry) {
          if (entry.inWorld) entry.body.wakeUp();
        });
      }
    },

    pick: function (x, y) {
      return kinematic ? null : pick(x, y);
    },

    // Out of the pile and up to the focus row's figure (slot: its middle and
    // size in px), to show the face its picture does there.
    takeOut: function (id, slot, instant) {
      var entry = byId[String(id)];
      if (!entry) return Promise.resolve();
      entry.out = true;
      entry.shrink = null;
      removeFromWorld(entry);
      entry.group.visible = true;
      setSlotBody(slot);
      var to = slotPose(entry, slot);
      if (entry.anim) entry.anim.resolve();
      if (instant) {
        entry.anim = null;
        setPose(entry, to);
        dirty = true;
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        entry.anim = {
          from: {
            position: entry.group.position.clone(),
            quaternion: entry.group.quaternion.clone(),
            scale: entry.group.scale.x
          },
          to: to,
          start: performance.now(),
          ms: FLY_MS,
          resolve: resolve
        };
      });
    },

    // Under the focus row's figure, which has faded in over it.
    hide: function (id) {
      var entry = byId[String(id)];
      if (!entry) return;
      entry.group.visible = false;
      dirty = true;
    },

    // Back where the figure is, for the figure to fade off.
    showAt: function (id, slot) {
      var entry = byId[String(id)];
      if (!entry) return;
      if (entry.anim) {
        entry.anim.resolve();
        entry.anim = null;
      }
      entry.group.visible = entry.visible;
      setPose(entry, slotPose(entry, slot));
      dirty = true;
    },

    // Into the pile again, from the focus row: it falls (or floats) from
    // there, shrinking back to its size in the stack.
    release: function (id) {
      var entry = byId[String(id)];
      if (!entry) return;
      entry.out = false;
      if (!entries.some(function (other) { return other.out; })) setSlotBody(null);
      if (!entry.visible) return;
      entry.shrink = { from: entry.group.scale.x, start: performance.now() };
      if (!kinematic) addToWorld(entry);
      dirty = true;
    },

    // The filter: those not listed leave the stack; those listed again come
    // back — dropping in from the top once the stack has landed.
    setVisible: function (ids) {
      var keep = {};
      ids.forEach(function (id) { keep[String(id)] = true; });
      var d = options.domain();
      entries.forEach(function (entry) {
        var show = !!keep[entry.id];
        if (show === entry.visible) return;
        entry.visible = show;
        if (!show) {
          removeFromWorld(entry);
          entry.group.visible = false;
          return;
        }
        if (entry.out) return;
        entry.group.visible = true;
        if (!kinematic) {
          var target = targets[entry.id];
          var x = target ? target.x : (d.left + d.right) / 2;
          var y = gravityOn ? d.top + entry.size : (target ? target.y : (d.top + d.bottom) / 2);
          entry.group.position.set(x / PX, -y / PX, 0);
          entry.group.scale.setScalar(1);
          addToWorld(entry);
        }
      });
      dirty = true;
    },

    setPaused: function (on) {
      paused = !!on;
      if (!paused) dirty = true;
    },

    resize: resize,

    // The hero plays again: gravity off, every model back to before the
    // entrance (gallery-stack.js then publishes it from 0).
    reset: function () {
      gravityOn = false;
      world.gravity.set(0, 0, 0);
      setSlotBody(null);
      targets = options.targets ? options.targets() : targets;
      entries.forEach(function (entry) {
        removeFromWorld(entry);
        if (entry.anim) {
          entry.anim.resolve();
          entry.anim = null;
        }
        entry.shrink = null;
        entry.out = false;
        entry.group.visible = entry.visible;
        entry.body.angularVelocity.set(0, 0, 0);
        entry.restQ.copy(restFor(entry, targets[entry.id]));
      });
      kinematic = true;
      dirty = true;
    },

    dispose: dispose
  };
}
