#!/usr/bin/env node
// Downsamples the Radiance .hdr environment maps. They only feed PMREM (top
// level 256px a side), so 1024 wide loses nothing visible.
//
// Hand-rolled RGBE codec: sharp's libvips is built without Radiance support.
// The box filter runs in LINEAR space, never on RGBE bytes: the shared
// exponent puts neighbouring mantissas on different scales.
//
// Writes a sibling with the new _<n>k width bucket and prints the
// data/series.json paths to update; never overwrites the source.
//
//   npm run optimize-hdri -- --dry-run     report only
//   npm run optimize-hdri                  every .hdr wider than 1024
//   npm run optimize-hdri -- <path.hdr>    only this one
//   npm run optimize-hdri -- --width=512   another target width

const { readdirSync, statSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve, dirname, basename } = require("node:path");
const { ROOT, repoPath } = require("./helpers");

const HDRI_DIR = join(ROOT, "assets", "hdri");

const DEFAULT_TARGET_WIDTH = 1024;

/* ---- Radiance RGBE decoding ----
     #?RADIANCE          magic
     FORMAT=...          variables, ended by a blank line
     -Y <h> +X <w>       resolution line, right before the pixel data
   Only -Y/+X, the orientation every tool writes; others are refused, not mis-decoded. */

function parseHeader(buf) {
  const magic = buf.toString("ascii", 0, 10);
  if (!magic.startsWith("#?RADIANCE") && !magic.startsWith("#?RGBE")) {
    throw new Error("not a Radiance file (bad magic)");
  }

  let offset = 0;
  let format = null;
  let sawBlankLine = false;

  // Line by line: everything after the resolution line is binary.
  for (;;) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) throw new Error("malformed header (no resolution line)");
    const line = buf.toString("ascii", offset, nl).trim();
    offset = nl + 1;

    if (line.startsWith("FORMAT=")) format = line.slice(7).trim();

    if (line === "") {
      sawBlankLine = true;
      continue;
    }
    // The resolution line ends the header, once past the blank line.
    if (sawBlankLine) {
      const res = /^-Y\s+(\d+)\s+\+X\s+(\d+)$/.exec(line);
      if (!res) {
        throw new Error(
          'unsupported resolution line "' + line + '" — only "-Y <h> +X <w>" is handled'
        );
      }
      return {
        width: parseInt(res[2], 10),
        height: parseInt(res[1], 10),
        format: format,
        dataOffset: offset
      };
    }
  }
}

// One scanline -> `out` (4 bytes per pixel); returns the new offset. Either
// flat, or adaptive RLE (0x02 0x02 marker) with each channel run-length
// encoded separately; files can mix both per line.
function readScanline(buf, offset, width, out) {
  const adaptive =
    width >= 8 &&
    width < 32768 &&
    buf[offset] === 2 &&
    buf[offset + 1] === 2 &&
    ((buf[offset + 2] << 8) | buf[offset + 3]) === width;

  if (!adaptive) {
    for (let x = 0; x < width; x++) {
      out[x * 4] = buf[offset++];
      out[x * 4 + 1] = buf[offset++];
      out[x * 4 + 2] = buf[offset++];
      out[x * 4 + 3] = buf[offset++];
    }
    return offset;
  }

  offset += 4; // consume the 0x02 0x02 <width-hi> <width-lo> marker
  for (let channel = 0; channel < 4; channel++) {
    let x = 0;
    while (x < width) {
      let count = buf[offset++];
      if (count > 128) {
        // A run: one value repeated (count - 128) times.
        count -= 128;
        const value = buf[offset++];
        if (x + count > width) throw new Error("RLE run overruns the scanline");
        for (let i = 0; i < count; i++) out[(x++) * 4 + channel] = value;
      } else {
        // A literal span of `count` values.
        if (count === 0) throw new Error("zero-length RLE span");
        if (x + count > width) throw new Error("RLE span overruns the scanline");
        for (let i = 0; i < count; i++) out[(x++) * 4 + channel] = buf[offset++];
      }
    }
  }
  return offset;
}

// -> { width, height, data: Float32Array } of linear RGB.
// value = mantissa * 2^(e - 136); e === 0 is exact black.
function decodeToLinear(buf) {
  const header = parseHeader(buf);
  const { width, height, dataOffset } = header;
  const rgbe = new Uint8Array(width * 4);
  const out = new Float32Array(width * height * 3);

  let offset = dataOffset;
  for (let y = 0; y < height; y++) {
    offset = readScanline(buf, offset, width, rgbe);
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      const e = rgbe[x * 4 + 3];
      if (e === 0) {
        out[row + x * 3] = 0;
        out[row + x * 3 + 1] = 0;
        out[row + x * 3 + 2] = 0;
        continue;
      }
      const scale = Math.pow(2, e - 136);
      out[row + x * 3] = rgbe[x * 4] * scale;
      out[row + x * 3 + 1] = rgbe[x * 4 + 1] * scale;
      out[row + x * 3 + 2] = rgbe[x * 4 + 2] * scale;
    }
  }
  return { width, height, format: header.format, data: out };
}

/* ---- resampling ----
   Box filter, exact integer ratios only: then it is the true area average,
   with no negative lobes, which RGBE couldn't represent. */
function boxDownsample(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  const bx = srcWidth / dstWidth;
  const by = srcHeight / dstHeight;
  if (!Number.isInteger(bx) || !Number.isInteger(by)) {
    throw new Error(
      "only integer reduction ratios are supported (got " +
        srcWidth + "x" + srcHeight + " -> " + dstWidth + "x" + dstHeight + ")"
    );
  }

  const out = new Float32Array(dstWidth * dstHeight * 3);
  const samples = bx * by;
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < by; sy++) {
        const srcRow = (y * by + sy) * srcWidth * 3;
        for (let sx = 0; sx < bx; sx++) {
          const i = srcRow + (x * bx + sx) * 3;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      }
      const o = (y * dstWidth + x) * 3;
      out[o] = r / samples;
      out[o + 1] = g / samples;
      out[o + 2] = b / samples;
    }
  }
  return out;
}

/* ---- Radiance RGBE encoding ---- */

// One linear RGB triple -> 4 RGBE bytes at `out[at]`.
function encodePixel(r, g, b, out, at) {
  const max = Math.max(r, g, b);
  if (max < 1e-32) {
    out[at] = 0;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    return;
  }
  let e = Math.ceil(Math.log2(max));
  // Math.log2 isn't exact: nudge until max * 2^-e is in [0.5, 1), so no
  // mantissa can round to 256.
  while (max * Math.pow(2, -e) >= 1) e++;
  while (max * Math.pow(2, -e) < 0.5) e--;
  const scale = Math.pow(2, -e) * 256;
  out[at] = Math.min(255, Math.floor(r * scale));
  out[at + 1] = Math.min(255, Math.floor(g * scale));
  out[at + 2] = Math.min(255, Math.floor(b * scale));
  out[at + 3] = e + 128;
}

// Adaptive RLE per channel, as readScanline reads it; runs of 4+ (Radiance's
// own threshold) become runs.
function encodeScanline(rgbe, width, chunks) {
  const header = Buffer.alloc(4);
  header[0] = 2;
  header[1] = 2;
  header[2] = (width >> 8) & 0xff;
  header[3] = width & 0xff;
  chunks.push(header);

  for (let channel = 0; channel < 4; channel++) {
    const line = Buffer.alloc(width);
    for (let x = 0; x < width; x++) line[x] = rgbe[x * 4 + channel];

    const encoded = [];
    let x = 0;
    while (x < width) {
      let runEnd = x;
      while (runEnd < width && line[runEnd] === line[x]) runEnd++;
      const runLength = runEnd - x;

      if (runLength >= 4) {
        let remaining = runLength;
        while (remaining > 0) {
          const n = Math.min(127, remaining); // 128 + n must stay in a byte
          encoded.push(128 + n, line[x]);
          remaining -= n;
        }
        x = runEnd;
        continue;
      }

      // A literal span, up to the next run of 4+.
      let spanEnd = x;
      while (spanEnd < width) {
        let ahead = spanEnd;
        while (ahead < width && line[ahead] === line[spanEnd]) ahead++;
        if (ahead - spanEnd >= 4) break;
        spanEnd = ahead;
      }
      let spanStart = x;
      while (spanStart < spanEnd) {
        const n = Math.min(128, spanEnd - spanStart);
        encoded.push(n);
        for (let i = 0; i < n; i++) encoded.push(line[spanStart + i]);
        spanStart += n;
      }
      x = spanEnd;
    }
    chunks.push(Buffer.from(encoded));
  }
}

function encodeHdr(linear, width, height, formatLine) {
  const chunks = [];
  chunks.push(
    Buffer.from(
      "#?RADIANCE\n" +
        "# Downsampled by scripts/optimize-hdri.js\n" +
        "FORMAT=" + (formatLine || "32-bit_rle_rgbe") + "\n" +
        "\n" +
        "-Y " + height + " +X " + width + "\n",
      "ascii"
    )
  );

  const rgbe = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      encodePixel(linear[row + x * 3], linear[row + x * 3 + 1], linear[row + x * 3 + 2], rgbe, x * 4);
    }
    encodeScanline(rgbe, width, chunks);
  }
  return Buffer.concat(chunks);
}

/* ---- naming ----
   Rewrites the _<n>k width bucket in the name (appends one if absent), from
   the real pixel width: existing names aren't reliable. */
function bucketFor(width) {
  return Math.max(1, Math.round(width / 1024)) + "k";
}

function targetNameFor(file, width) {
  const base = basename(file, ".hdr");
  const bucket = bucketFor(width);
  const rewritten = base.replace(/_\d+k$/, "_" + bucket);
  return (rewritten === base ? base + "_" + bucket : rewritten) + ".hdr";
}

/* ---- run ---- */

function listHdris() {
  if (!existsSync(HDRI_DIR)) return [];
  return readdirSync(HDRI_DIR)
    .filter((name) => name.toLowerCase().endsWith(".hdr"))
    .map((name) => join(HDRI_DIR, name));
}

function formatBytes(n) {
  return (n / 1048576).toFixed(2) + " MB";
}

// Mean luminance (Rec.709). A box average preserves it, so drift past a
// fraction of a percent means the codec or resample is wrong.
function meanLuminance(linear) {
  let sum = 0;
  const pixels = linear.length / 3;
  for (let i = 0; i < linear.length; i += 3) {
    sum += 0.2126 * linear[i] + 0.7152 * linear[i + 1] + 0.0722 * linear[i + 2];
  }
  return sum / pixels;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const widthArg = args.find((a) => a.startsWith("--width="));
  const targetWidth = widthArg ? parseInt(widthArg.slice(8), 10) : DEFAULT_TARGET_WIDTH;
  if (!Number.isInteger(targetWidth) || targetWidth < 1) {
    console.error("--width must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const explicit = args.filter((a) => !a.startsWith("--")).map((p) => resolve(ROOT, p));
  const files = explicit.length ? explicit : listHdris();

  if (!files.length) {
    console.log("No .hdr files found under assets/hdri/.");
    return;
  }

  console.log(
    (dryRun ? "Dry run — " : "") +
      "target width " + targetWidth + ", " + files.length + " file(s) to consider\n"
  );

  let failures = 0;
  let written = 0;
  let savedBytes = 0;
  const pathUpdates = [];

  for (const file of files) {
    const rel = repoPath(file);
    if (!existsSync(file)) {
      console.error("  " + rel + " — not found");
      failures++;
      continue;
    }

    let source;
    try {
      source = decodeToLinear(readFileSync(file));
    } catch (err) {
      console.error("  " + rel + " — could not decode: " + err.message);
      failures++;
      continue;
    }

    const sizeBefore = statSync(file).size;
    if (source.width <= targetWidth) {
      console.log(
        "  " + rel + " — already " + source.width + "x" + source.height +
          " (" + formatBytes(sizeBefore) + "), skipped"
      );
      continue;
    }

    const dstWidth = targetWidth;
    const dstHeight = Math.round((source.height / source.width) * targetWidth);

    let resampled;
    try {
      resampled = boxDownsample(source.data, source.width, source.height, dstWidth, dstHeight);
    } catch (err) {
      console.error("  " + rel + " — " + err.message);
      failures++;
      continue;
    }

    const encoded = encodeHdr(resampled, dstWidth, dstHeight, source.format);

    // Re-decode the encoded bytes and check size and light level.
    let check;
    try {
      check = decodeToLinear(encoded);
    } catch (err) {
      console.error("  " + rel + " — output failed to re-decode: " + err.message);
      failures++;
      continue;
    }
    if (check.width !== dstWidth || check.height !== dstHeight) {
      console.error(
        "  " + rel + " — round trip changed dimensions: expected " +
          dstWidth + "x" + dstHeight + ", got " + check.width + "x" + check.height
      );
      failures++;
      continue;
    }
    const before = meanLuminance(resampled);
    const after = meanLuminance(check.data);
    const drift = before === 0 ? 0 : Math.abs(after - before) / before;
    if (drift > 0.01) {
      console.error(
        "  " + rel + " — round trip shifted mean luminance by " +
          (drift * 100).toFixed(2) + "% (limit 1%)"
      );
      failures++;
      continue;
    }

    const outName = targetNameFor(file, dstWidth);
    const outPath = join(dirname(file), outName);
    const outRel = repoPath(outPath);

    console.log(
      "  " + rel + "\n" +
        "      " + source.width + "x" + source.height + "  " + formatBytes(sizeBefore) +
        "   ->   " + dstWidth + "x" + dstHeight + "  " + formatBytes(encoded.length) +
        "   (-" + (100 - (encoded.length / sizeBefore) * 100).toFixed(1) + "%)\n" +
        "      luminance drift " + (drift * 100).toFixed(4) + "%   ->  " + outRel
    );

    savedBytes += sizeBefore - encoded.length;

    if (!dryRun) {
      if (outPath === file) {
        console.error("      refusing to overwrite the source under the same name");
        failures++;
        continue;
      }
      writeFileSync(outPath, encoded);
      written++;
      pathUpdates.push({ from: rel, to: outRel });
    }
  }

  console.log("");
  if (dryRun) {
    console.log("Dry run — nothing written. Would save " + formatBytes(savedBytes) + ".");
  } else if (written) {
    console.log("Wrote " + written + " file(s), saving " + formatBytes(savedBytes) + ".");
    console.log(
      "\nThe old files are still on disk and still referenced. Update the\n" +
        '"hdris" map in data/series.json, then delete the originals:\n'
    );
    pathUpdates.forEach((u) => console.log("  " + u.from + "\n    -> " + u.to));
  }

  if (failures) {
    console.error("\n" + failures + " file(s) failed.");
    process.exitCode = 1;
  }
}

main();
