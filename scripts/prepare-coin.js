#!/usr/bin/env node
/* ==========================================================================
   prepare-coin — turns a 3D scan or sculpt of a coin into the small Draco
   .glb the viewer loads (assets/coin_2-euro.glb: the 2 € coin the product
   page's specs stage draws beside the ring; js/product.js ensureCoin).

   The source (a binary .stl, or a .glb from Blender) is a dense mesh — 80k to
   250k triangles, several MB, with every corner repeated per face in the
   STL. This:
   - reads the positions (and the triangles) of the first mesh, in the units
     the file is in (millimetres: the viewer draws the coin at its real size);
   - turns it, if asked, so its face looks along +Z with its top to +Y — what
     the viewer's opening view looks at (--rotate=x,y,z in degrees, applied
     in that order about the origin, after the mesh has been centred);
   - welds the corners that coincide (to 0.1 micron) into an indexed mesh;
   - centres the mesh on the middle of its bounding box;
   - drops everything but the positions (the viewer draws the coin as a flat
     fill and its edges, neither of which is lit) and writes it
     Draco-compressed, like every product model.

   Usage:  node scripts/prepare-coin.js <in.stl|in.glb> <out.glb> [--rotate=x,y,z]
   ========================================================================== */

const { readFileSync } = require("node:fs");
const { resolve, extname } = require("node:path");

function readStl(file) {
  const buf = readFileSync(file);
  const triangles = buf.readUInt32LE(80);
  if (buf.length !== 84 + triangles * 50) throw new Error(file + " is not a binary STL (size doesn't match its triangle count)");
  const out = new Float32Array(triangles * 9);
  let at = 84;
  for (let t = 0; t < triangles; t++) {
    at += 12;
    for (let k = 0; k < 9; k++, at += 4) out[t * 9 + k] = buf.readFloatLE(at);
    at += 2;
  }
  return out;
}

async function readGlb(file) {
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const draco3d = (await import("draco3dgltf")).default;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
  const document = await io.read(file);
  const mesh = document.getRoot().listMeshes()[0];
  if (!mesh) throw new Error(file + " has no mesh");
  const out = [];
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute("POSITION");
    const index = primitive.getIndices();
    const count = index ? index.getCount() : position.getCount();
    for (let i = 0; i < count; i++) {
      const v = index ? index.getScalar(i) : i;
      const p = position.getElement(v, [0, 0, 0]);
      out.push(p[0], p[1], p[2]);
    }
  }
  return Float32Array.from(out);
}

// Rotation about X, then Y, then Z, in degrees, of a flat list of points.
function rotate(points, degrees) {
  const [rx, ry, rz] = degrees.map((d) => (d * Math.PI) / 180);
  const turn = (a, b, angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [a * c - b * s, a * s + b * c];
  };
  for (let i = 0; i < points.length; i += 3) {
    let x = points[i], y = points[i + 1], z = points[i + 2];
    if (rx) [y, z] = turn(y, z, rx);
    if (ry) [z, x] = turn(z, x, ry);
    if (rz) [x, y] = turn(x, y, rz);
    points[i] = x; points[i + 1] = y; points[i + 2] = z;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [input, output] = args.filter((a) => !a.startsWith("--"));
  const rotateArg = (args.find((a) => a.startsWith("--rotate=")) || "").split("=")[1];
  if (!input || !output) {
    console.error("Usage: node scripts/prepare-coin.js <in.stl|in.glb> <out.glb> [--rotate=x,y,z]");
    process.exitCode = 1;
    return;
  }
  const file = resolve(input);
  const corners = extname(file).toLowerCase() === ".stl" ? readStl(file) : await readGlb(file);
  if (rotateArg) rotate(corners, rotateArg.split(",").map(Number));

  const slots = new Map();
  const positions = [];
  const indices = new Uint32Array(corners.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < indices.length; c++) {
    const p = [corners[c * 3], corners[c * 3 + 1], corners[c * 3 + 2]];
    const key = p.map((x) => Math.round(x * 1e4)).join(",");
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = positions.length / 3;
      slots.set(key, slot);
      positions.push(p[0], p[1], p[2]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
    indices[c] = slot;
  }
  const centre = min.map((lo, k) => (lo + max[k]) / 2);
  const centred = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) centred[i] = positions[i] - centre[i % 3];

  const { Document, NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { draco } = await import("@gltf-transform/functions");
  const draco3d = (await import("draco3dgltf")).default;

  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setArray(centred).setBuffer(buffer);
  const index = document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(index);
  const mesh = document.createMesh("coin").addPrimitive(primitive);
  const node = document.createNode("coin").setMesh(mesh);
  document.createScene("coin").addChild(node);

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "draco3d.encoder": await draco3d.createEncoderModule()
    });
  await document.transform(draco());
  await io.write(resolve(output), document);

  const size = max.map((hi, k) => (hi - min[k]).toFixed(3));
  console.log(
    input + " -> " + output + "\n" +
    "    triangles " + (indices.length / 3).toLocaleString() + ", vertices " + (positions.length / 3).toLocaleString() + "\n" +
    "    size      " + size.join(" x ") + " (centred on the origin)"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
