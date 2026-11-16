#!/usr/bin/env node
// Measures every product's .glb (and .stl print model) into its "geometry"
// line in products.json, touching nothing else:
//
//   "geometry": { "volume-cm3", "volume-cm3-per-size-mm", "volume-cm3-per-size-mm2", "area-cm2",
//                 "area-cm2-per-size-mm", "area-cm2-per-size-mm2", "dimensions-mm", "min-size-mm",
//                 "min-box": { center, axes }, "axis-box": { "sizes-mm", center, size },
//                 "print": { "volume-cm3", "volume-cm3-per-size-mm", "volume-cm3-per-size-mm2",
//                            "area-cm2", "area-cm2-per-size-mm", "area-cm2-per-size-mm2",
//                            "dimensions-mm", "min-size-mm", "stl-sha1" }, "model-sha1" }
//
//   volume-cm3     enclosed volume at the reference size; models are in mm.
//                  Summed per shell as |signed volume|, since some exports
//                  have inverted winding. With the linear and quadratic terms
//                  in the size from it (EmjiveHelpers.volumeAt): sized as a
//                  ring is (scripts/ring-size.js), the radial shift and the
//                  stretch along the axis are each linear in the size, so the
//                  volume is quadratic and the terms exact
//   area-cm2       surface area at the reference size, with the linear and
//                  quadratic terms in the size from it (EmjiveHelpers.areaAt),
//                  fitted through the size span's ends. Volume and area price
//                  the piece (EmjiveHelpers.productionCost), so they keep
//                  enough digits for cents
//   dimensions-mm  minimum-volume bounding box extents, longest first (pose-independent)
//   min-size-mm    the smallest size before the bore reaches the finger axis
//   min-box        that box's centre and unit axes in scene space (axes[k] runs
//                  along dimensions-mm[k]); the wheel's hit boxes (js/stack-scene.js)
//   axis-box       the scene-space axis-aligned box's centre and size at each
//                  size of "sizes-mm" (the size span's ends and the reference):
//                  the plan views' frame and dimensions (EmjiveHelpers.planFrame)
//   model-sha1, stl-sha1   checked by validate-data.js against the files, so a
//                  changed model must be re-measured
//   print          the same, on the .stl: what is made and priced
//
// The finger axis must run through the origin: the model's along its
// "finger-axis", the print model's along Y. A file where another axis runs
// farther from the geometry is refused. The table shows the print model's
// bore as the toolbox estimates it, with a warning when it is far from the
// reference size.
//
// Non-watertight meshes get an approximate volume and are flagged. Each
// non-default design gets its own "geometry" line after its "picks".
//
//   npm run measure-models                 measure and write
//   npm run measure-models -- --dry-run    report only

"use strict";

const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const blocks = require("./json-tool-blocks");
const stlFile = require("./stl");
const ringSize = require("./ring-size");
const { ROOT, STUDIES_JSON_PATH, REFERENCE_SIZE_MM, SIZE_SPAN_MM, MEASURED_SIZES_MM, readJson, gltfIO } = require("./helpers");

// Vertices closer than this (mm) are one: Draco decoding can split welded vertices.
const WELD_EPSILON = 1e-4;
// A print model's estimated bore further than this (mm) from the reference size is reported.
const BORE_WARN_MM = 2;

// ---- geometry extraction ----

// Every triangle in world space (an instanced mesh counts per instance), 9 numbers each.
function collectTriangles(document) {
  const tris = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const world = new Float64Array(position.getCount() * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, v);
        world[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        world[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        world[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      }
      for (let t = 0; t < count; t += 3) {
        const ia = indices ? indices.getScalar(t) : t;
        const ib = indices ? indices.getScalar(t + 1) : t + 1;
        const ic = indices ? indices.getScalar(t + 2) : t + 2;
        for (const idx of [ia, ib, ic]) tris.push(world[idx * 3], world[idx * 3 + 1], world[idx * 3 + 2]);
      }
    }
  }
  return Float64Array.from(tris);
}

// Welds triangle corners into shared vertex ids by rounded position.
function weldTriangles(tris) {
  const ids = new Map();
  const positions = [];
  const corners = new Int32Array(tris.length / 3);
  const q = 1 / WELD_EPSILON;
  for (let i = 0; i < corners.length; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const key = Math.round(x * q) + "," + Math.round(y * q) + "," + Math.round(z * q);
    let id = ids.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      ids.set(key, id);
      positions.push(x, y, z);
    }
    corners[i] = id;
  }
  return { corners, positions: Float64Array.from(positions) };
}

// Volume in mm3: connected shells (union-find over shared vertices), each
// contributing |signed volume|. Also counts edges that aren't shared by
// exactly two triangles — zero means watertight. `shellOf` gives each
// triangle's shell, for shellsVolume.
function measureVolume(welded) {
  const { corners, positions } = welded;
  const vertexCount = positions.length / 3;
  const triCount = corners.length / 3;
  const parent = new Int32Array(vertexCount).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const edgeUse = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = corners[t * 3], b = corners[t * 3 + 1], c = corners[t * 3 + 2];
    parent[find(a)] = find(b);
    parent[find(b)] = find(c);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * vertexCount + q : q * vertexCount + p;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  let openEdges = 0;
  for (const n of edgeUse.values()) if (n !== 2) openEdges++;

  const shellIds = new Map();
  const shellOf = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const root = find(corners[t * 3]);
    if (!shellIds.has(root)) shellIds.set(root, shellIds.size);
    shellOf[t] = shellIds.get(root);
  }
  return { mm3: shellsVolume(corners, positions, shellOf, shellIds.size), shells: shellIds.size, openEdges, shellOf };
}

// The sum of the shells' |signed volume| (mm3), the corners placed at
// `positions`. Signed volume about the origin; the origin's position cancels
// out within a closed shell.
function shellsVolume(corners, positions, shellOf, shellCount) {
  const shell = new Float64Array(shellCount);
  for (let t = 0; t < corners.length / 3; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    shell[shellOf[t]] += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let mm3 = 0;
  for (const v of shell) mm3 += Math.abs(v);
  return mm3;
}

// The surface area (mm2) of the triangles, the corners placed at `positions`.
function surfaceArea(corners, positions) {
  let mm2 = 0;
  for (let t = 0; t < corners.length / 3; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    mm2 += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return mm2;
}

// ---- sizes ----

// The axis-aligned box of flat xyz `positions`: { center, size }.
function axisAlignedBox(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }
  return { center: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2), size: [0, 1, 2].map((k) => hi[k] - lo[k]) };
}

// The welded model sized as a ring around `axis` (scripts/ring-size.js): its
// smallest size, the linear and quadratic terms in the size of its volume
// (mm3 per mm and per mm2 of size from the reference) and of its area (mm2),
// through the span's ends, its area at the reference size, and its
// axis-aligned box at each of MEASURED_SIZES_MM. null after an error message
// when another axis runs farther from the geometry.
function measureSizes(label, welded, volume, axis) {
  const { corners, positions } = welded;
  const found = ringSize.detectAxis(positions);
  if (found.axis !== axis) {
    console.error("  " + label + ": the line through the origin along " + "XYZ"[found.axis] + " runs farther from the geometry (" +
      found.clearance.toFixed(2) + " mm) than the finger axis " + "XYZ"[axis] + " (" + ringSize.axisClearance(positions, axis).toFixed(2) +
      " mm): the origin must sit on the bore, with the finger along " + "XYZ"[axis]);
    return null;
  }
  const at = (mm) => (mm === REFERENCE_SIZE_MM ? positions : ringSize.resize(positions, ringSize.shiftFor(REFERENCE_SIZE_MM, mm), axis));
  const sized = { min: at(SIZE_SPAN_MM.min), max: at(SIZE_SPAN_MM.max) };
  const lo = SIZE_SPAN_MM.min - REFERENCE_SIZE_MM, hi = SIZE_SPAN_MM.max - REFERENCE_SIZE_MM;
  // { slope, curve } of the quadratic through (lo, atLo), (0, atRef), (hi, atHi).
  const terms = (atLo, atRef, atHi) => {
    const riseLo = (atLo - atRef) / lo;
    const riseHi = (atHi - atRef) / hi;
    const curve = (riseHi - riseLo) / (hi - lo);
    return { slope: riseHi - curve * hi, curve };
  };
  const volumeAt = (points) => shellsVolume(corners, points, volume.shellOf, volume.shells);
  const volumeTerms = terms(volumeAt(sized.min), volumeAt(positions), volumeAt(sized.max));
  const area = surfaceArea(corners, positions);
  const areaTerms = terms(surfaceArea(corners, sized.min), area, surfaceArea(corners, sized.max));
  return {
    minSize: ringSize.minSize(found.clearance, REFERENCE_SIZE_MM),
    slope: volumeTerms.slope,
    curve: volumeTerms.curve,
    area,
    areaSlope: areaTerms.slope,
    areaCurve: areaTerms.curve,
    boxes: MEASURED_SIZES_MM.map((mm) => axisAlignedBox(at(mm)))
  };
}

// ---- minimum-volume bounding box ----

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 2D convex hull (monotone chain) of [x, y] pairs.
function hull2d(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Volume and extents of the box with axes (u, v, w) around `points`, plus each
// extent's midpoint along its axis (to rebuild the centre).
function boxFor(points, u, v, w) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const p of points) {
    const a = dot(p, u), b = dot(p, v), c = dot(p, w);
    if (a < u0) u0 = a; if (a > u1) u1 = a;
    if (b < v0) v0 = b; if (b > v1) v1 = b;
    if (c < w0) w0 = c; if (c > w1) w1 = c;
  }
  const ex = [u1 - u0, v1 - v0, w1 - w0];
  return { volume: ex[0] * ex[1] * ex[2], extents: ex, mids: [(u0 + u1) / 2, (v0 + v1) / 2, (w0 + w1) / 2] };
}

// Best box that has one face flush with a plane of normal `n`: the rest is a
// 2D minimum-area rectangle, whose optimum has a side along a 2D hull edge.
function bestBoxAlong(points, n) {
  const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0 = normalize(cross(n, helper));
  const v0 = cross(n, u0);
  const rim = hull2d(points.map((p) => [dot(p, u0), dot(p, v0)]));
  // In-plane extents only need the projected hull; the height uses every point.
  let h0 = Infinity, h1 = -Infinity;
  for (const p of points) {
    const h = dot(p, n);
    if (h < h0) h0 = h;
    if (h > h1) h1 = h;
  }
  const height = h1 - h0;
  let bestArea = Infinity;
  let bestDir = null;
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i], b = rim[(i + 1) % rim.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-12) continue;
    const ex = (b[0] - a[0]) / len, ey = (b[1] - a[1]) / len;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of rim) {
      const s = q[0] * ex + q[1] * ey;
      const t = -q[0] * ey + q[1] * ex;
      if (s < s0) s0 = s;
      if (s > s1) s1 = s;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    const area = (s1 - s0) * (t1 - t0);
    if (area < bestArea) { bestArea = area; bestDir = [ex, ey]; }
  }
  if (!bestDir) return null;
  const [ex, ey] = bestDir;
  const u = [u0[0] * ex + v0[0] * ey, u0[1] * ex + v0[1] * ey, u0[2] * ex + v0[2] * ey];
  return { volume: bestArea * height, axes: [u, cross(n, u), n] };
}

// Small rotations about each axis, keeping improvements, halving the step until negligible.
function polishBox(points, found) {
  let best = { ...boxFor(points, found.axes[0], found.axes[1], found.axes[2]), axes: found.axes };
  let step = 0.02;
  const rotate = (axes, k, angle) => {
    const i = (k + 1) % 3, j = (k + 2) % 3;
    const c = Math.cos(angle), s = Math.sin(angle);
    const next = axes.map((a) => a.slice());
    next[i] = axes[i].map((x, d) => c * x + s * axes[j][d]);
    next[j] = axes[j].map((x, d) => c * x - s * axes[i][d]);
    return next;
  };
  while (step > 1e-6) {
    let improved = false;
    for (let k = 0; k < 3; k++) {
      for (const sign of [1, -1]) {
        const axes = rotate(best.axes, k, sign * step);
        const box = boxFor(points, axes[0], axes[1], axes[2]);
        if (box.volume < best.volume - 1e-9) {
          best = { ...box, axes };
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

async function minimumBox(positions) {
  const THREE = await import("three");
  const { ConvexHull } = await import("three/examples/jsm/math/ConvexHull.js");
  const cloud = [];
  for (let i = 0; i < positions.length; i += 3) cloud.push(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  const hull = new ConvexHull().setFromPoints(cloud);
  // hull.vertices holds every input point; keep those its faces use.
  const onHull = new Set();
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      onHull.add(edge.head());
      edge = edge.next;
    } while (edge !== face.edge);
  }
  const hullPoints = [...onHull].map((vn) => [vn.point.x, vn.point.y, vn.point.z]);

  // One candidate per distinct hull-face normal, bucketed at ~0.3 degrees
  // (polishBox closes the gap). Candidates are scored on a thinned hull (the
  // farthest vertex in ~800 directions); the best 12 are re-scored on the full one.
  const thin = new Set();
  const directions = 800;
  for (let d = 0; d < directions; d++) {
    const y = 1 - (2 * (d + 0.5)) / directions;
    const r = Math.sqrt(1 - y * y);
    const phi = d * 2.399963229728653;
    const dir = [r * Math.cos(phi), y, r * Math.sin(phi)];
    let far = null, farDot = -Infinity;
    for (const p of hullPoints) {
      const h = dot(p, dir);
      if (h > farDot) { farDot = h; far = p; }
    }
    thin.add(far);
  }
  const thinPoints = [...thin];

  const seen = new Set();
  const scored = [];
  for (const face of hull.faces) {
    const n = [face.normal.x, face.normal.y, face.normal.z];
    const key = n.map((x) => Math.round(x * 200)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const box = bestBoxAlong(thinPoints, n);
    if (box) scored.push({ n, volume: box.volume });
  }
  scored.sort((a, b) => a.volume - b.volume);
  let best = null;
  for (const c of scored.slice(0, 12)) {
    const box = bestBoxAlong(hullPoints, c.n);
    if (box && (!best || box.volume < best.volume)) best = box;
  }
  best = polishBox(hullPoints, best);
  // Longest first, axes kept with their extents. Each axis' sign is flipped so
  // its largest component is positive, keeping re-runs stable.
  const order = [0, 1, 2].sort((a, b) => best.extents[b] - best.extents[a]);
  const axes = order.map((k) => {
    const a = best.axes[k];
    const big = a.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
    return big < 0 ? a.map((x) => -x) : a.slice();
  });
  const center = [0, 1, 2].map((d) => best.axes.reduce((s, a, k) => s + a[d] * best.mids[k], 0));
  const aligned = boxFor(hullPoints, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  return {
    dimensions: order.map((k) => best.extents[k]),
    axes,
    center,
    volume: best.volume,
    axisAligned: { center: aligned.mids, size: aligned.extents, volume: aligned.volume }
  };
}

// ---- products.json patching ----

// Shared with the JSON tool, so neither drops a field the other writes.
const geometryLine = blocks.geometryLine;

// Replaces the product block's "geometry" line, placed after "default-metal",
// in the file's line endings. null without default-metal.
function withGeometry(blockText, g, eol) {
  const cleaned = blockText.replace(/\r?\n {6}"geometry": \{[^\r\n]*\},(?=\r?\n)/, "");
  const anchor = /( {6}"default-metal": "[^"\r\n]*",)(?=\r?\n)/;
  if (!anchor.test(cleaned)) return null;
  return cleaned.replace(anchor, (m) => m + eol + geometryLine(g));
}

// Same for one entry of "designs": the line goes after its "picks".
const DESIGN_INDENT = "            ";
function withDesignGeometry(entryText, g, eol) {
  const cleaned = entryText.replace(/\r?\n {12}"geometry": \{[^\r\n]*\},(?=\r?\n)/, "");
  const anchor = /( {12}"picks": \{[^\r\n]*\},)(?=\r?\n)/;
  if (!anchor.test(cleaned)) return null;
  return cleaned.replace(anchor, (m) => m + eol + geometryLine(g, DESIGN_INDENT));
}

// Volume and minimum box of a triangle soup (mm); shared by models and print models.
async function measureTriangles(tris) {
  const welded = weldTriangles(tris);
  if (!welded.corners.length) return null;
  const volume = measureVolume(welded);
  const box = await minimumBox(welded.positions);
  return { volume, box, welded };
}

// The model's finger axis in its own frame (js/helpers.js ringAxes).
function fingerAxis(product) {
  return product["finger-axis"] === "x" ? 0 : 2;
}

const cm3 = (mm3, digits) => Number((mm3 / 1000).toFixed(digits));
const cm2 = (mm2, digits) => Number((mm2 / 100).toFixed(digits));
// Rounded up: a lower limit.
const minSizeMm = (mm) => Math.ceil(mm * 10) / 10;

// One model (and its print model): the "geometry" object and a summary row,
// or null after an error message.
async function measureFile(io, label, modelRel, stlRel, axis) {
  const modelPath = modelRel && join(ROOT, modelRel);
  if (!modelPath || !existsSync(modelPath)) {
    console.error("  " + label + ": model file missing (" + modelRel + ")");
    return null;
  }
  const document = await io.read(modelPath);
  const measured = await measureTriangles(collectTriangles(document));
  if (!measured) {
    console.error("  " + label + ": model has no triangles");
    return null;
  }
  const { volume, box } = measured;
  const sizes = measureSizes(label, measured.welded, volume, axis);
  if (!sizes) return null;
  const geometry = {
    "volume-cm3": cm3(volume.mm3, 5),
    "volume-cm3-per-size-mm": cm3(sizes.slope, 7),
    "volume-cm3-per-size-mm2": cm3(sizes.curve, 9),
    "area-cm2": cm2(sizes.area, 4),
    "area-cm2-per-size-mm": cm2(sizes.areaSlope, 6),
    "area-cm2-per-size-mm2": cm2(sizes.areaCurve, 8),
    "dimensions-mm": box.dimensions.map((d) => Number(d.toFixed(1))),
    "min-size-mm": minSizeMm(sizes.minSize),
    "min-box": {
      center: box.center.map((c) => Number(c.toFixed(3))),
      axes: box.axes.map((a) => a.map((x) => Number(x.toFixed(5))))
    },
    "axis-box": {
      "sizes-mm": MEASURED_SIZES_MM,
      center: sizes.boxes.map((b) => b.center.map((c) => Number(c.toFixed(3)))),
      size: sizes.boxes.map((b) => b.size.map((d) => Number(d.toFixed(2))))
    },
    "model-sha1": createHash("sha1").update(readFileSync(modelPath)).digest("hex")
  };
  const row = {
    product: label,
    "volume cm3": geometry["volume-cm3"],
    "box mm": geometry["dimensions-mm"].join(" x "),
    "box/aabb": (box.volume / box.axisAligned.volume).toFixed(2),
    shells: volume.shells,
    "open edges": volume.openEdges
  };

  if (stlRel) {
    const stlPath = join(ROOT, stlRel);
    if (!existsSync(stlPath)) {
      console.error("  " + label + ": print model missing (" + stlRel + ") — the print models are not in git: put the file back, or cut it from the export again with `npm run split-models`");
      return null;
    }
    const stl = stlFile.readStl(stlPath);
    const printed = await measureTriangles(stlFile.trianglesOf(stl, 0, stl.count));
    if (!printed) {
      console.error("  " + label + ": print model has no triangles");
      return null;
    }
    const printSizes = measureSizes(label + " (print model)", printed.welded, printed.volume, ringSize.STL_AXIS);
    if (!printSizes) return null;
    geometry.print = {
      "volume-cm3": cm3(printed.volume.mm3, 5),
      "volume-cm3-per-size-mm": cm3(printSizes.slope, 7),
      "volume-cm3-per-size-mm2": cm3(printSizes.curve, 9),
      "area-cm2": cm2(printSizes.area, 4),
      "area-cm2-per-size-mm": cm2(printSizes.areaSlope, 6),
      "area-cm2-per-size-mm2": cm2(printSizes.areaCurve, 8),
      "dimensions-mm": printed.box.dimensions.map((d) => Number(d.toFixed(1))),
      "min-size-mm": minSizeMm(printSizes.minSize),
      "stl-sha1": createHash("sha1").update(stl.buffer).digest("hex")
    };
    row["print cm3"] = geometry.print["volume-cm3"];
    row["print cm2"] = geometry.print["area-cm2"];
    row["print box mm"] = geometry.print["dimensions-mm"].join(" x ");
    row["print open edges"] = printed.volume.openEdges;
    row["print bore"] = Number(ringSize.estimateSize(printed.welded.positions, ringSize.STL_AXIS).toFixed(1));
  }
  return { geometry, row };
}

// ---- main ----

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const io = await gltfIO();

  const studiesIndex = readJson(STUDIES_JSON_PATH);
  const rows = [];
  let failed = false;

  for (const study of studiesIndex.studies || []) {
    const productsPath = join(ROOT, study.products);
    let text = readFileSync(productsPath, "utf8");
    const data = JSON.parse(text);

    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    for (const product of data.products || []) {
      const label = study.slug + "/" + product.name;
      const measured = await measureFile(io, label, product.assets && product.assets.model, product.assets && product.assets.stl, fingerAxis(product));
      if (!measured) {
        failed = true;
        continue;
      }

      const span = blocks.findProductBlockSpan(text, product.id);
      let patchedBlock = span && withGeometry(text.slice(span.start, span.end), measured.geometry, eol);
      if (!patchedBlock) {
        console.error("  " + label + ": could not locate its block (or default-metal) in " + study.products);
        failed = true;
        continue;
      }
      rows.push(measured.row);

      // The non-default designs, each with its own model and "geometry" line.
      const designs = product.designs;
      for (const design of (designs && designs.list) || []) {
        if (design.key === designs.default) continue;
        const designLabel = label + " [" + design.key + "]";
        const designMeasured = await measureFile(io, designLabel, design.model, design.stl, fingerAxis(product));
        if (!designMeasured) {
          failed = true;
          continue;
        }
        const list = patchedBlock.indexOf('"list": [');
        const entrySpan = list === -1 ? null : blocks.findBlockSpanByAnchor(patchedBlock.slice(list), "key", design.key);
        const entry = entrySpan && withDesignGeometry(patchedBlock.slice(list + entrySpan.start, list + entrySpan.end), designMeasured.geometry, eol);
        if (!entry) {
          console.error("  " + designLabel + ": could not locate its entry (or its picks) in " + study.products);
          failed = true;
          continue;
        }
        patchedBlock = patchedBlock.slice(0, list + entrySpan.start) + entry + patchedBlock.slice(list + entrySpan.end);
        rows.push(designMeasured.row);
      }

      text = text.slice(0, span.start) + patchedBlock + text.slice(span.end);
    }

    if (!dryRun) writeFileSync(productsPath, text, "utf8");
  }

  console.table(rows);
  const open = rows.filter((r) => r["open edges"] > 0).map((r) => r.product);
  if (open.length) {
    console.warn("Not watertight (volume is approximate): " + open.join(", "));
  }
  const openPrint = rows.filter((r) => r["print open edges"] > 0).map((r) => r.product);
  if (openPrint.length) {
    console.warn("Print model not watertight (volume is approximate): " + openPrint.join(", "));
  }
  const offBore = rows.filter((r) => Math.abs(r["print bore"] - REFERENCE_SIZE_MM) > BORE_WARN_MM).map((r) => r.product + " (" + r["print bore"] + ")");
  if (offBore.length) {
    console.warn("Print model bore estimated more than " + BORE_WARN_MM + " mm off the size it is sized from (" + REFERENCE_SIZE_MM + "): " + offBore.join(", "));
  }
  console.log(dryRun ? "Dry run: nothing written." : "Wrote geometry into products.json.");
  if (failed) process.exitCode = 1;
}

module.exports = { measureTriangles, collectTriangles };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
