#!/usr/bin/env node
/* ==========================================================================
   render-favicons — rasterises assets/logo_compact.svg into the two raster
   icons browsers and devices still ask for by fixed name.

   The pages' <link rel="icon"> points at the SVG, which covers every current
   browser except where it doesn't (older Safari, iOS home-screen icons,
   anything that requests /favicon.ico without reading the page). Those get:

     public/favicon.ico          32x32 PNG inside an ICO container — modern
                                 readers accept PNG-in-ICO, which spares an
                                 ICO encoder dependency.
     public/apple-touch-icon.png 180x180, the mark centred on the site
                                 background (iOS fills transparency with
                                 black, so this one can't be transparent).

   public/ is copied verbatim to the root of dist/ by Vite, which is why the
   files live there and are referenced as /favicon.ico etc.

   Re-run only if the logo changes:   npm run render-favicons
   ========================================================================== */

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "assets", "logo_compact.svg");
// --bg in css/style.css.
const BACKGROUND = "#f8f8f8";

// A single-image ICO: 6-byte header, one 16-byte directory entry, then the PNG.
function wrapPngAsIco(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(1, 4);          // image count
  header.writeUInt8(size, 6);          // width
  header.writeUInt8(size, 7);          // height
  header.writeUInt8(0, 8);             // palette colours
  header.writeUInt8(0, 9);             // reserved
  header.writeUInt16LE(1, 10);         // colour planes
  header.writeUInt16LE(32, 12);        // bits per pixel
  header.writeUInt32LE(png.length, 14); // image data size
  header.writeUInt32LE(22, 18);        // image data offset
  return Buffer.concat([header, png]);
}

async function mark(size) {
  // Rendered at a high density so the vector edges stay crisp when scaled.
  return sharp(SOURCE, { density: 600 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function main() {
  const outDir = path.join(ROOT, "public");
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, "favicon.ico"), wrapPngAsIco(await mark(32), 32));

  // The mark takes ~70% of the tile so it keeps a margin after iOS rounds the corners.
  const tile = 180;
  const inner = Math.round(tile * 0.7);
  const apple = await sharp({ create: { width: tile, height: tile, channels: 3, background: BACKGROUND } })
    .composite([{ input: await mark(inner), gravity: "centre" }])
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(outDir, "apple-touch-icon.png"), apple);

  console.log("wrote public/favicon.ico and public/apple-touch-icon.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
