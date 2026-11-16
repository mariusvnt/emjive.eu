#!/usr/bin/env node
// Converts hand-added PNG/JPEG art under assets/ to WebP and deletes the
// originals. Doesn't rewrite products.json paths: it prints the ones to change.
//
//   npm run optimize-images -- --dry-run     report only
//   npm run optimize-images                  every PNG/JPEG
//   npm run optimize-images -- <path> ...    only these files

const { statSync, existsSync, unlinkSync } = require("node:fs");
const { join, resolve, dirname, basename, extname } = require("node:path");
const { ROOT, repoPath, walk, mb } = require("./helpers");

const ASSETS_ROOT = join(ROOT, "assets");

// Same quality as scripts/auto-render.js.
const WEBP_QUALITY = 82;

// Larger than any layout shows; smaller art is never upscaled.
const MAX_DIMENSION = 2048;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const explicit = args.filter((a) => !a.startsWith("--"));

  const files = explicit.length
    ? explicit.map((p) => resolve(ROOT, p))
    : existsSync(ASSETS_ROOT) ? walk(ASSETS_ROOT).filter((f) => /\.(png|jpe?g)$/i.test(f)) : [];

  if (!files.length) {
    console.log("No PNG/JPEG files found under assets/ — nothing to do.");
    return;
  }

  const sharp = require("sharp");
  let totalBefore = 0;
  let totalAfter = 0;
  const renames = [];

  for (const file of files) {
    const rel = repoPath(file);
    const outPath = join(dirname(file), basename(file, extname(file)) + ".webp");
    const outRel = repoPath(outPath);

    if (existsSync(outPath)) {
      console.log(rel + "\n    skipped — " + outRel + " already exists");
      continue;
    }

    const sizeBefore = statSync(file).size;
    const meta = await sharp(file).metadata();
    const tooBig = Math.max(meta.width, meta.height) > MAX_DIMENSION;

    let pipeline = sharp(file);
    if (tooBig) pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true });
    // Alpha is kept: overlays and cutouts are composited over the page.
    const buffer = await pipeline.webp({ quality: WEBP_QUALITY, alphaQuality: 90, effort: 6 }).toBuffer();

    totalBefore += sizeBefore;
    totalAfter += buffer.length;

    if (!dryRun) {
      await sharp(buffer).toFile(outPath);
      unlinkSync(file);
    }
    renames.push({ from: rel, to: outRel });

    const out = await sharp(buffer).metadata();
    console.log(
      rel + "\n" +
      "    " + mb(sizeBefore) + "  ->  " + mb(buffer.length) +
      "   (" + (100 - (buffer.length / sizeBefore) * 100).toFixed(1) + "% smaller)\n" +
      "    " + meta.width + "x" + meta.height + "  ->  " + out.width + "x" + out.height +
      (tooBig ? "   [capped at " + MAX_DIMENSION + "px]" : "")
    );
  }

  if (!renames.length) return;

  console.log(
    "\n" + (dryRun ? "DRY RUN — nothing written. " : "") +
    renames.length + " image(s): " + mb(totalBefore) + "  ->  " + mb(totalAfter) +
    "   (" + (100 - (totalAfter / totalBefore) * 100).toFixed(1) + "% smaller)"
  );
  console.log("\nUpdate these paths by hand (data/studies/<slug>/products.json):");
  for (const r of renames) console.log("  " + r.from + "  ->  " + r.to);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
