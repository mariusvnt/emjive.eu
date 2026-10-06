#!/usr/bin/env node
/* ==========================================================================
   measure-models — measures every product's .glb and writes the result into
   that product's "geometry" key in its series' products.json:

     "geometry": { "volume-cm3": 1.683, "dimensions-mm": [28.1, 25.3, 20.2],
                   "min-box": { "center": [x, y, z], "axes": [[…], […], […]] }, "model-sha1": "…" }

   What the product page does with it (js/product.js's renderSpecs): weight,
   raw-material cost and manufacturing cost are all derived from the volume
   and the per-metal constants in data/series.json's "metal-costs", so only
   the metal-independent geometry is stored here. Its specs stage also draws
   dimension brackets on the box itself (js/three-viewer.js, options.blueprint),
   which is what "min-box" is for.

   - volume-cm3: the enclosed volume of the mesh. Models are authored in
     millimetres (1 unit = 1 mm — the GLBs carry no scale, and a ring is
     ~25 units across), so cm3 = mm3 / 1000. Computed per connected shell as
     |sum of signed tetrahedra|: several exports have inverted winding (a
     negative signed volume), which says nothing about the real size.
   - dimensions-mm: the extents of the MINIMUM-VOLUME bounding box, sorted
     longest first — pose-independent, so a model's baked-in rotation
     doesn't change them. The min box has no natural axis order, hence the
     sort. Found by trying a box flush with every face of the convex hull
     (with its best in-plane rotation, a 2D rotating-calipers search) and
     then polishing the winner numerically; the rare "three mutually
     orthogonal edges" optimum is covered by that polish.
   - min-box: where that box is — its centre (mm) and its three unit axes,
     axes[k] being the direction dimensions-mm[k] runs along. Both in the
     glTF scene's own space (node transforms applied), which is the space
     the viewer's model sits in, untransformed.
   - model-sha1: hash of the .glb's bytes. scripts/validate-data.js compares
     it with the file on disk, so a model that changed (or was re-optimized)
     without being re-measured fails `npm run verify` instead of silently
     shipping stale numbers.

   Meshes that aren't watertight (open or non-manifold edges) still get a
   volume — it's just approximate — and are flagged in the summary table.

   Only the "geometry" line inside each product block is touched; the rest
   of products.json is left byte-for-byte alone.

   Usage:
     npm run measure-models                 measure every product, write products.json
     npm run measure-models -- --dry-run    report only, write nothing
   ========================================================================== */

"use strict";

const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const blocks = require("./json-tool-blocks");

const REPO_ROOT = resolve(__dirname, "..");
const SERIES_JSON_PATH = join(REPO_ROOT, "data", "series.json");

// Vertices closer than this (mm) are the same vertex — used to find shared
// edges and connected shells, since a Draco decode can split a vertex that
// the source had welded.
const WELD_EPSILON = 1e-4;

// ---- geometry extraction ----------------------------------------------------

// Every triangle of every mesh, in world space (node transforms applied —
// rotations don't change volume, but a mesh instanced by several nodes must
// count once per instance). Returns flat Float64Array of 9 numbers/triangle.
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

// ---- minimum-volume bounding box ---------------------------------------------

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

// Volume and extents of the box with axes (u, v, w) around `points`, and
// the middle of each extent along its own axis (what the box's centre is
// rebuilt from — see minimumBox).
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
  // The projection's own hull is all the in-plane extents ever need, so the
  // inner loop runs over the rim only; the height along n is per-face.
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

// Rotates axes by small angles about each of its own axes, keeping any
// improvement; shrinks the step until it stops mattering.
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
  // hull.vertices is every INPUT point; the hull's own vertices are the
  // ones its faces actually use.
  const onHull = new Set();
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      onHull.add(edge.head());
      edge = edge.next;
    } while (edge !== face.edge);
  }
  const hullPoints = [...onHull].map((vn) => [vn.point.x, vn.point.y, vn.point.z]);

  // One candidate per distinct hull-face normal. A finely tessellated curved
  // surface has thousands of near-identical normals, so they're bucketed at
  // ~0.3 degrees; polishBox closes whatever gap that leaves.
  // Scoring thousands of candidates against thousands of hull vertices is
  // slow, so every candidate is scored on a thinned copy first — the
  // farthest hull vertex in each of ~800 evenly spread directions — and
  // only the best few are re-scored on the full hull.
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
  // Longest first, and each axis kept with its own extent, so axes[k] is
  // the direction dimensions[k] was measured along — the product page
  // labels its brackets that way. An axis' sign is arbitrary; it's flipped
  // so its largest component is positive, which keeps a re-run's output
  // identical rather than flipping at random.
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

// ---- products.json patching ---------------------------------------------------

// The line itself is json-tool-blocks.js's geometryLine(), which the JSON
// tool also writes through, so neither can drop a field the other knows.
const geometryLine = blocks.geometryLine;

// Drops any existing "geometry" line from a product block, then inserts the
// new one straight after its "per-metal-specs" object, in the file's own
// line-ending style (products.json is CRLF on Windows checkouts). Returns
// null if the block has no per-metal-specs to anchor on.
function withGeometry(blockText, g, eol) {
  const cleaned = blockText.replace(/\r?\n {6}"geometry": \{[^\r\n]*\},(?=\r?\n)/, "");
  const anchor = /("per-metal-specs": \{[\s\S]*?\r?\n {6}\},)(?=\r?\n)/;
  if (!anchor.test(cleaned)) return null;
  return cleaned.replace(anchor, (m) => m + eol + geometryLine(g));
}

// ---- main -----------------------------------------------------------------------

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

    for (const product of data.products || []) {
      const label = series.slug + "/" + product.name;
      const modelRel = product.assets && product.assets.model;
      const modelPath = modelRel && join(REPO_ROOT, modelRel);
      if (!modelPath || !existsSync(modelPath)) {
        console.error("  " + label + ": model file missing (" + modelRel + ")");
        failed = true;
        continue;
      }

      const document = await io.read(modelPath);
      const welded = weldTriangles(collectTriangles(document));
      if (!welded.corners.length) {
        console.error("  " + label + ": model has no triangles");
        failed = true;
        continue;
      }
      const volume = measureVolume(welded);
      const box = await minimumBox(welded.positions);

      const geometry = {
        "volume-cm3": Number((volume.mm3 / 1000).toFixed(3)),
        "dimensions-mm": box.dimensions.map((d) => Number(d.toFixed(1))),
        "min-box": {
          center: box.center.map((c) => Number(c.toFixed(3))),
          axes: box.axes.map((a) => a.map((x) => Number(x.toFixed(5))))
        },
        "model-sha1": createHash("sha1").update(readFileSync(modelPath)).digest("hex")
      };

      const span = blocks.findProductBlockSpan(text, product.id);
      const patchedBlock = span && withGeometry(text.slice(span.start, span.end), geometry, text.includes("\r\n") ? "\r\n" : "\n");
      if (!patchedBlock) {
        console.error("  " + label + ": could not locate its block (or per-metal-specs) in " + series.products);
        failed = true;
        continue;
      }
      text = text.slice(0, span.start) + patchedBlock + text.slice(span.end);

      rows.push({
        product: label,
        "volume cm3": geometry["volume-cm3"],
        "box mm": geometry["dimensions-mm"].join(" x "),
        "box/aabb": (box.volume / box.axisAlignedVolume).toFixed(2),
        shells: volume.shells,
        "open edges": volume.openEdges
      });
    }

    if (!dryRun) writeFileSync(productsPath, text, "utf8");
  }

  console.table(rows);
  const open = rows.filter((r) => r["open edges"] > 0).map((r) => r.product);
  if (open.length) {
    console.warn("Not watertight (volume is approximate): " + open.join(", "));
  }
  console.log(dryRun ? "Dry run: nothing written." : "Wrote geometry into products.json.");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
