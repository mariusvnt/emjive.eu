// Vite config: a multi-page build made deployable on a plain static host. Adds
// the verbatim copy of what the build can't trace, the <head> fixes, load hints,
// the sitemap, one page per study, one page, link preview and structured data
// per item, clean URLs in dev and preview, and the dropped decoder copies.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, transformWithEsbuild } from "vite";
import sharp from "sharp";
import { slugify } from "./scripts/slugs.js";
import { SITE_ORIGIN, PHONE_QUERY, readJson, priceSpan } from "./scripts/helpers.js";

// Vite only ships what it can trace, and most of this site's assets are named
// in runtime data (products.json, studies.json, hero bundles), while classic
// <script>s aren't bundled or copied at all. So assets/, data/, js/ and
// studies/ are copied verbatim after the build (closeBundle), minus:
//   assets/hdri/ unused      the HDRIs no study uses (unusedHdris)
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

// data/studies.json "hdris" also lists the tools' alternatives: only the ones
// a study uses ship.
function unusedHdris() {
  const index = readJson("data/studies.json");
  const used = new Set(index.studies.map((s) => index.hdris[s.hdri]).filter(Boolean));
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
  const studiesDir = join(distDir, "studies");
  if (existsSync(studiesDir)) {
    for (const slug of readdirSync(studiesDir)) {
      const dir = join(studiesDir, slug);
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
      for (const dir of ["assets", "data", "js", "studies"]) {
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

// Undoes two things Vite's HTML build does to every <head>, in the build only
// (in dev the first script is Vite's own client, and moving the stylesheet
// above it would also lift it over the item page's <base>):
// 1. It inlines the data/studies.json preload as a data: URL, which can't
//    satisfy js/studies.js's fetch; restore the path (check-dist guards it).
// 2. It moves the stylesheet after the blocking scripts, which rely on its
//    rules being parsed (scroll-memory.js, loader.js); move it back before
//    the first <script>.
function restoreHeadOrderAndPreload() {
  return {
    name: "restore-head-order-and-preload",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx || !ctx.bundle) return html;
        html = html.replace(
          /(<link\b[^>]*\bhref=")data:application\/json;base64,[^"]*(")/g,
          "$1data/studies.json$2"
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

// Preload hints, at build time from data/studies.json, for requests the
// browser would otherwise discover several round trips deep. They name the
// featured study (each study page swaps in its own, emitStudyPages; an item
// page its products.json, emitItemPages):
//   - its products.json, on pages with data-products="eager"
//   - the gallery's hero bundle and its LCP image
// Not the three.js chunk, HDRI or model: not part of the first paint, and
// hinting them delayed the LCP image; js/product.js starts them later.
// crossorigin makes an as=fetch preload match a same-origin fetch().
function loadHints(study, kinds) {
  const hints = [];
  const hint = (attrs) => hints.push("<link " + attrs + " />");
  if (kinds.products) hint('rel="preload" as="fetch" href="' + study.products + '" crossorigin');
  if (kinds.hero && study.hero) {
    const hero = study.hero;
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
  return hints.length ? hints.join("\n") + "\n" : "";
}

// Which hints a page takes, from its markup.
function hintKinds(html) {
  const htmlTag = /<html\b[^>]*>/.exec(html);
  return {
    products: !!htmlTag && /\bdata-products="eager"/.test(htmlTag[0]),
    hero: html.includes('id="studyHero"')
  };
}

function injectLoadHints() {
  return {
    name: "inject-load-hints",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Build only: the dev server has no bundle.
        if (!ctx || !ctx.bundle) return html;
        const index = readJson("data/studies.json");
        const study = index.studies.find((s) => s.slug === index.featured);
        if (!study) return html;
        const block = loadHints(study, hintKinds(html));
        if (!block) return html;

        // Before the stylesheet, where the preload scanner meets them first.
        const sheet = /[ \t]*<link\b[^>]*\brel="stylesheet"/.exec(html);
        if (sheet) return html.slice(0, sheet.index) + block + html.slice(sheet.index);
        const headEnd = html.indexOf("</head>");
        return html.slice(0, headEnd) + block + html.slice(headEnd);
      }
    }
  };
}

// Every product with its study, from the site's own data; the address is
// /<study>/<slug> (scripts/slugs.js), `path` without the leading slash.
function readProducts() {
  const index = readJson("data/studies.json");
  const list = [];
  for (const study of index.studies) {
    for (const product of readJson(study.products).products) {
      const slug = slugify(product.name);
      list.push({ product, study, slug, path: study.slug + "/" + slug, featured: study.slug === index.featured });
    }
  }
  return { index, list };
}

// A study's gallery: / for the featured one, /<slug> for the others.
const studyUrl = (study, index) => SITE_ORIGIN + "/" + (study.slug === index.featured ? "" : study.slug);

// The galleries, the archives and every item. The noindex pages are left out.
function emitSitemap() {
  return {
    name: "emit-sitemap",
    generateBundle() {
      const { index, list } = readProducts();
      const urls = index.studies.map((study) => studyUrl(study, index)).concat(SITE_ORIGIN + "/archives");
      for (const item of list) urls.push(SITE_ORIGIN + "/" + item.path);
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
const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// The business, for search engines (site name, logo, contact, profiles).
const BRAND = {
  name: "em·ji·ve",
  alternateName: "emjive",
  email: "contact@emjive.eu",
  sameAs: ["https://www.instagram.com/em.ji.ve/"]
};
// dist/logo.png, the Organization's logo: square, as Google's logo guidelines ask.
const LOGO_SIZE = 512;
const LOGO_MARK_SIZE = 384;

// "<" escaped, so no text in the data can close the <script>.
const structuredData = (data) => '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, "\\u003c") + "</script>";

// The item as schema.org Product data, for search results: its offers are the
// price span over metals, designs and sizes (priceSpan), left out while it's TBD.
function productStructuredData(product, index, url, image) {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || undefined,
    url,
    image,
    category: product.category,
    brand: { "@type": "Brand", name: BRAND.name }
  };
  const span = priceSpan(product, index);
  if (span) data.offers = { "@type": "AggregateOffer", priceCurrency: "EUR", lowPrice: span.low, highPrice: span.high, url };
  return structuredData(data);
}

// The site and its business as schema.org data, on the home page. Its url is
// the domain root, where Google looks for the site name.
function siteStructuredData() {
  const home = SITE_ORIGIN + "/";
  return structuredData({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": home + "#organization",
        name: BRAND.name,
        alternateName: BRAND.alternateName,
        url: home,
        logo: SITE_ORIGIN + "/logo.png",
        email: BRAND.email,
        sameAs: BRAND.sameAs
      },
      {
        "@type": "WebSite",
        "@id": home + "#website",
        name: BRAND.name,
        alternateName: BRAND.alternateName,
        url: home,
        publisher: { "@id": home + "#organization" }
      }
    ]
  });
}

// A grid item as js/gallery.js buildItem() first draws it (no metal picked,
// the model's picture only), with the name as a link: keep the two in step.
function galleryItemMarkup(product, index, path) {
  const name = product.name || "";
  const metal = product["default-metal"];
  const assets = product.assets || {};
  const pick = (kind) => (assets[kind] && assets[kind][metal]) || "";
  const picture = (assets.model && pick("fallback-img")) || pick("icons");
  const span = priceSpan(product, index, metal);
  const metals = index.metals || [];
  const option = (m) => '<div class="grid-item__option' + (m === metal ? " is-active" : "") + '">' +
    '<button class="grid-item__swatch" type="button" aria-label="' + m + '" aria-pressed="' + (m === metal) + '">' +
    '<span class="product-dial__swatch" data-metal="' + m + '"></span></button>' +
    '<span class="grid-item__metal" aria-hidden="true"><span>' + m + "</span></span></div>";
  const picker = metals.length < 2 ? "" :
    '<div class="grid-item__material"><div class="grid-item__swatches" role="group" aria-label="' + escapeAttr(name) + ' material">' +
    metals.map(option).join("") + '<span class="grid-item__label" aria-hidden="true">' + metal + "</span></div></div>";
  const price = !span ? "TBD" : span.low === span.high ? span.high + " €" : span.low + " – " + span.high + " €";
  const range = product["size-range"];
  const fact = (key, label, shown, value) =>
    '<div class="grid-item__fact grid-item__fact--' + key + '"><dt' + (shown ? "" : ' class="visually-hidden"') + ">" + label + "</dt><dd>" + value + "</dd></div>";
  return '<article class="grid-item">' +
    (picture
      ? '<div class="grid-item__frame"><div class="grid-item__deck"><img class="grid-item__card grid-item__card--model" src="/' + escapeAttr(picture) + '" alt="' +
        escapeAttr(name + (product.category ? " " + product.category : "") + " in " + metal) + '" width="512" height="512" loading="lazy" decoding="async" /></div></div>'
      : "") +
    picker +
    '<dl class="grid-item__facts">' +
    fact("name", "Id", false, '<a class="grid-item__name" href="/' + path + '">' + escapeText(name) + "</a>") +
    fact("category", "Category", false, escapeText((product.category || "").toLowerCase())) +
    (range ? fact("size", "size", true, range.min + " – " + range.max) : "") +
    fact("price", "Price", false, price) +
    "</dl></article>";
}

// The galleries' static content, so crawlers that don't run their scripts
// still see the items: a study's grid written into #productGrid (js/gallery.js
// replaces it with the live one). index.html is the featured study's, with the
// site's structured data and its logo. dist/<slug>.html serves each study's
// own address: the featured one's is a copy of index.html (canonical /), the
// others' have their own title, canonical, load hints and grid. Build only;
// after the bundle is written (closeBundle).
function emitStudyPages() {
  let isBuild = false;
  return {
    name: "emit-study-pages",
    apply: "build",
    configResolved(config) { isBuild = config.command === "build"; },
    async closeBundle() {
      if (!isBuild) return;
      const distDir = resolve(__dirname, "dist");
      const pagePath = join(distDir, "index.html");
      const base = readFileSync(pagePath, "utf8");
      const { index, list } = readProducts();
      const featured = index.studies.find((s) => s.slug === index.featured);

      const swap = (html, pattern, replacement, what) => {
        if (!pattern.test(html)) throw new Error("emit-study-pages: index.html has no " + what + " to rewrite");
        return html.replace(pattern, () => replacement);
      };
      const grid = /(<div class="product-grid" id="productGrid">)[\s\S]*?(<\/div>)/;
      if (!grid.test(base)) throw new Error("emit-study-pages: index.html has no #productGrid");
      if (!base.includes("</body>")) throw new Error("emit-study-pages: index.html has no </body>");
      const withGrid = (html, study) => {
        const items = list.filter((item) => item.study.slug === study.slug).map((item) => galleryItemMarkup(item.product, index, item.path));
        return html.replace(grid, (all, open, close) => open + "\n" + items.join("\n") + "\n" + close);
      };

      const home = withGrid(base, featured).replace("</body>", () => siteStructuredData() + "\n</body>");
      writeFileSync(pagePath, home);

      const kinds = hintKinds(base);
      const featuredHints = loadHints(featured, kinds);
      for (const study of index.studies) {
        if (study.slug === featured.slug) {
          writeFileSync(join(distDir, study.slug + ".html"), home);
          continue;
        }
        const url = studyUrl(study, index);
        const title = "em·ji·ve: " + study.name.toLowerCase() + " study";
        let html = withGrid(base, study);
        html = swap(html, /<title>[^<]*<\/title>/, "<title>" + escapeAttr(title) + "</title>", "<title>");
        html = swap(html, /<link rel="canonical" href="[^"]*" \/>/, '<link rel="canonical" href="' + url + '" />', "canonical");
        html = swap(html, /<meta property="og:title" content="[^"]*" \/>/, '<meta property="og:title" content="' + escapeAttr(title) + '" />', "og:title");
        html = swap(html, /<meta property="og:url" content="[^"]*" \/>/, '<meta property="og:url" content="' + url + '" />', "og:url");
        html = swap(html, /<meta name="twitter:title" content="[^"]*" \/>/, '<meta name="twitter:title" content="' + escapeAttr(title) + '" />', "twitter:title");
        if (featuredHints) {
          if (!html.includes(featuredHints)) throw new Error("emit-study-pages: index.html's load hints are not the featured study's");
          html = html.replace(featuredHints, () => loadHints(study, kinds));
        }
        // The header's featured-study link is not this page.
        html = html.replace(/(<a\b[^>]*\bdata-featured-study\b[^>]*?) aria-current="page"/g, "$1");
        writeFileSync(join(distDir, study.slug + ".html"), html);
      }

      const mark = await sharp(resolve(__dirname, "assets/logo_compact.svg"), { density: 400 }).resize({ width: LOGO_MARK_SIZE, height: LOGO_MARK_SIZE, fit: "inside" }).png().toBuffer();
      const logo = await sharp({ create: { width: LOGO_SIZE, height: LOGO_SIZE, channels: 3, background: pageBackground() } })
        .composite([{ input: mark, gravity: "centre" }])
        .png()
        .toBuffer();
      writeFileSync(join(distDir, "logo.png"), logo);
    }
  };
}

// One real page per item, dist/<study>/<slug>.html: the built product.html with the
// item's own title, description, canonical and social tags, its name and
// description in the markup, and its structured data, so link previews and
// non-JS crawlers see the item. js/product.js still finds the product from
// the address. The built product.html is only the template and is deleted
// afterwards, so /product.html and /product are 404s. After the bundle is
// written (closeBundle); every rewritten tag must exist in the template, or
// the build throws.
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
      const featured = index.studies.find((s) => s.slug === index.featured);

      const swap = (html, pattern, replacement, what) => {
        if (!pattern.test(html)) throw new Error("emit-item-pages: product.html has no " + what + " to rewrite");
        return html.replace(pattern, () => replacement);
      };

      // The default card, and the items' folder.
      const background = pageBackground();
      const logo = await sharp(resolve(__dirname, "assets/logo_compact.svg"), { density: 400 }).resize({ width: PREVIEW_LOGO_SIZE }).png().toBuffer();
      writeFileSync(join(distDir, "preview.jpg"), await previewCard(background, logo));
      mkdirSync(join(distDir, "assets/previews"), { recursive: true });

      for (const { product, study, slug, path } of list) {
        const name = product.name || "Product";
        const title = "em\u00b7ji\u00b7ve: " + name.toLowerCase();
        const description = product.description || "Item detail";
        const url = SITE_ORIGIN + "/" + path;
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
        // The products.json hint names the featured study; another study's item needs its own.
        if (featured && study.slug !== featured.slug) {
          html = html.split('href="' + featured.products + '"').join('href="' + study.products + '"');
        }
        // The name and description js/product.js would write, already in the markup.
        html = swap(html, /<span class="product-detail__label-name" id="productLabelName"><\/span>/, '<span class="product-detail__label-name" id="productLabelName">' + escapeText(name) + "</span>", "#productLabelName");
        if (product.description) {
          html = swap(html, /<p class="product-detail__description" id="productDescription" hidden><\/p>/, '<p class="product-detail__description" id="productDescription">' + escapeText(product.description) + "</p>", "#productDescription");
        }
        // At the body's end: check-dist wants js/helpers.js as the first classic <script>.
        const previewImage = poster ? SITE_ORIGIN + "/assets/previews/" + slug + ".jpg" : SITE_ORIGIN + "/preview.jpg";
        html = swap(html, /<\/body>/, productStructuredData(product, index, url, previewImage) + "\n</body>", "</body>");
        mkdirSync(join(distDir, study.slug), { recursive: true });
        writeFileSync(join(distDir, path + ".html"), html);
      }
      unlinkSync(templatePath);
    }
  };
}

// What public/.htaccess does, for dev and preview: /index redirected to /,
// then /<page>, /<study> and /<study>/<slug> served (their own pages in
// preview; in dev index.html and the shared product.html, where /product
// itself is left to 404 as in production). Only extension-less paths. Keep
// in step with .htaccess.
function cleanUrls() {
  const rewrite = (root, isPreview) => (req, res, next) => {
    const url = req.url || "";
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    const rest = q === -1 ? "" : url.slice(q);
    let name = "";
    try { name = decodeURIComponent(path).replace(/^\/+/, "").toLowerCase(); } catch (e) { return next(); }
    if (!name || name === "product" || name.includes(".")) return next();

    if (name === "index") {
      res.writeHead(301, { Location: "/" + rest });
      res.end();
      return;
    }
    const segments = name.split("/");
    if (segments.length > 2 || segments.some((s) => !s)) return next();
    if (existsSync(join(root, name + ".html"))) {
      req.url = "/" + name + ".html" + rest;
      return next();
    }
    if (isPreview) return next();
    const { index, list } = readProducts();
    if (segments.length === 1 && index.studies.some((s) => s.slug === name)) req.url = "/index.html" + rest;
    else if (segments.length === 2 && list.some((item) => item.path === name)) req.url = "/product.html" + rest;
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
    emitItemPages(),
    emitStudyPages()
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
        whoAreWe: resolve(__dirname, "who-are-we.html"),
        intent: resolve(__dirname, "intent.html"),
        printing: resolve(__dirname, "3d-printing.html"),
        environment: resolve(__dirname, "environment.html"),
        studies: resolve(__dirname, "studies.html"),
        terms: resolve(__dirname, "terms.html"),
        legalNotice: resolve(__dirname, "legal-notice.html"),
        privacy: resolve(__dirname, "privacy.html"),
        // The ErrorDocument; an entry so Vite makes its references absolute.
        notFound: resolve(__dirname, "404.html")
      }
    }
  }
});
