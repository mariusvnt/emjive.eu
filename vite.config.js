// Vite config: a multi-page build made deployable on a plain static host. Adds
// the verbatim copy of what the build can't trace, the <head> fixes, load hints,
// the sitemap, one page, link preview and structured data per item, clean URLs
// in dev and preview, and the dropped decoder copies.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, transformWithEsbuild } from "vite";
import sharp from "sharp";
import { slugify } from "./scripts/slugs.js";
import { SITE_ORIGIN, PHONE_QUERY, readJson, priceSpan } from "./scripts/helpers.js";

// Vite only ships what it can trace, and most of this site's assets are named
// in runtime data (products.json, series.json, hero bundles), while classic
// <script>s aren't bundled or copied at all. So assets/, data/, js/ and
// series/ are copied verbatim after the build (closeBundle), minus:
//   assets/hdri/ unused      the HDRIs no series uses (unusedHdris)
//   assets/fonts/           Vite emits hashed copies from the @font-face and preload references
//   assets/hand_normal.webp  unused
//   logos, the pointer SVG, metal-sample_*.webp
//                            traced from HTML and CSS, so Vite emits hashed copies
//   js/three-viewer.js, viewer-entry.js, hdr-worker.js, stack-scene.js
//                            module sources Vite bundles; the unbundled copies
//                            carry bare `three` imports that can't run
// A hero bundle's JS can't use bare imports for the same reason: nothing resolves them.
const NEVER_COPY = [
  resolve(__dirname, "assets", "fonts"),
  resolve(__dirname, "assets", "hand_normal.webp"),
  resolve(__dirname, "assets", "logo.svg"),
  resolve(__dirname, "assets", "logo_compact.svg"),
  resolve(__dirname, "assets", "hand-pointer-thumb-opened.svg"),
  resolve(__dirname, "assets", "metal-sample_steel.webp"),
  resolve(__dirname, "assets", "metal-sample_silver.webp"),
  resolve(__dirname, "assets", "metal-sample_bronze.webp"),
  resolve(__dirname, "js", "three-viewer.js"),
  resolve(__dirname, "js", "viewer-entry.js"),
  resolve(__dirname, "js", "hdr-worker.js"),
  resolve(__dirname, "js", "stack-scene.js")
];

// Print models are large and for the printer, not visitors; check-dist fails if one ships.
const PRINT_MODEL = /\.stl$/i;

// data/series.json "hdris" also lists the tools' alternatives: only the ones
// a series uses ship.
function unusedHdris() {
  const index = readJson("data/series.json");
  const used = new Set(index.series.map((s) => index.hdris[s.hdri]).filter(Boolean));
  return Object.values(index.hdris).filter((p) => !used.has(p)).map((p) => resolve(__dirname, p));
}

// The verbatim-copied scripts and hero CSS in dist/ (not Vite's own bundles in dist/assets/).
function* distFilesToMinify(distDir) {
  const jsDir = join(distDir, "js");
  if (existsSync(jsDir)) {
    for (const name of readdirSync(jsDir)) {
      if (name.endsWith(".js")) yield join(jsDir, name);
    }
  }
  const seriesDir = join(distDir, "series");
  if (existsSync(seriesDir)) {
    for (const slug of readdirSync(seriesDir)) {
      const dir = join(seriesDir, slug);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (name === "hero.js" || name === "hero.css") yield join(dir, name);
      }
    }
  }
}

// They keep their names, so minifying is a pure size win. esbuild keeps
// top-level names in a script, so the window.Emjive* globals are untouched.
async function minifyCopiedFiles(distDir) {
  for (const file of distFilesToMinify(distDir)) {
    const out = await transformWithEsbuild(readFileSync(file, "utf8"), file, {
      minify: true,
      loader: file.endsWith(".css") ? "css" : "js",
      legalComments: "none"
    });
    writeFileSync(file, out.code);
  }
}

function copyFilesVitesBuildCantTrace() {
  return {
    name: "copy-files-vites-build-cant-trace",
    async closeBundle() {
      const skip = NEVER_COPY.concat(unusedHdris());
      for (const dir of ["assets", "data", "js", "series"]) {
        const src = resolve(__dirname, dir);
        if (existsSync(src)) {
          cpSync(src, resolve(__dirname, "dist", dir), {
            recursive: true,
            filter: (from) => !skip.includes(from) && !PRINT_MODEL.test(from)
          });
        }
      }
      await minifyCopiedFiles(resolve(__dirname, "dist"));
    }
  };
}

// Undoes two things Vite's HTML build does to every <head>:
// 1. It inlines the data/series.json preload as a data: URL, which can't
//    satisfy js/series.js's fetch; restore the path (check-dist guards it).
// 2. It moves the stylesheet after the blocking scripts, which rely on its
//    rules being parsed (scroll-memory.js, loader.js); move it back before
//    the first <script>.
function restoreHeadOrderAndPreload() {
  return {
    name: "restore-head-order-and-preload",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        html = html.replace(
          /(<link\b[^>]*\bhref=")data:application\/json;base64,[^"]*(")/g,
          "$1data/series.json$2"
        );

        const headEnd = html.indexOf("</head>");
        const head = html.slice(0, headEnd);
        // Comments blanked to the same length so tags mentioned in them aren't matched;
        // offsets stay valid in `head`.
        const bare = head.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
        const firstScript = bare.search(/<script\b/);
        if (firstScript === -1) return html;

        const sheetRe = /[ \t]*<link\b[^>]*\brel="stylesheet"[^>]*>[ \t]*\r?\n?/g;
        const sheets = [];
        const cuts = [];
        for (let m; (m = sheetRe.exec(bare)); ) {
          // Only those after the first script move.
          if (m.index > firstScript) {
            sheets.push(head.slice(m.index, m.index + m[0].length).trim());
            cuts.push([m.index, m.index + m[0].length]);
          }
        }
        if (!sheets.length) return html;

        let rest = head;
        for (const [from, to] of cuts.reverse()) rest = rest.slice(0, from) + rest.slice(to);
        // Cuts after firstScript don't shift it.
        return rest.slice(0, firstScript) + sheets.join("\n") + "\n" + rest.slice(firstScript) + html.slice(headEnd);
      }
    }
  };
}

// Preload hints, at build time from data/series.json, for requests the
// browser would otherwise discover several round trips deep. They name the
// featured series (other series just get unused preloads):
//   - its products.json, on pages with data-products="eager"
//   - the homepage hero bundle and its LCP image
// Not the three.js chunk, HDRI or model: not part of the first paint, and
// hinting them delayed the LCP image; js/product.js starts them later.
// crossorigin makes an as=fetch preload match a same-origin fetch().
function injectLoadHints() {
  return {
    name: "inject-load-hints",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Build only: the dev server has no bundle.
        if (!ctx || !ctx.bundle) return html;

        const htmlTag = /<html\b[^>]*>/.exec(html);
        if (!htmlTag) return html;
        const hasAttr = (name, value) =>
          new RegExp("\\bdata-" + name + "=\"" + value + "\"").test(htmlTag[0]);

        const index = readJson("data/series.json");
        const series = index.series.find((s) => s.slug === index.featured);
        if (!series) return html;

        const hints = [];
        const hint = (attrs) => hints.push("<link " + attrs + " />");

        if (hasAttr("products", "eager")) {
          hint('rel="preload" as="fetch" href="' + series.products + '" crossorigin');
        }
        if (html.includes('id="seriesHero"') && series.hero) {
          const hero = series.hero;
          if (hero.fragment) hint('rel="preload" as="fetch" href="' + hero.fragment + '" crossorigin');
          if (hero.css) hint('rel="preload" as="style" href="' + hero.css + '"');
          if (hero.js) hint('rel="preload" as="script" href="' + hero.js + '"');
          if (hero.preload && hero.preload[0]) {
            // The LCP picture's low-res variant for each side of the phone query; the
            // browser takes the matching one (js/loader.js "responsive images").
            const first = hero.preload[0];
            const low = (suffix) => first.replace(/(.[A-Za-z0-9]+)$/, "_" + suffix + "$1");
            hint('rel="preload" as="image" href="' + low("m_lo") + '" media="' + PHONE_QUERY + '" fetchpriority="high"');
            hint('rel="preload" as="image" href="' + low("lo") + '" media="not all and ' + PHONE_QUERY + '" fetchpriority="high"');
          }
        }
        if (!hints.length) return html;

        // Before the stylesheet, where the preload scanner meets them first.
        const block = hints.join("\n") + "\n";
        const sheet = /[ \t]*<link\b[^>]*\brel="stylesheet"/.exec(html);
        if (sheet) return html.slice(0, sheet.index) + block + html.slice(sheet.index);
        const headEnd = html.indexOf("</head>");
        return html.slice(0, headEnd) + block + html.slice(headEnd);
      }
    }
  };
}

// Every product with its series, from the site's own data; the address is
// /<slug> (scripts/slugs.js).
function readProducts() {
  const index = readJson("data/series.json");
  const list = [];
  for (const series of index.series) {
    for (const product of readJson(series.products).products) {
      list.push({ product, series, slug: slugify(product.name), featured: series.slug === index.featured });
    }
  }
  return { index, list };
}

// The gallery and every item. The noindex pages are left out.
function emitSitemap() {
  return {
    name: "emit-sitemap",
    generateBundle() {
      const urls = [SITE_ORIGIN + "/gallery"];
      for (const item of readProducts().list) urls.push(SITE_ORIGIN + "/" + item.slug);
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.map((url) => "  <url><loc>" + url.replace(/&/g, "&amp;") + "</loc></url>").join("\n") +
        "\n</urlset>\n";
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: xml });
    }
  };
}

// Link-preview images (og:image, twitter:image): 1200x630 JPEG (not every
// crawler reads WebP) on --bg read from css/style.css. dist/preview.jpg is the
// compact logo; each item gets its steel wheel-poster at
// dist/assets/previews/<slug>.jpg.
const PREVIEW_SIZE = { width: 1200, height: 630 };
const PREVIEW_LOGO_SIZE = 420;

function pageBackground() {
  const css = readFileSync(resolve(__dirname, "css/style.css"), "utf8");
  const match = css.match(/--bg:\s*(#[0-9a-fA-F]{6})\b/);
  if (!match) throw new Error("previews: no --bg colour in css/style.css");
  return match[1];
}

// `layer`: the picture centred on the card.
function previewCard(background, layer) {
  return sharp({ create: { ...PREVIEW_SIZE, channels: 3, background } })
    .composite([{ input: layer, gravity: "centre" }])
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

const escapeAttr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The item as schema.org Product data, for search results: its offers are the
// price span over metals and sizes (priceSpan), left out while it's TBD.
function productStructuredData(product, url, image) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || undefined,
    url,
    image,
    category: product.category,
    brand: { "@type": "Brand", name: "em·ji·ve" }
  };
  const span = priceSpan(product);
  if (span) data.offers = { "@type": "AggregateOffer", priceCurrency: "EUR", lowPrice: span.low, highPrice: span.high, url };
  // "<" escaped, so no text in the data can close the <script>.
  return '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, "\\u003c") + "</script>";
}

const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// One real page per item, dist/<slug>.html: the built product.html with the
// item's own title, description, canonical and social tags, its name and
// description in the markup, and its structured data, so link previews and
// non-JS crawlers see the item. js/product.js still finds the product from
// the address. product.html stays as the template and the landing for
// legacy ?id= links. After the bundle is written (closeBundle); every
// rewritten tag must exist in the template, or the build throws.
function emitItemPages() {
  let isBuild = false;
  return {
    name: "emit-item-pages",
    apply: "build",
    configResolved(config) { isBuild = config.command === "build"; },
    async closeBundle() {
      if (!isBuild) return;
      const distDir = resolve(__dirname, "dist");
      const templatePath = join(distDir, "product.html");
      if (!existsSync(templatePath)) throw new Error("emit-item-pages: dist/product.html is missing");
      const template = readFileSync(templatePath, "utf8");
      const { index, list } = readProducts();
      const featured = index.series.find((s) => s.slug === index.featured);

      const swap = (html, pattern, replacement, what) => {
        if (!pattern.test(html)) throw new Error("emit-item-pages: product.html has no " + what + " to rewrite");
        return html.replace(pattern, () => replacement);
      };

      // The default card, and the items' folder.
      const background = pageBackground();
      const logo = await sharp(resolve(__dirname, "assets/logo_compact.svg"), { density: 400 }).resize({ width: PREVIEW_LOGO_SIZE }).png().toBuffer();
      writeFileSync(join(distDir, "preview.jpg"), await previewCard(background, logo));
      mkdirSync(join(distDir, "assets/previews"), { recursive: true });

      for (const { product, series, slug } of list) {
        const name = product.name || "Product";
        const title = "em\u00b7ji\u00b7ve: " + name.toLowerCase();
        const description = product.description || "Item detail";
        const url = SITE_ORIGIN + "/" + slug;
        const metal = "steel";
        const poster = product.assets && product.assets["wheel-poster"] && product.assets["wheel-poster"][metal];

        let html = template;
        html = swap(html, /<title>[^<]*<\/title>/, "<title>" + escapeAttr(title) + "</title>", "<title>");
        html = swap(html, /<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="' + escapeAttr(description) + '" />\n<link rel="canonical" href="' + url + '" />', "meta description");
        html = swap(html, /<meta property="og:title" content="[^"]*" \/>/, '<meta property="og:title" content="' + escapeAttr(title) + '" />', "og:title");
        html = swap(html, /<meta property="og:description" content="[^"]*" \/>/, '<meta property="og:description" content="' + escapeAttr(description) + '" />', "og:description");
        html = swap(html, /<meta property="og:url" content="[^"]*" \/>/, '<meta property="og:url" content="' + url + '" />', "og:url");
        html = swap(html, /<meta name="twitter:title" content="[^"]*" \/>/, '<meta name="twitter:title" content="' + escapeAttr(title) + '" />', "twitter:title");
        html = swap(html, /<meta name="twitter:description" content="[^"]*" \/>/, '<meta name="twitter:description" content="' + escapeAttr(description) + '" />', "twitter:description");
        if (poster) {
          // The poster fills the card's height, keeping its own margin.
          const picture = await sharp(resolve(__dirname, poster)).resize({ height: PREVIEW_SIZE.height }).png().toBuffer();
          writeFileSync(join(distDir, "assets/previews", slug + ".jpg"), await previewCard(background, picture));
          const image = SITE_ORIGIN + "/assets/previews/" + slug + ".jpg";
          html = swap(html, /<meta property="og:image" content="[^"]*" \/>/, '<meta property="og:image" content="' + image + '" />', "og:image");
          html = swap(html, /<meta property="og:image:width" content="[^"]*" \/>/, '<meta property="og:image:width" content="' + PREVIEW_SIZE.width + '" />', "og:image:width");
          html = swap(html, /<meta property="og:image:height" content="[^"]*" \/>/, '<meta property="og:image:height" content="' + PREVIEW_SIZE.height + '" />', "og:image:height");
          html = swap(html, /<meta property="og:image:alt" content="[^"]*" \/>/, '<meta property="og:image:alt" content="' + escapeAttr(name + (product.category ? " " + product.category : "") + " in " + metal) + '" />', "og:image:alt");
          html = swap(html, /<meta name="twitter:image" content="[^"]*" \/>/, '<meta name="twitter:image" content="' + image + '" />', "twitter:image");
        }
        // The products.json hint names the featured series; another series' item needs its own.
        if (featured && series.slug !== featured.slug) {
          html = html.split('href="' + featured.products + '"').join('href="' + series.products + '"');
        }
        // The name and description js/product.js would write, already in the markup.
        html = swap(html, /<span class="product-detail__label-name" id="productLabelName"><\/span>/, '<span class="product-detail__label-name" id="productLabelName">' + escapeText(name) + "</span>", "#productLabelName");
        if (product.description) {
          html = swap(html, /<p class="product-detail__description" id="productDescription" hidden><\/p>/, '<p class="product-detail__description" id="productDescription">' + escapeText(product.description) + "</p>", "#productDescription");
        }
        // At the body's end: check-dist wants js/helpers.js as the first classic <script>.
        const previewImage = poster ? SITE_ORIGIN + "/assets/previews/" + slug + ".jpg" : SITE_ORIGIN + "/preview.jpg";
        html = swap(html, /<\/body>/, productStructuredData(product, url, previewImage) + "\n</body>", "</body>");
        writeFileSync(join(distDir, slug + ".html"), html);
      }
    }
  };
}

// What public/.htaccess does, for dev and preview: /gallery, /<page>, and
// /<slug> (its own page in preview, the shared product.html in dev). Only
// extension-less single-segment paths. Keep in step with .htaccess.
function cleanUrls() {
  const rewrite = (root, isPreview) => (req, res, next) => {
    const url = req.url || "";
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    const rest = q === -1 ? "" : url.slice(q);
    let name = "";
    try { name = decodeURIComponent(path).replace(/^\/+/, "").toLowerCase(); } catch (e) { return next(); }
    if (!name || name.includes("/") || name.includes(".")) return next();

    if (name === "gallery") req.url = "/index.html" + rest;
    else if (existsSync(join(root, name + ".html"))) req.url = "/" + name + ".html" + rest;
    else if (!isPreview && readProducts().list.some((item) => item.slug === name)) req.url = "/product.html" + rest;
    next();
  };
  return {
    name: "clean-urls",
    configureServer(server) { server.middlewares.use(rewrite(__dirname, false)); },
    configurePreviewServer(server) { server.middlewares.use(rewrite(resolve(__dirname, "dist"), true)); }
  };
}

// three's DRACOLoader references its bundled decoder via new URL(...,
// import.meta.url), so Vite emits decoder files the site never
// requests: js/three-viewer.js points setDecoderPath at assets/draco/. Dropped
// from the bundle; if that decoder path ever goes, this must go too.
function dropUnusedDracoDecoderCopies() {
  return {
    name: "drop-unused-draco-decoder-copies",
    generateBundle(options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/draco_(decoder|wasm_wrapper)/.test(fileName)) delete bundle[fileName];
      }
    }
  };
}

export default defineConfig({
  // Served from the domain root.
  base: "/",
  // Module workers (js/hdr-worker.js) need ES format, not the default IIFE.
  worker: { format: "es" },
  plugins: [
    dropUnusedDracoDecoderCopies(),
    restoreHeadOrderAndPreload(),
    injectLoadHints(),
    emitSitemap(),
    cleanUrls(),
    copyFilesVitesBuildCantTrace(),
    emitItemPages()
  ],
  build: {
    // Just above the lazy three.js chunk, so the warning
    // still flags any other chunk growing that large.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // Every page must be an entry, or its module scripts ship unprocessed with
      // bare imports. Add new pages here.
      input: {
        main: resolve(__dirname, "index.html"),
        product: resolve(__dirname, "product.html"),
        launchOrder: resolve(__dirname, "launch-order.html"),
        archives: resolve(__dirname, "archives.html"),
        creationProcess: resolve(__dirname, "creation-process.html"),
        series: resolve(__dirname, "series.html"),
        terms: resolve(__dirname, "terms.html"),
        // The ErrorDocument; an entry so Vite makes its references absolute.
        notFound: resolve(__dirname, "404.html")
      }
    }
  }
});
