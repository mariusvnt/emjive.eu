// Binary STL reading, splitting and writing for the print models
// (scripts/split-models.js, scripts/measure-models.js).
// Format: 80-byte header, uint32 triangle count, 50 bytes per triangle
// (normal, three float32 corners, two attribute bytes). No names, units or vertex ids.

"use strict";

const { readFileSync, writeFileSync } = require("node:fs");

const HEADER_BYTES = 80;
const RECORD_BYTES = 50;

// The file's bytes, checked to be a binary STL of the size its count implies.
function readStl(path) {
  const buffer = readFileSync(path);
  if (buffer.length < HEADER_BYTES + 4) throw new Error(path + ": too short to be an STL");
  const count = buffer.readUInt32LE(HEADER_BYTES);
  if (buffer.length !== HEADER_BYTES + 4 + count * RECORD_BYTES) {
    throw new Error(path + ": not a binary STL (" + count + " triangles would be " +
      (HEADER_BYTES + 4 + count * RECORD_BYTES) + " bytes, the file has " + buffer.length + ")");
  }
  return { buffer, count };
}

// Triangles [from, to) as 9 numbers each (millimetres).
function trianglesOf(stl, from, to) {
  const out = new Float64Array((to - from) * 9);
  for (let t = from; t < to; t++) {
    const at = HEADER_BYTES + 4 + t * RECORD_BYTES + 12;
    const o = (t - from) * 9;
    for (let k = 0; k < 9; k++) out[o + k] = stl.buffer.readFloatLE(at + k * 4);
  }
  return out;
}

// Triangles [from, to) as a standalone STL, records copied unchanged.
function sliceStl(stl, from, to, label) {
  const count = to - from;
  const out = Buffer.alloc(HEADER_BYTES + 4 + count * RECORD_BYTES);
  out.write((label || "emjive print model").slice(0, HEADER_BYTES - 1), 0, "latin1");
  out.writeUInt32LE(count, HEADER_BYTES);
  stl.buffer.copy(out, HEADER_BYTES + 4, HEADER_BYTES + 4 + from * RECORD_BYTES, HEADER_BYTES + 4 + to * RECORD_BYTES);
  return out;
}

function writeStl(path, bytes) {
  writeFileSync(path, bytes);
}

// ---- splitting a combined export into its objects ----

// A corner's position as two 32-bit hashes (float32 bit patterns, -0 as 0).
function cornerHash(a, b, c, seed) {
  if (a === 0x80000000) a = 0;
  if (b === 0x80000000) b = 0;
  if (c === 0x80000000) c = 0;
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ a, 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35); h ^= h >>> 16;
  h = Math.imul(h ^ c, 0x27d4eb2f); h ^= h >>> 15;
  return h >>> 0;
}

// An edge's hash from its two corners' (the same either way round).
function edgeHash(hu, hv, salt) {
  const sum = (hu + hv) >>> 0;
  const xor = (hu ^ hv) >>> 0;
  let x = Math.imul(sum ^ Math.imul(xor, salt), 0x85ebca6b);
  x ^= x >>> 15;
  return x >>> 0;
}

// Where each object of a combined export ends: the triangles so far form closed
// surfaces exactly when every edge has been used an even number of times, i.e.
// when the XOR of all edge hashes (64-bit) returns to zero. Independent of
// triangle order, and of shared corners between objects, which rule out
// welding. [{ from, to }] covering the file, or null if it never closes.
function segmentStl(stl) {
  const w = new Uint32Array(9);
  const ends = [];
  let x = 0;
  let y = 0;
  for (let t = 0; t < stl.count; t++) {
    const at = HEADER_BYTES + 4 + t * RECORD_BYTES + 12;
    for (let k = 0; k < 9; k++) w[k] = stl.buffer.readUInt32LE(at + k * 4);
    const h1 = [0, 1, 2].map((k) => cornerHash(w[k * 3], w[k * 3 + 1], w[k * 3 + 2], 1));
    const h2 = [0, 1, 2].map((k) => cornerHash(w[k * 3], w[k * 3 + 1], w[k * 3 + 2], 7));
    for (let e = 0; e < 3; e++) {
      const u = e;
      const v = (e + 1) % 3;
      x ^= edgeHash(h1[u], h1[v], 0x9e3779b1);
      y ^= edgeHash(h2[u], h2[v], 0x7f4a7c15);
    }
    if (x === 0 && y === 0) ends.push(t + 1);
  }
  if (!ends.length || ends[ends.length - 1] !== stl.count) return null;
  const objects = [];
  let from = 0;
  for (const to of ends) {
    objects.push({ from, to });
    from = to;
  }
  return objects;
}

module.exports = { readStl, trianglesOf, sliceStl, writeStl, segmentStl };
