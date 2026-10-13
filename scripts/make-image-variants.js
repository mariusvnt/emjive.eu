#!/usr/bin/env node
/* ==========================================================================
   make-image-variants — writes the other versions of every big image the site
   loads in more than one size (see "responsive images" in js/loader.js).

   Four versions of an image, one file each:

                    desktop                 smartphone
     low res        <name>_lo.webp          <name>_m_lo.webp
     high res       <name>.webp (original)  <name>_m.webp

   The low ones are what a page's first paint is made of; the high ones are
   fetched afterwards, when the page is idle, and swapped in unnoticed
   (EmjiveLoader.upgradeImage). The smartphone ones are CROPPED, where the
   picture is wider than a phone can ever show — the visitor gets only the
   middle of it — and so smaller than their desktop twins whatever else is done
   to them. A phone is a viewport matching PHONE_QUERY in js/loader.js.

   The crop is a fraction of the picture's width, kept around its centre, and
   the layout has to know it: the phone rules in css/style.css and
   series/<slug>/hero.css size the box to the cropped picture's aspect ratio
   from the same number (--xray-crop, --hero-crop), and the hero's rings move
   with it. scripts/validate-data.js fails the build when the CSS and PHONE_CROP
   below disagree, and when a version is missing.

   What gets which versions (paths under assets/series/<slug>/):
     products/<n>/<n>_xray.webp      4 versions. Portrait; phone keeps the
                                      middle PHONE_CROP.xray of the width, 1600px tall
     hero/<n>_3k.webp                4 versions. 16:9; phone keeps the middle
                                      PHONE_CROP.hero, full height
     hero/hand_xray.webp, hero/hand_xray_extension_*.webp
                                      phone versions only (_m): they are hidden
                                      or far down the page, so no low-res step —
                                      cropped identically to the picture they
                                      sit on, or the layers would not line up
     products/<n>/<n>_icon_<metal>.webp   one thumbnail, <name>_128.webp: the
                                      selection bar and order rows show them at
                                      36-48px, so there is nothing to crop

   Never touches the originals and never touches the 3D models.

   Usage:
     npm run image-variants                 write any that are missing
     npm run image-variants -- --force      rewrite every one
     npm run image-variants -- --dry-run    report only
     npm run image-variants -- --series=<slug>   only that series' images

   Also run by scripts/auto-render.js, which owns the icons these come from:
   after a full render it rewrites the icon thumbnails (the icons it just wrote
   are newer than their old copies), and `auto-render --image-variants` runs
   every rule here without rendering anything. Both call makeVariants() below.
   ========================================================================== */

const { readdirSync, statSync, existsSync, writeFileSync } = require("node:fs");
const { join, resolve, relative, dirname, basename, extname } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..");
const ASSETS_ROOT = join(REPO_ROOT, "assets", "series");

// How much of the picture's width a smartphone version keeps, around the
// centre. Mirrored by --xray-crop (css/style.css) and --hero-crop
// (series/<slug>/hero.css); validate-data.js compares them.
//   xray: the backdrop is centred in a box wider than a phone, so a phone shows
//         the middle part of it only. The box is --xray-width wide (css/style.css:
//         a function of the screen's width) and a 375px phone — where the screen
//         is the largest share of it — shows 0.83 of it, a 640px one 0.74. 0.85
//         clears both, so the cut picture always reaches past the screen's
//         edges (0.74 left a band of page background at the sides of a narrow
//         phone's screen).
//   hero: the picture is as tall as the screen, so a portrait phone (aspect
//         <= 3:5, see PHONE_QUERY) shows at most 0.6 * 9/16 = 34% of its width;
//         0.40 clears that.
const PHONE_CROP = { xray: 0.85, hero: 0.4 };

// Quality below the 82 the rest of the site uses for the low versions: they are
// the throwaway first look, the full file follows. The x-ray is a soft,
// low-contrast picture that takes the lower figure well.
//
// A version is { suffix, width|height, crop?, quality }: cropped to the middle
// `crop` of the width, then resized to that width or height (never enlarged).
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
// height 1600: the two hand_xray_extension_* pictures are 3840x2160 and, cropped
// to a phone's slice, 1536x2160 — 12.7MB each once decoded. Each panel is drawn
// one viewport tall (~850 CSS px on a phone), so even 2160 is under 3x there;
// 1600 is ~1.9x, which for these soft, low-contrast x-ray lines is not
// something the eye separates from 2160, and takes each to 7.3MB decoded.
// Never enlarges, so hand_xray (1080 tall) is unaffected; the aspect ratio is
// unchanged, which is all the layout's --hero-crop sizing depends on. To undo:
// remove `height` here, delete the two _m extension files and rerun
// `npm run image-variants`.
const HERO_LAYER = [{ suffix: "m", crop: PHONE_CROP.hero, height: 1600, quality: 80 }];

const RULES = [
  { kind: "xray", pattern: /[\\/]products[\\/].*_xray\.webp$/, versions: XRAY },
  { kind: "hero", pattern: /[\\/]hero[\\/].*_3k\.webp$/, versions: HERO },
  { kind: "hero", pattern: /[\\/]hero[\\/](hand_xray|hand_xray_extension_\d+)\.webp$/, versions: HERO_LAYER },
  { kind: "icons", pattern: /[\\/]products[\\/].*_icon_[a-z0-9-]+\.webp$/i, versions: [{ suffix: "128", width: 128, quality: 82 }] }
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function kb(bytes) {
  return (bytes / 1024).toFixed(0) + " KB";
}

// The picture cropped to the middle `crop` of its width, then resized.
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
//   force   rewrite versions that already exist (default: only missing ones)
//   series  limit to assets/series/<slug>
//   kinds   limit to some of the rules: "xray", "hero", "icons"
async function makeVariants(options) {
  const opts = options || {};
  const root = opts.series ? join(ASSETS_ROOT, opts.series) : ASSETS_ROOT;
  if (!existsSync(root)) throw new Error("No such series folder: " + relative(REPO_ROOT, root));
  const rules = opts.kinds ? RULES.filter((r) => opts.kinds.includes(r.kind)) : RULES;
  const sharp = require("sharp");

  let made = 0;
  let skipped = 0;
  for (const file of walk(root, []).sort()) {
    const rule = rules.find((r) => r.pattern.test(file));
    if (!rule) continue;
    for (const version of rule.versions) {
      const out = join(dirname(file), basename(file, extname(file)) + "_" + version.suffix + extname(file));
      const rel = relative(REPO_ROOT, out).replace(/\\/g, "/");
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
  const seriesArg = (args.find((a) => a.startsWith("--series=")) || "").split("=")[1];
  makeVariants({ dryRun: args.includes("--dry-run"), force: args.includes("--force"), series: seriesArg }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
