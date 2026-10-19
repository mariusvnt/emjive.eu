#!/usr/bin/env node
// Splits combined Blender exports into the per-model .glb files the site loads.
// Each root node is one object, matched by slug to a design's "name" (products
// with designs) or a product's "name", and written to the "model" or
// "wireframe" path products.json already names; "<name>-wireframes" nodes are
// wireframes and keep POSITION only. Later files replace same-named nodes.
//
// Orientation guard: exports can lose a node's root rotation, which is part of
// the pose the saved renders use. When a replaced file's bounds only match
// under its old root rotation, that rotation is kept (and applied to the
// wireframe too).
//
// A combined .stl is cut into its closed objects (scripts/stl.js) and each is
// matched to an entry by volume, minimum box and triangle count (a print model
// is the model subdivided 4x or 16x), refusing ambiguous assignments; written
// to the entry's "stl" path.
//
// Written files then go through scripts/optimize-models.js; run
// `npm run measure-models` afterwards.
//
//   npm run split-models -- <file.glb> [<file.glb> ...] [<file.stl>]
//   npm run split-models -- <file.glb> --dry-run        report only
//   npm run split-models -- <file.glb> --no-optimize    leave the raw split

"use strict";

const { readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join, resolve, dirname } = require("node:path");
const { spawnSync } = require("node:child_process");
const { slugify } = require("./slugs");
const stlFile = require("./stl");

const REPO_ROOT = resolve(__dirname, "..");
const SERIES_JSON_PATH = join(REPO_ROOT, "data", "series.json");
const WIRE_SUFFIX = /-wireframes?$/i;
// How far (mm) two bounding boxes may differ and still be the same pose.
const BOUNDS_TOLERANCE_MM = 0.1;
// Minimum lead over the next best assignment (in matchCost units) for a
// print-model match to be accepted.
const MATCH_MARGIN = 0.15;
// Cost per unit log-distance of a triangle count from 2^n times the model's.
const COUNT_WEIGHT = 5;

// Every model the catalog expects, keyed by node slug:
// { label, model, wireframe, stl, geometry } (repo-relative paths, "" if unset).
function catalogEntries() {
  const index = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const entries = new Map();
  function add(slug, entry) {
    if (entries.has(slug)) {
      throw new Error("Two catalog entries share the node name \"" + slug + "\": " + entries.get(slug).label + " and " + entry.label);
    }
    entries.set(slug, entry);
  }
  for (const series of index.series || []) {
    const data = JSON.parse(readFileSync(join(REPO_ROOT, series.products), "utf8"));
    for (const product of data.products || []) {
      const assets = product.assets || {};
      const designs = product.designs;
      if (designs && Array.isArray(designs.list)) {
        for (const design of designs.list) {
          const isDefault = design.key === designs.default;
          add(slugify(design.name), {
            label: series.slug + "/" + product.name + " [" + design.key + "]",
            model: isDefault ? assets.model || "" : design.model || "",
            wireframe: isDefault ? assets.wireframe || "" : design.wireframe || "",
            stl: isDefault ? assets.stl || "" : design.stl || "",
            geometry: isDefault ? product.geometry : design.geometry
          });
        }
      } else {
        add(slugify(product.name), {
          label: series.slug + "/" + product.name,
          model: assets.model || "",
          wireframe: assets.wireframe || "",
          stl: assets.stl || "",
          geometry: product.geometry
        });
      }
    }
  }
  return entries;
}

// ---- print models ----

// Minimum-cost assignment of n rows to n columns (the Hungarian method with
// potentials, O(n^3)); cost[i][j] -> the column chosen for each row.
function assign(cost) {
  const n = cost.length;
  const INF = 1e18;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const columnOf = new Array(n);
  for (let j = 1; j <= n; j++) columnOf[p[j] - 1] = j - 1;
  return columnOf;
}

function totalCost(cost, columnOf) {
  return columnOf.reduce((sum, j, i) => sum + cost[i][j], 0);
}

// Dissimilarity of a print object and an entry: summed log-ratios of volume,
// the three minimum-box sides (sorted, so pose doesn't matter) and triangle
// count to the nearest 2^n times the model's. 0 for the same piece.
function matchCost(object, entry) {
  const g = entry.geometry;
  let cost = Math.abs(Math.log(object.volume / g["volume-cm3"]));
  for (let k = 0; k < 3; k++) cost += Math.abs(Math.log(object.dims[k] / g["dimensions-mm"][k]));
  if (entry.triangles > 0) {
    const ratio = object.triangles / entry.triangles;
    const power = Math.pow(2, Math.round(Math.log2(ratio)));
    cost += COUNT_WEIGHT * Math.abs(Math.log(ratio / power));
  }
  return cost;
}

async function modelTriangles(io, rel) {
  const path = rel && join(REPO_ROOT, rel);
  if (!path || !existsSync(path)) return 0;
  const document = await io.read(path);
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute("POSITION");
      tris += (indices ? indices.getCount() : position ? position.getCount() : 0) / 3;
    }
  }
  return Math.round(tris);
}

// Cuts the combined .stl into objects, matches each to an entry and writes it
// to its "stl" path. false on failure.
async function splitPrintModels(file, entries, io, dryRun) {
  const { measureTriangles } = require("./measure-models");
  const stl = stlFile.readStl(file);
  const objects = stlFile.segmentStl(stl);
  const name = file.split(/[\\/]/).pop();
  if (!objects) {
    console.error("  " + name + ": its triangles never make closed surfaces, so it can't be cut into objects — export the objects one by one");
    return false;
  }
  const catalog = [...entries.values()];
  const unnamed = catalog.filter((e) => !e.stl).map((e) => e.label);
  if (unnamed.length) {
    console.error("  " + name + ": " + unnamed.join(", ") + " has no \"stl\" path in products.json — add one first");
    return false;
  }
  const missingGeometry = catalog.filter((e) => !e.geometry).map((e) => e.label);
  if (missingGeometry.length) {
    console.error("  " + name + ": " + missingGeometry.join(", ") + " has no geometry yet — run `npm run measure-models` first");
    return false;
  }
  if (objects.length !== catalog.length) {
    console.error("  " + name + ": " + objects.length + " closed objects, but the catalog has " + catalog.length + " models");
    return false;
  }

  console.log("  " + name + ": " + objects.length + " objects, " + stl.count + " triangles; measuring them...");
  for (const object of objects) {
    object.triangles = object.to - object.from;
    const measured = await measureTriangles(stlFile.trianglesOf(stl, object.from, object.to));
    object.volume = measured.volume.mm3 / 1000;
    object.dims = measured.box.dimensions;
  }
  for (const entry of catalog) entry.triangles = await modelTriangles(io, entry.model);

  const cost = objects.map((object) => catalog.map((entry) => matchCost(object, entry)));
  const chosen = assign(cost);
  const best = totalCost(cost, chosen);
  // Each pair's lead over the best assignment without it.
  const margins = chosen.map((j, i) => {
    const without = cost.map((row) => row.slice());
    without[i][j] = 1e9;
    return totalCost(without, assign(without)) - best;
  });

  const rows = objects.map((object, i) => {
    const entry = catalog[chosen[i]];
    const g = entry.geometry;
    return {
      "stl object": i + 1 + " (" + object.triangles + " triangles)",
      entry: entry.label,
      "print cm3": Number(object.volume.toFixed(3)),
      "model cm3": g["volume-cm3"],
      "print box mm": object.dims.map((d) => d.toFixed(1)).join(" x "),
      "model box mm": g["dimensions-mm"].join(" x "),
      "x model triangles": entry.triangles ? Number((object.triangles / entry.triangles).toFixed(2)) : "-",
      margin: Number(margins[i].toFixed(2))
    };
  });
  console.table(rows);
  const doubtful = rows.filter((r) => r.margin < MATCH_MARGIN);
  if (doubtful.length) {
    console.error("  " + name + ": not sure enough which is which (" + doubtful.map((r) => r.entry).join(", ") +
      " could change places) — export the objects one by one and name the files after the entries");
    return false;
  }

  if (dryRun) return true;
  objects.forEach((object, i) => {
    const entry = catalog[chosen[i]];
    const target = join(REPO_ROOT, entry.stl);
    mkdirSync(dirname(target), { recursive: true });
    stlFile.writeStl(target, stlFile.sliceStl(stl, object.from, object.to, "emjive print model " + entry.label));
    console.log("  wrote " + entry.stl);
  });
  return true;
}

function boundsClose(a, b) {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.min[i] - b.min[i]) > BOUNDS_TOLERANCE_MM) return false;
    if (Math.abs(a.max[i] - b.max[i]) > BOUNDS_TOLERANCE_MM) return false;
  }
  return true;
}

// Quaternions as [x, y, z, w], glTF's order.
function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function quatInverse(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function fmtQuat(q) {
  return "[" + q.map((v) => Number(v.toFixed(4))).join(", ") + "]";
}

function triangleCount(node) {
  let tris = 0;
  node.traverse((n) => {
    const mesh = n.getMesh();
    if (!mesh) return;
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute("POSITION");
      tris += (indices ? indices.getCount() : position ? position.getCount() : 0) / 3;
    }
  });
  return Math.round(tris);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const optimize = !args.includes("--no-optimize");
  const files = args.filter((a) => !a.startsWith("--")).map((p) => resolve(p));
  const inputs = files.filter((f) => !/\.stl$/i.test(f));
  const printFiles = files.filter((f) => /\.stl$/i.test(f));
  if (!files.length) {
    console.error("Usage: npm run split-models -- <file.glb> [<file.glb> ...] [<file.stl>] [--dry-run] [--no-optimize]");
    process.exitCode = 1;
    return;
  }
  for (const file of files) {
    if (!existsSync(file)) throw new Error("No such file: " + file);
  }

  const { NodeIO, Document, Logger } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { copyToDocument, prune, getBounds } = await import("@gltf-transform/functions");
  const draco3d = (await import("draco3dgltf")).default;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });

  const entries = catalogEntries();

  // Every root node of every input; later files win.
  const nodes = { model: new Map(), wireframe: new Map() };
  for (const file of inputs) {
    const document = await io.read(file);
    for (const scene of document.getRoot().listScenes()) {
      for (const node of scene.listChildren()) {
        const name = node.getName();
        const kind = WIRE_SUFFIX.test(name) ? "wireframe" : "model";
        const slug = slugify(name.replace(WIRE_SUFFIX, ""));
        if (nodes[kind].has(slug)) {
          console.log("  " + name + ": taken from " + file.split(/[\\/]/).pop() + " (replaces the one in " + nodes[kind].get(slug).file.split(/[\\/]/).pop() + ")");
        }
        nodes[kind].set(slug, { document, node, name, file });
      }
    }
  }

  // One node and its dependencies in a document and scene of their own.
  function isolate(src) {
    const target = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
    for (const ext of src.document.getRoot().listExtensionsUsed()) {
      target.createExtension(ext.constructor);
    }
    const map = copyToDocument(target, src.document, [src.node]);
    const node = map.get(src.node);
    const scene = target.createScene(src.document.getRoot().getDefaultScene()?.getName() || "Scene");
    scene.addChild(node);
    target.getRoot().setDefaultScene(scene);
    return { target, node, scene };
  }

  const rows = [];
  const unmatched = [];
  const written = [];
  // slug -> { from, to }: a model's exported and restored root rotation, reused for its wireframe.
  const corrections = new Map();
  let failed = false;

  for (const kind of ["model", "wireframe"]) {
    for (const [slug, src] of nodes[kind]) {
      const entry = entries.get(slug);
      if (!entry) {
        unmatched.push(src.name);
        continue;
      }
      const targetRel = entry[kind];
      if (!targetRel) {
        console.error("  " + src.name + ": " + entry.label + " has no \"" + kind + "\" path in products.json — add one first");
        failed = true;
        continue;
      }
      const targetAbs = join(REPO_ROOT, targetRel);
      const { target, node, scene } = isolate(src);
      let note = "";

      if (kind === "model" && existsSync(targetAbs)) {
        const old = await io.read(targetAbs);
        const oldScene = old.getRoot().getDefaultScene() || old.getRoot().listScenes()[0];
        const oldRoot = oldScene && oldScene.listChildren()[0];
        if (oldRoot) {
          const oldBounds = getBounds(oldScene);
          if (!boundsClose(oldBounds, getBounds(scene))) {
            const exported = node.getRotation().slice();
            node.setRotation(oldRoot.getRotation());
            if (boundsClose(oldBounds, getBounds(scene))) {
              corrections.set(slug, { from: exported, to: oldRoot.getRotation().slice() });
              note = "kept the old file's rotation " + fmtQuat(oldRoot.getRotation()) + " (the export had " + fmtQuat(exported) + ")";
            } else {
              node.setRotation(exported);
              note = "shape changed";
            }
          }
        }
      }

      if (kind === "wireframe") {
        for (const mesh of target.getRoot().listMeshes()) {
          for (const prim of mesh.listPrimitives()) {
            for (const semantic of prim.listSemantics()) {
              if (semantic !== "POSITION") prim.setAttribute(semantic, null);
            }
            prim.setMaterial(null);
          }
        }
        const fix = corrections.get(slug);
        if (fix) {
          node.setRotation(quatMultiply(fix.to, quatMultiply(quatInverse(fix.from), node.getRotation())));
          note = "rotated with its model";
        }
      }

      await target.transform(prune());
      if (!dryRun) {
        mkdirSync(dirname(targetAbs), { recursive: true });
        await io.write(targetAbs, target);
        written.push(targetRel);
      }
      rows.push({ node: src.name, to: targetRel, triangles: triangleCount(node), note });
    }
  }

  if (rows.length) console.table(rows);
  if (unmatched.length) {
    console.warn("No catalog entry for: " + unmatched.join(", ") +
      " — add the product (or design) to products.json, then run this again.");
  }
  const missing = [];
  if (inputs.length) {
    for (const [slug, entry] of entries) {
      if (!nodes.model.has(slug)) missing.push(entry.label + " (model)");
      if (entry.wireframe && !nodes.wireframe.has(slug)) missing.push(entry.label + " (wireframe)");
    }
  }
  if (missing.length) console.log("Not in these files (left as they are): " + missing.join(", "));

  for (const file of printFiles) {
    if (!(await splitPrintModels(file, entries, io, dryRun))) failed = true;
  }

  if (dryRun) {
    console.log("Dry run: nothing written.");
  } else if (written.length && optimize) {
    console.log("\nOptimizing the " + written.length + " written files...");
    const run = spawnSync(process.execPath, [join(__dirname, "optimize-models.js"), ...written], {
      cwd: REPO_ROOT,
      stdio: "inherit"
    });
    if (run.status !== 0) failed = true;
  }
  if (!dryRun) console.log("\nNext: npm run measure-models (the files' hashes have changed).");
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
