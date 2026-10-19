#!/usr/bin/env node
// Writes the size variants of the site's big images (see js/loader.js):
//
//                  desktop                 smartphone (cropped to the centre)
//   low res        <name>_lo.webp          <name>_m_lo.webp
//   high res       <name>.webp (original)  <name>_m.webp
//
// Rules, under assets/series/<slug>/:
//   products/<n>/<n>_xray.webp            all four
//   hero/<n>_3k.webp                      all four
//   hero/hand_xray*.webp                  _m only, cropped exactly like the picture they overlay
//   products/<n>/<n>_icon_<metal>.webp    <name>_128.webp thumbnail
//
//   npm run image-variants                 write missing ones
//   npm run image-variants -- --force      rewrite all
//   npm run image-variants -- --dry-run    report only
//   npm run image-variants -- --series=<slug>
// Also called by scripts/auto-render.js through makeVariants().

const { statSync, existsSync, writeFileSync } = require("node:fs");
const { join, dirname, basename, extname } = require("node:path");
const { ROOT, repoPath, walk, argValue } = require("./helpers");

const ASSETS_ROOT = join(ROOT, "assets", "series");

// Share of the width a smartphone version keeps, around the centre. Mirrored
// by --xray-crop (css/style.css) and --hero-crop (series/<slug>/hero.css);
// validate-data.js checks they match.
//   xray: a 375-640px phone shows 0.74-0.83 of the backdrop's box; 0.85 clears both.
//   hero: a portrait phone (aspect <= 3:5) shows at most 0.6 * 9/16 of it; 0.40 clears that.
const PHONE_CROP = { xray: 0.85, hero: 0.4 };

// { suffix, width|height, crop?, quality }: cropped to the middle `crop` of the
// width, then resized (never enlarged). Low-res versions are the throwaway
// first paint, hence the lower quality.
const XRAY = [
  { suffix: "lo", width: 640, quality: 72 },
  { suffix: "m", crop: PHONE_CROP.xray, height: 1600, quality: 78 },
  { suffix: "m_lo", crop: PHONE_CROP.xray, height: 800, quality: 70 }
];
const HERO = [
  { suffix: "lo", width: 1280, quality: 74 },
  { suffix: "m", crop: PHONE_CROP.hero, quality: 80 },
  { suffix: "m_lo", crop: PHONE_CROP.hero, height: 810, quality: 72 }
];
// 1600 tall: ~1.9x a phone viewport, indistinguishable from 2160 on these soft
// x-rays, and 7.3MB decoded instead of 12.7MB.
const HERO_LAYER = [{ suffix: "m", crop: PHONE_CROP.hero, height: 1600, quality: 80 }];

const RULES = [
  { kind: "xray", pattern: /[\\/]products[\\/].*_xray\.webp$/, versions: XRAY },
  { kind: "hero", pattern: /[\\/]hero[\\/].*_3k\.webp$/, versions: HERO },
  { kind: "hero", pattern: /[\\/]hero[\\/](hand_xray|hand_xray_extension_\d+)\.webp$/, versions: HERO_LAYER },
  { kind: "icons", pattern: /[\\/]products[\\/].*_icon_[a-z0-9-]+\.webp$/i, versions: [{ suffix: "128", width: 128, quality: 82 }] }
];

function kb(bytes) {
  return (bytes / 1024).toFixed(0) + " KB";
}

async function render(sharp, file, version) {
  let pipeline = sharp(file);
  if (version.crop) {
    const meta = await sharp(file).metadata();
    const width = Math.round(meta.width * version.crop);
    pipeline = pipeline.extract({
      left: Math.round((meta.width - width) / 2),
      top: 0,
      width,
      height: meta.height
    });
  }
  if (version.width || version.height) {
    pipeline = pipeline.resize({ width: version.width, height: version.height, withoutEnlargement: true });
  }
  return pipeline.webp({ quality: version.quality, alphaQuality: 90, effort: 6 }).toBuffer();
}

// options: { dryRun, force, series, kinds }
//   force   rewrite existing versions
//   series  limit to assets/series/<slug>
//   kinds   limit to "xray", "hero" and/or "icons"
async function makeVariants(options) {
  const opts = options || {};
  const root = opts.series ? join(ASSETS_ROOT, opts.series) : ASSETS_ROOT;
  if (!existsSync(root)) throw new Error("No such series folder: " + repoPath(root));
  const rules = opts.kinds ? RULES.filter((r) => opts.kinds.includes(r.kind)) : RULES;
  const sharp = require("sharp");

  let made = 0;
  let skipped = 0;
  for (const file of walk(root).sort()) {
    const rule = rules.find((r) => r.pattern.test(file));
    if (!rule) continue;
    for (const version of rule.versions) {
      const out = join(dirname(file), basename(file, extname(file)) + "_" + version.suffix + extname(file));
      const rel = repoPath(out);
      if (existsSync(out) && !opts.force) {
        skipped++;
        continue;
      }
      const buffer = await render(sharp, file, version);
      if (!opts.dryRun) writeFileSync(out, buffer);
      made++;
      console.log((opts.dryRun ? "[dry run] " : "") + rel + "  " + kb(statSync(file).size) + " -> " + kb(buffer.length));
    }
  }
  console.log("\n" + made + " variant(s) written, " + skipped + " already there" + (opts.dryRun ? " (dry run: nothing written)" : ""));
  return { made, skipped };
}

module.exports = { makeVariants, PHONE_CROP };

if (require.main === module) {
  const args = process.argv.slice(2);
  const seriesArg = argValue(args, "series");
  makeVariants({ dryRun: args.includes("--dry-run"), force: args.includes("--force"), series: seriesArg }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
