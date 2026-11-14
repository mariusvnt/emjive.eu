#!/usr/bin/env node
// Ring sizing, ported from the Jewelry Printing Toolbox (ring_tools/sizer.py),
// for the print models and their measurements; also the size-stl command that
// writes a print model at an ordered size.
//
// A ring changes size by moving every vertex radially around the finger axis:
// each keeps its angle, and its distance from the axis changes by the same
// amount for every vertex, the difference of the sizes' inner radii. The bore
// lands on the size while radial thickness stays as designed. Its length along
// the finger then follows AXIAL_STRETCH_SHARE of the change in its outside
// width (a stretch along the axis about the origin), so a small ring doesn't
// reach as far down the finger as a large one. Sizes are EU: the inner
// circumference in mm. The axis runs through the model's origin.
// js/three-viewer.js sizes the site's models the same way (sizeShiftShader),
// with js/helpers.js sizeShift and axialStretch.
//
//   npm run size-stl -- <product or design name> <size> [--from=<size>] [--axis=X|Y|Z] [--stretch-share=<0-1>] [--out=<path>]
//
// --from: the STL's own size (default REFERENCE_SIZE_MM). --axis: its finger
// axis (default Y, the print models' and the toolbox's). --stretch-share:
// default AXIAL_STRETCH_SHARE, 0 for the radial shift alone. The sized model
// is written next to the source as <stem>_<size>.stl unless --out names a path.

"use strict";

const path = require("node:path");
const { writeFileSync } = require("node:fs");
const stlFile = require("./stl");
const { ROOT, SERIES_JSON_PATH, REFERENCE_SIZE_MM, AXIAL_STRETCH_SHARE, readJson, argValue } = require("./helpers");

const AXES = { X: 0, Y: 1, Z: 2 };
// The print models' finger axis (checked by scripts/measure-models.js).
const STL_AXIS = AXES.Y;

// Inner radius in mm for an EU size.
function sizeToRadius(sizeMm) {
  return sizeMm / (2 * Math.PI);
}

// EU size for an inner radius in mm.
function radiusToSize(radiusMm) {
  return radiusMm * 2 * Math.PI;
}

// Radial shift in mm from the reference size to the target size.
function shiftFor(referenceSize, targetSize) {
  return sizeToRadius(targetSize) - sizeToRadius(referenceSize);
}

// The two axes other than `axis`, in order.
function across(axis) {
  return [0, 1, 2].filter((i) => i !== axis);
}

// Flat xyz `points` moved `delta` mm away from the axis through the origin, as a new array.
function polarShift(points, delta, axis) {
  const [a, b] = across(axis);
  const out = Float64Array.from(points);
  for (let i = 0; i < out.length; i += 3) {
    const r = Math.hypot(out[i + a], out[i + b]);
    if (r < 1e-9 || r + delta <= 0) {
      throw new Error("shift of " + delta.toFixed(3) + " mm would collapse geometry onto the ring axis");
    }
    const k = (r + delta) / r;
    out[i + a] *= k;
    out[i + b] *= k;
  }
  return out;
}

// A ring's outside width across `axis`: the mean of its box's two extents there.
function outsideWidth(points, axis) {
  const [a, b] = across(axis);
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    lo[0] = Math.min(lo[0], points[i + a]);
    hi[0] = Math.max(hi[0], points[i + a]);
    lo[1] = Math.min(lo[1], points[i + b]);
    hi[1] = Math.max(hi[1], points[i + b]);
  }
  return ((hi[0] - lo[0]) + (hi[1] - lo[1])) / 2;
}

// The stretch along the finger of a ring `width` mm across shifted `delta` mm:
// its length follows `share` of the change in its outside width, 2 * delta.
function axialStretch(delta, width, share = AXIAL_STRETCH_SHARE) {
  return 1 + share * 2 * delta / width;
}

// Flat xyz `points` sized by `delta` mm, as a new array: shifted
// (polarShift), then stretched along the axis about the origin (axialStretch
// for their own outside width).
function resize(points, delta, axis, share = AXIAL_STRETCH_SHARE) {
  const stretch = axialStretch(delta, outsideWidth(points, axis), share);
  if (!(stretch > 0)) throw new Error("shift of " + delta.toFixed(3) + " mm would flatten the ring along its axis");
  const out = polarShift(points, delta, axis);
  for (let i = axis; i < out.length; i += 3) out[i] *= stretch;
  return out;
}

// numpy.percentile's default (linear) on an unsorted array.
function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const at = (sorted.length - 1) * p / 100;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// Best guess of a ring's EU size from its points: the smallest radius in each
// angular sector around the axis (the bore), and a low percentile of those, so
// details reaching into the bore over a few sectors don't pull it down. About
// one size of uncertainty on sculpted bores; a cylinder comes out exact.
function estimateSize(points, axis, sectors = 180, pct = 40) {
  const [a, b] = across(axis);
  const smallest = new Float64Array(sectors).fill(Infinity);
  for (let i = 0; i < points.length; i += 3) {
    const r = Math.hypot(points[i + a], points[i + b]);
    const theta = Math.atan2(points[i + b], points[i + a]);
    const sector = Math.floor((theta + Math.PI) / (2 * Math.PI) * sectors) % sectors;
    if (r < smallest[sector]) smallest[sector] = r;
  }
  const found = smallest.filter(isFinite);
  if (!found.length) throw new Error("no geometry around the axis");
  return radiusToSize(percentile(found, pct));
}

// Distance in mm from the axis to the point nearest to it.
function axisClearance(points, axis) {
  const [a, b] = across(axis);
  let min = Infinity;
  for (let i = 0; i < points.length; i += 3) min = Math.min(min, Math.hypot(points[i + a], points[i + b]));
  return min;
}

// { axis, clearance }: the axis whose line through the origin runs farthest
// from the points. The finger axis goes through the bore; the other two cross
// the band. A small clearance means the origin is off the bore.
function detectAxis(points) {
  let best = { axis: 0, clearance: -Infinity };
  for (const axis of [0, 1, 2]) {
    const clearance = axisClearance(points, axis);
    if (clearance > best.clearance) best = { axis, clearance };
  }
  return best;
}

// Smallest target size before the point nearest the axis (clearance mm away
// at referenceSize) would reach it.
function minSize(clearance, referenceSize, marginMm = 0.01) {
  return referenceSize - radiusToSize(Math.max(clearance - marginMm, 0));
}

// ---- size-stl ----

// The print model of a product or design named `name`, repo-relative; null if none.
function stlNamed(name) {
  for (const series of readJson(SERIES_JSON_PATH).series || []) {
    for (const product of readJson(path.join(ROOT, series.products)).products || []) {
      if (product.name === name) return (product.assets && product.assets.stl) || null;
      for (const design of (product.designs && product.designs.list) || []) {
        if (design.name === name) return design.stl || (product.assets && product.assets.stl) || null;
      }
    }
  }
  return null;
}

// Triangles (9 numbers each) as a binary STL, facet normals recomputed.
function stlBytes(tris, label) {
  const count = tris.length / 9;
  const out = Buffer.alloc(84 + count * 50);
  out.write(String(label).slice(0, 79), 0, "latin1");
  out.writeUInt32LE(count, 80);
  for (let t = 0; t < count; t++) {
    const p = tris.subarray(t * 9, t * 9 + 9);
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
    const v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    const at = 84 + t * 50;
    for (let k = 0; k < 3; k++) out.writeFloatLE(length > 0 ? n[k] / length : 0, at + k * 4);
    for (let k = 0; k < 9; k++) out.writeFloatLE(p[k], at + 12 + k * 4);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const [name, sizeText] = args.filter((arg) => !arg.startsWith("--"));
  const size = Number(sizeText);
  const reference = Number(argValue(args, "from") || REFERENCE_SIZE_MM);
  const axisName = (argValue(args, "axis") || "Y").toUpperCase();
  const share = argValue(args, "stretch-share") !== undefined ? Number(argValue(args, "stretch-share")) : AXIAL_STRETCH_SHARE;
  if (!name || !(size > 0) || !(reference > 0) || !(axisName in AXES) || !(share >= 0)) {
    console.error("usage: npm run size-stl -- <product or design name> <size> [--from=<size>] [--axis=X|Y|Z] [--stretch-share=<0-1>] [--out=<path>]");
    process.exitCode = 1;
    return;
  }
  const rel = stlNamed(name);
  if (!rel) {
    console.error(name + ": no product or design of that name has a print model");
    process.exitCode = 1;
    return;
  }
  const source = path.join(ROOT, rel);
  const stl = stlFile.readStl(source);
  const delta = shiftFor(reference, size);
  const stem = path.basename(source, path.extname(source));
  const output = argValue(args, "out") ? path.resolve(argValue(args, "out")) : path.join(path.dirname(source), stem + "_" + size + ".stl");
  const tris = stlFile.trianglesOf(stl, 0, stl.count);
  const stretch = axialStretch(delta, outsideWidth(tris, AXES[axisName]), share);
  writeFileSync(output, stlBytes(resize(tris, delta, AXES[axisName], share), stem + " EU " + size));
  console.log(path.basename(source) + ": EU " + reference + " -> " + size + " (inner diameter " +
    (2 * sizeToRadius(size)).toFixed(3) + " mm, radial shift " + (delta >= 0 ? "+" : "") + delta.toFixed(3) +
    " mm, length x" + stretch.toFixed(3) + "): " +
    (output.startsWith(ROOT + path.sep) ? path.relative(ROOT, output) : output));
}

module.exports = { AXES, STL_AXIS, sizeToRadius, radiusToSize, shiftFor, polarShift, outsideWidth, axialStretch, resize, estimateSize, axisClearance, detectAxis, minSize };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
