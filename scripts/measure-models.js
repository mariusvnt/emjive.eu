#!/usr/bin/env node
// Measures every product's .glb (and .stl print model) into its "geometry"
// line in products.json, touching nothing else:
//
//   "geometry": { "volume-cm3", "dimensions-mm", "min-box": { center, axes },
//                 "print": { "volume-cm3", "dimensions-mm", "stl-sha1" }, "model-sha1" }
//
//   volume-cm3     enclosed volume; models are in mm. Summed per shell as
//                  |signed volume|, since some exports have inverted winding.
//   dimensions-mm  minimum-volume bounding box extents, longest first (pose-independent)
//   min-box        that box's centre and unit axes in scene space (axes[k] runs
//                  along dimensions-mm[k]); the wheel's hit boxes (js/stack-scene.js)
//   model-sha1, stl-sha1   checked by validate-data.js against the files, so a
//                  changed model must be re-measured
//   print          the same, on the .stl: what is made and priced
//
// Non-watertight meshes get an approximate volume and are flagged. Each
// non-default design gets its own "geometry" line after its "picks".
//
//   npm run measure-models                 measure and write
//   npm run measure-models -- --dry-run    report only

"use strict";

const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const blocks = require("./json-tool-blocks");
const stlFile = require("./stl");

const REPO_ROOT = resolve(__dirname, "..");
const SERIES_JSON_PATH = join(REPO_ROOT, "data", "series.json");

// Vertices closer than this (mm) are one: Draco decoding can split welded vertices.
const WELD_EPSILON = 1e-4;

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
// exactly two triangles — zero means watertight.
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

  // Signed volume about the origin; the origin's position cancels out
  // within a closed shell.
  const shell = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const root = find(corners[t * 3]);
    shell.set(root, (shell.get(root) || 0) + v);
  }
  let mm3 = 0;
  for (const v of shell.values()) mm3 += Math.abs(v);
  return { mm3, shells: shell.size, openEdges };
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
  return {
    dimensions: order.map((k) => best.extents[k]),
    axes,
    center,
    volume: best.volume,
    axisAlignedVolume: boxFor(hullPoints, [1, 0, 0], [0, 1, 0], [0, 0, 1]).volume
  };
}

// ---- products.json patching ----

// Shared with the JSON tool, so neither drops a field the other writes.
const geometryLine = blocks.geometryLine;

// Replaces the product block's "geometry" line, placed after "per-metal-specs",
// in the file's line endings. null without per-metal-specs.
function withGeometry(blockText, g, eol) {
  const cleaned = blockText.replace(/\r?\n {6}"geometry": \{[^\r\n]*\},(?=\r?\n)/, "");
  const anchor = /("per-metal-specs": \{[\s\S]*?\r?\n {6}\},)(?=\r?\n)/;
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
  return { volume, box };
}

// One model (and its print model): the "geometry" object and a summary row,
// or null after an error message.
async function measureFile(io, label, modelRel, stlRel) {
  const modelPath = modelRel && join(REPO_ROOT, modelRel);
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
  const geometry = {
    "volume-cm3": Number((volume.mm3 / 1000).toFixed(3)),
    "dimensions-mm": box.dimensions.map((d) => Number(d.toFixed(1))),
    "min-box": {
      center: box.center.map((c) => Number(c.toFixed(3))),
      axes: box.axes.map((a) => a.map((x) => Number(x.toFixed(5))))
    },
    "model-sha1": createHash("sha1").update(readFileSync(modelPath)).digest("hex")
  };
  const row = {
    product: label,
    "volume cm3": geometry["volume-cm3"],
    "box mm": geometry["dimensions-mm"].join(" x "),
    "box/aabb": (box.volume / box.axisAlignedVolume).toFixed(2),
    shells: volume.shells,
    "open edges": volume.openEdges
  };

  if (stlRel) {
    const stlPath = join(REPO_ROOT, stlRel);
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
    geometry.print = {
      "volume-cm3": Number((printed.volume.mm3 / 1000).toFixed(3)),
      "dimensions-mm": printed.box.dimensions.map((d) => Number(d.toFixed(1))),
      "stl-sha1": createHash("sha1").update(stl.buffer).digest("hex")
    };
    row["print cm3"] = geometry.print["volume-cm3"];
    row["print box mm"] = geometry.print["dimensions-mm"].join(" x ");
    row["print open edges"] = printed.volume.openEdges;
  }
  return { geometry, row };
}

// ---- main ----

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const draco3d = (await import("draco3dgltf")).default;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });

  const seriesIndex = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const rows = [];
  let failed = false;

  for (const series of seriesIndex.series || []) {
    const productsPath = join(REPO_ROOT, series.products);
    let text = readFileSync(productsPath, "utf8");
    const data = JSON.parse(text);

    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    for (const product of data.products || []) {
      const label = series.slug + "/" + product.name;
      const measured = await measureFile(io, label, product.assets && product.assets.model, product.assets && product.assets.stl);
      if (!measured) {
        failed = true;
        continue;
      }

      const span = blocks.findProductBlockSpan(text, product.id);
      let patchedBlock = span && withGeometry(text.slice(span.start, span.end), measured.geometry, eol);
      if (!patchedBlock) {
        console.error("  " + label + ": could not locate its block (or per-metal-specs) in " + series.products);
        failed = true;
        continue;
      }
      rows.push(measured.row);

      // The non-default designs, each with its own model and "geometry" line.
      const designs = product.designs;
      for (const design of (designs && designs.list) || []) {
        if (design.key === designs.default) continue;
        const designLabel = label + " [" + design.key + "]";
        const designMeasured = await measureFile(io, designLabel, design.model, design.stl);
        if (!designMeasured) {
          failed = true;
          continue;
        }
        const list = patchedBlock.indexOf('"list": [');
        const entrySpan = list === -1 ? null : blocks.findBlockSpanByAnchor(patchedBlock.slice(list), "key", design.key);
        const entry = entrySpan && withDesignGeometry(patchedBlock.slice(list + entrySpan.start, list + entrySpan.end), designMeasured.geometry, eol);
        if (!entry) {
          console.error("  " + designLabel + ": could not locate its entry (or its picks) in " + series.products);
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
