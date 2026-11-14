#!/usr/bin/env node
// Shrinks the product .glb files in place:
//   1. strips textures and TEXCOORD/COLOR/TANGENT attributes: js/three-viewer.js
//      replaces every material with a "metal-shaders" one, so they are never
//      used (remove this step if the viewer ever honours a model's own maps);
//   2. gives every primitive one material and joins each mesh's primitives
//      into one: Draco quantizes each primitive on its own grid, so a seam
//      between two materials would come apart and the model stop measuring
//      as watertight;
//   3. weld(), 4. prune() + dedup(), 5. draco() (14-bit positions).
// simplify() changes the silhouette the renders are made from, so it is opt-in.
//
//   npm run optimize-models -- --dry-run      report only
//   npm run optimize-models                   every product .glb
//   npm run optimize-models -- <path.glb> ... only these files
//   npm run optimize-models -- --simplify=0.5 also cut ~50% of triangles

const { readdirSync, statSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { ROOT, repoPath, mb, gltfIO } = require("./helpers");

const SERIES_ROOT = join(ROOT, "assets", "series");

// NORMAL is kept: without it three.js shades flat faces.
const DROPPED_ATTRIBUTE_PREFIXES = ["TEXCOORD_", "COLOR_", "TANGENT", "_"];

function findProductModels() {
  const found = [];
  if (!existsSync(SERIES_ROOT)) return found;
  for (const series of readdirSync(SERIES_ROOT)) {
    const productsDir = join(SERIES_ROOT, series, "products");
    if (!existsSync(productsDir) || !statSync(productsDir).isDirectory()) continue;
    for (const product of readdirSync(productsDir)) {
      const dir = join(productsDir, product);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (/\.glb$/i.test(file)) found.push(join(dir, file));
      }
    }
  }
  return found;
}

function measure(document) {
  const root = document.getRoot();
  let vertices = 0;
  let triangles = 0;
  let primitives = 0;
  const attributes = new Set();
  // Bounds from POSITION min/max: the integrity check, as quantization and
  // welding must not move the extents.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const indices = prim.getIndices();
      primitives++;
      vertices += position ? position.getCount() : 0;
      triangles += (indices ? indices.getCount() : position ? position.getCount() : 0) / 3;
      for (const semantic of prim.listSemantics()) attributes.add(semantic);
      if (position) {
        const lo = position.getMin([0, 0, 0]);
        const hi = position.getMax([0, 0, 0]);
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], lo[i]);
          max[i] = Math.max(max[i], hi[i]);
        }
      }
    }
  }
  return {
    vertices,
    primitives,
    triangles: Math.round(triangles),
    attributes: [...attributes].sort(),
    textures: root.listTextures().length,
    draco: root.listExtensionsUsed().some((e) => e.extensionName === "KHR_draco_mesh_compression"),
    min,
    max
  };
}

// Largest bounding-box movement on any axis, as a fraction of the model's largest dimension.
function boundsDrift(before, after) {
  let extent = 0;
  for (let i = 0; i < 3; i++) extent = Math.max(extent, before.max[i] - before.min[i]);
  if (!isFinite(extent) || extent === 0) return 0;
  let drift = 0;
  for (let i = 0; i < 3; i++) {
    drift = Math.max(drift, Math.abs(after.min[i] - before.min[i]), Math.abs(after.max[i] - before.max[i]));
  }
  return drift / extent;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const simplifyArg = args.find((a) => a.startsWith("--simplify"));
  // --simplify alone means 0.5. A target ratio: meshoptimizer stops early
  // rather than wreck the silhouette.
  const simplifyRatio = simplifyArg
    ? Number(simplifyArg.split("=")[1] || 0.5)
    : null;
  const explicit = args.filter((a) => !a.startsWith("--"));

  const files = explicit.length
    ? explicit.map((p) => resolve(ROOT, p))
    : findProductModels();

  if (!files.length) {
    console.error("No .glb files found under assets/series/*/products/.");
    process.exitCode = 1;
    return;
  }

  // ESM-only packages, hence dynamic imports.
  const { dedup, draco, prune, weld, simplify, joinPrimitives } = await import("@gltf-transform/functions");
  const meshoptimizer = simplifyRatio !== null ? await import("meshoptimizer") : null;

  const io = await gltfIO({ encoder: true });

  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of files) {
    const rel = repoPath(file);
    const sizeBefore = statSync(file).size;
    totalBefore += sizeBefore;

    const document = await io.read(file);
    const before = measure(document);

    // ---- 1. textures and unused attributes ----
    for (const texture of document.getRoot().listTextures()) texture.dispose();
    for (const mesh of document.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        for (const semantic of prim.listSemantics()) {
          if (DROPPED_ATTRIBUTE_PREFIXES.some((p) => semantic.startsWith(p))) {
            prim.setAttribute(semantic, null);
          }
        }
      }
    }

    // ---- 2. one material, one primitive per mesh ----
    const material = document.getRoot().listMaterials()[0] || document.createMaterial("metal");
    for (const mesh of document.getRoot().listMeshes()) {
      const prims = mesh.listPrimitives();
      for (const prim of prims) prim.setMaterial(material);
      if (prims.length < 2) continue;
      let joined;
      try {
        joined = joinPrimitives(prims);
      } catch (err) {
        console.warn("    WARNING: " + rel + ": mesh \"" + mesh.getName() + "\" keeps " + prims.length +
          " primitives (" + err.message + ")");
        continue;
      }
      for (const prim of prims) {
        mesh.removePrimitive(prim);
        prim.dispose();
      }
      mesh.addPrimitive(joined);
    }

    const transforms = [
      // Weld first: dedup/prune see the merged mesh, and simplify needs shared edges.
      weld(),
      dedup(),
      prune()
    ];
    if (simplifyRatio !== null) {
      transforms.push(simplify({ simplifier: meshoptimizer.MeshoptSimplifier, ratio: simplifyRatio, error: 0.001 }));
      transforms.push(prune());
    }
    transforms.push(draco());

    await document.transform(...transforms);

    const after = measure(document);

    if (!dryRun) {
      await io.write(file, document);
    }

    const sizeAfter = dryRun
      ? (await io.writeBinary(document)).byteLength
      : statSync(file).size;
    totalAfter += sizeAfter;

    // Decode the written file itself: it overwrites the only copy. Triangles and
    // extents must match; vertex count may wobble ~2% as Draco re-splits corners
    // that quantization made diverge.
    let verified = null;
    if (!dryRun) {
      const roundTrip = measure(await io.read(file));
      const vertexDelta = after.vertices ? Math.abs(roundTrip.vertices - after.vertices) / after.vertices : 0;
      const ok = roundTrip.triangles === after.triangles &&
                 vertexDelta <= 0.02 &&
                 boundsDrift(after, roundTrip) <= 1 / 4096;
      verified = ok ? "decodes clean" : "MISMATCH";
      if (!ok) {
        process.exitCode = 1;
        console.error("    " + rel + " did not survive a decode round trip: " +
          "triangles " + after.triangles + " -> " + roundTrip.triangles + ", " +
          "vertices " + after.vertices + " -> " + roundTrip.vertices + ", " +
          "bounds drift " + (boundsDrift(after, roundTrip) * 100).toFixed(4) + "%");
      }
    }

    const dropped = before.attributes.filter((a) => !after.attributes.includes(a));
    // One step of a 2^14 grid, with a 4x margin.
    const drift = boundsDrift(before, after);
    const DRIFT_BUDGET = 1 / 4096;
    if (drift > DRIFT_BUDGET && simplifyRatio === null) {
      console.warn("    WARNING: bounding box moved by " + (drift * 100).toFixed(3) +
        "% of the model's own size — expected under " + (DRIFT_BUDGET * 100).toFixed(3) + "%");
    }
    console.log(
      rel + "\n" +
      "    size      " + mb(sizeBefore) + "  ->  " + mb(sizeAfter) +
      "   (" + (sizeBefore ? (100 - (sizeAfter / sizeBefore) * 100).toFixed(1) : "0") + "% smaller)\n" +
      "    vertices  " + before.vertices.toLocaleString() + "  ->  " + after.vertices.toLocaleString() + "\n" +
      "    triangles " + before.triangles.toLocaleString() + "  ->  " + after.triangles.toLocaleString() + "\n" +
      "    parts     " + before.primitives + "  ->  " + after.primitives + "\n" +
      "    bounds    " + (drift === 0 ? "unchanged" : "moved " + (drift * 100).toFixed(4) + "% of model size") +
      (verified ? "   [" + verified + "]" : "") + "\n" +
      "    dropped   " + (dropped.length ? dropped.join(", ") : "-") +
      (before.textures ? ", " + before.textures + " texture(s)" : "") +
      (before.draco ? "   [was already Draco]" : "")
    );
  }

  console.log(
    "\n" + (dryRun ? "DRY RUN — nothing written. " : "") +
    files.length + " model(s): " + mb(totalBefore) + "  ->  " + mb(totalAfter) +
    "   (" + (100 - (totalAfter / totalBefore) * 100).toFixed(1) + "% smaller)"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
