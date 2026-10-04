import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, transformWithEsbuild } from "vite";
import { slugify } from "./scripts/slugs.js";

// The public origin, for the generated sitemap.xml. Same host as every page's
// og:url / canonical.
const SITE_ORIGIN = "https://emjive.eu";

// What a "smartphone" is for the responsive images: the same query as
// PHONE_QUERY in js/loader.js and the phone rules in css/style.css and
// series/<slug>/hero.css. Keep the four in step.
const PHONE_QUERY = "(max-width: 640px) and (max-aspect-ratio: 3/5)";

// Vite's static asset pipeline only ever sees paths it can trace at build
// time: <script>/<link>/<img> attributes in the HTML entries themselves,
// and url()/import references inside processed CSS/JS. This site's real
// asset paths mostly come from a series' products.json (icons/top-shot/model
// paths, fetched and read as plain string data at runtime) or from a bare
// string constant in js/three-viewer.js (HDRI_SRC) — none of that is
// something Vite's build can see, so those folders would silently be left
// out of dist/ entirely without this. js/ needs the same treatment for a
// different reason: Vite can only bundle <script type="module"> tags
// (three-viewer.js) — a plain classic <script src="js/main.js"> can't be
// bundled, and Vite doesn't copy what it can't bundle either, so without
// this every classic script (main.js, product.js, selection*.js) would
// silently vanish from the build even though the built HTML still
// references them (confirmed by inspecting dist/ directly — worth
// re-checking after any future Vite upgrade in case this behavior
// changes). Copying all three verbatim (byte-for-byte, original
// filenames) after the real build sidesteps having to trace every
// dynamic/classic-script reference individually — a bit of redundant
// output for whatever Vite's own pipeline *did* catch (e.g. CSS url()s,
// the header's static <img> tags, three-viewer.js's own module bundle),
// but that's harmless.
//
// series/ is on the list for the same reason as data/: it holds each
// series' hero bundle (hero.html/hero.css/hero.js), which is referenced
// only as string paths inside data/series.json and injected at runtime, so
// Vite's build has no way to see it. That's also why a hero bundle's JS can
// never use a bare specifier — nothing resolves it.
// Copying whole trees is the right default (see above) but it is not free:
// each of these was verified to ship in dist/ and never be requested by any
// built page. Together they were ~2MB of the output.
//
//   assets/fonts/  — Vite DOES trace the @font-face url()s in css/style.css
//     and the <link rel="preload"> hrefs in every page's <head>, so it emits
//     its own content-hashed copies (dist/assets/DINish-Regular-<hash>.woff2
//     et al) and rewrites both references to point at them. Nothing in the
//     built output mentions assets/fonts/ at all — and only 5 of the 45
//     files in there were ever referenced to begin with. Re-check this if a
//     font is ever loaded from a runtime string rather than from CSS.
//   assets/hand_normal.webp — genuinely dead, in the repo and in the build
//     (see assets.md); it's the plain hand the ring-embossed hero replaced.
//   js/viewer-entry.js — a module entry (<script type="module">), so Vite
//     bundles it and the built pages load the hashed copy; the verbatim one
//     has a relative dynamic import() that would resolve to the unbundled
//     three-viewer.js, which can't run.
//   js/hdr-worker.js — the HDR decode worker (new Worker(new URL(...)) in
//     js/three-viewer.js). Vite bundles it into dist/assets/hdr-worker-<hash>.js
//     and rewrites the reference; the verbatim copy still has the bare
//     `three` import nothing at runtime can resolve.
//   js/three-viewer.js — the unbundled ES module source. The built pages
//     load Vite's bundled copy (dist/assets/three-viewer-<hash>.js); this
//     one still carries the bare `import "three"` specifier that nothing at
//     runtime can resolve, so shipping it is at best dead weight and at
//     worst a trap for anyone who finds it in dist/ and assumes it runs.
//     Every OTHER file in js/ is a classic script the built HTML really
//     does load by its original path, which is why this is one exclusion
//     rather than a rule about js/.
//
//   assets/logo*.svg, hand-pointer-thumb-opened.svg, metal-sample_*.webp —
//     referenced only from HTML <img>/<link> and css/style.css url(), all of
//     which Vite DOES trace, so it emits its own content-hashed copies and
//     rewrites every reference. The verbatim copies this plugin used to add
//     beside them (byte-identical, md5 checked) were never requested.
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
  resolve(__dirname, "js", "hdr-worker.js")
];

// Every classic script and hero bundle file that reaches dist/ by verbatim
// copy rather than through Vite's pipeline: js/*.js, series/<slug>/hero.js
// and hero.css. Walks dist/, not the sources, so it only ever touches what
// was really copied (and never the already-minified Vite bundle in
// dist/assets/).
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

// These files keep their names (nothing in the HTML or in data/series.json
// is rewritten), so minifying is a pure size win: ~306KB of classic scripts
// and ~9KB of hero CSS, no sourcemaps. esbuild's transform keeps top-level
// names in a plain script (it only renames inside nested scopes), so the
// window.Emjive* globals and the load-order contract between the scripts are
// untouched.
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
      for (const dir of ["assets", "data", "js", "series"]) {
        const src = resolve(__dirname, dir);
        if (existsSync(src)) {
          cpSync(src, resolve(__dirname, "dist", dir), {
            recursive: true,
            filter: (from) => !NEVER_COPY.includes(from)
          });
        }
      }
      await minifyCopiedFiles(resolve(__dirname, "dist"));
    }
  };
}

// Two things Vite's HTML build does to every page's <head> that undo choices
// documented in the page sources (both confirmed by reading dist/*.html):
//
// 1. <link rel="preload" as="fetch" href="data/series.json"> — Vite treats
//    the href as an asset reference, and data/series.json is under its inline
//    limit, so the built tag becomes href="data:application/json;base64,…".
//    A data: URL can never satisfy the real fetch("data/series.json") in
//    js/series.js, so the early request the preload exists for never
//    happens, and every page also carries a stale base64 copy of the JSON.
//    Put the real path back. (series.json is the only JSON any page
//    preloads; scripts/check-dist.js fails the build if a data: preload ever
//    reappears.)
//
// 2. The stylesheet — the source <link rel="stylesheet" href="css/style.css">
//    sits ahead of the blocking scripts on purpose (scroll-memory.js adds
//    .emjive-restoring-scroll, loader.js shows the loader cover — both rely
//    on the rules in that file already being parsed), but Vite re-emits the
//    CSS as a link injected AFTER the scripts. Move every stylesheet link in
//    <head> back in front of the first <script>.
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
        // Same-length copy with every comment blanked out, so a "<script>" or
        // a <link> mentioned inside one of the pages' long explanatory
        // comments is never mistaken for a real tag. Offsets found in the
        // copy are valid in `head`.
        const bare = head.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
        const firstScript = bare.search(/<script\b/);
        if (firstScript === -1) return html;

        const sheetRe = /[ \t]*<link\b[^>]*\brel="stylesheet"[^>]*>[ \t]*\r?\n?/g;
        const sheets = [];
        const cuts = [];
        for (let m; (m = sheetRe.exec(bare)); ) {
          // Only the ones currently AFTER the first script need moving.
          if (m.index > firstScript) {
            sheets.push(head.slice(m.index, m.index + m[0].length).trim());
            cuts.push([m.index, m.index + m[0].length]);
          }
        }
        if (!sheets.length) return html;

        let rest = head;
        for (const [from, to] of cuts.reverse()) rest = rest.slice(0, from) + rest.slice(to);
        // Removing text after firstScript doesn't shift it.
        return rest.slice(0, firstScript) + sheets.join("\n") + "\n" + rest.slice(firstScript) + html.slice(headEnd);
      }
    }
  };
}

// Early-discovery hints for things the browser can only learn about by running
// code, and that sit several round trips deep in the page's load chain. All of
// them are derived here, at build time, from the same data/series.json the
// pages read at runtime, so they can never drift from the catalog — and they
// name the FEATURED series, which is what every page shows unless the URL says
// ?series=. (A visitor on another series just gets a few unused preloads.)
//
//   - data/series/<featured>/products.json, on pages with data-products="eager"
//     (js/series.js also starts that request itself once the index resolves;
//     this is the same request, a hop earlier).
//   - the homepage hero bundle (fragment, css, js, and the first image in
//     hero.preload, which is the LCP image), all of which js/series.js can
//     only request after data/series.json has come back.
//
// Deliberately NOT here: the three.js chunk, the HDRI and the model on
// product.html. They are the heaviest things on the page (~165KB + 0.9MB +
// the .glb) and none of them is part of the first paint, so hinting them from
// the <head> only made them share a slow link with the images the page is
// actually waiting on (measured: it pushed the LCP image later). js/product.js
// starts all three itself once those images are in.
//
// `crossorigin` on a preload as=fetch is what makes it match a same-origin
// fetch() — the same reason the series.json preload carries it.
function injectLoadHints() {
  return {
    name: "inject-load-hints",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // Build only: the dev server has no bundle, and serves everything
        // unhashed anyway.
        if (!ctx || !ctx.bundle) return html;

        const htmlTag = /<html\b[^>]*>/.exec(html);
        if (!htmlTag) return html;
        const hasAttr = (name, value) =>
          new RegExp("\\bdata-" + name + "=\"" + value + "\"").test(htmlTag[0]);

        const index = JSON.parse(readFileSync(resolve(__dirname, "data/series.json"), "utf8"));
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
            // The first picture exists in four versions (see "responsive
            // images" in js/loader.js): the low-res one for this viewport is
            // what the first paint is made of, so that is what is preloaded —
            // one link per side of the phone query, the browser takes the one
            // whose media matches. (js/series.js repeats this for a page whose
            // featured series is not this one.)
            const first = hero.preload[0];
            const low = (suffix) => first.replace(/(.[A-Za-z0-9]+)$/, "_" + suffix + "$1");
            hint('rel="preload" as="image" href="' + low("m_lo") + '" media="' + PHONE_QUERY + '" fetchpriority="high"');
            hint('rel="preload" as="image" href="' + low("lo") + '" media="not all and ' + PHONE_QUERY + '" fetchpriority="high"');
          }
        }
        if (!hints.length) return html;

        // Ahead of the stylesheet (and so of every script), where the preload
        // scanner meets them first.
        const block = hints.join("\n") + "\n";
        const sheet = /[ \t]*<link\b[^>]*\brel="stylesheet"/.exec(html);
        if (sheet) return html.slice(0, sheet.index) + block + html.slice(sheet.index);
        const headEnd = html.indexOf("</head>");
        return html.slice(0, headEnd) + block + html.slice(headEnd);
      }
    }
  };
}

// Every product with the series it lives in, read from the same data the site
// renders from, so nothing here can drift from the catalog. The item's address
// is /<slug> (scripts/slugs.js; js/series.js carries the browser copy of the
// rule).
function readProducts() {
  const read = (path) => JSON.parse(readFileSync(resolve(__dirname, path), "utf8"));
  const index = read("data/series.json");
  const list = [];
  for (const series of index.series) {
    for (const product of read(series.products).products) {
      list.push({ product, series, slug: slugify(product.name), featured: series.slug === index.featured });
    }
  }
  return { index, list };
}

// sitemap.xml: the gallery plus one entry per item, at the addresses the site
// really uses. The empty shell pages (archives, creation-process, series,
// terms) and launch-order are noindex and deliberately left out.
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

const escapeAttr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// One real page per item: dist/<slug>.html, a copy of the built product.html
// with that item's own <title>, description, canonical and social tags in the
// static <head>. The server maps /<slug> to it (public/.htaccess), so an item
// has a real address, link previews show the item rather than a generic
// "Product", and a crawler that doesn't run JS still sees the right canonical.
// The page's script is the same one every product shares: js/product.js finds
// the product from the address. product.html itself stays as the template —
// and as the landing for old product.html?id= links, which product.js rewrites
// to the new address.
//
// Runs after the bundle is on disk (closeBundle), because Vite's processed HTML
// (hashed asset URLs, hints) is what gets copied. Each tag it rewrites must
// exist in the template: a missing one throws, so a head edit in product.html
// can't silently leave items with the generic tags.
function emitItemPages() {
  let isBuild = false;
  return {
    name: "emit-item-pages",
    apply: "build",
    configResolved(config) { isBuild = config.command === "build"; },
    closeBundle() {
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

      for (const { product, series, slug } of list) {
        const name = product.name || "Product";
        const title = name + " \u2014 em\u00b7ji\u00b7ve";
        const description = product.description || "Item detail";
        const url = SITE_ORIGIN + "/" + slug;
        const metal = product["default-metal"];
        const icon = product.assets && product.assets.icons && (product.assets.icons[metal] || Object.values(product.assets.icons)[0]);

        let html = template;
        html = swap(html, /<title>[^<]*<\/title>/, "<title>" + escapeAttr(title) + "</title>", "<title>");
        html = swap(html, /<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="' + escapeAttr(description) + '" />\n<link rel="canonical" href="' + url + '" />', "meta description");
        html = swap(html, /<meta property="og:title" content="[^"]*" \/>/, '<meta property="og:title" content="' + escapeAttr(title) + '" />', "og:title");
        html = swap(html, /<meta property="og:description" content="[^"]*" \/>/, '<meta property="og:description" content="' + escapeAttr(description) + '" />', "og:description");
        html = swap(html, /<meta property="og:url" content="[^"]*" \/>/, '<meta property="og:url" content="' + url + '" />', "og:url");
        html = swap(html, /<meta name="twitter:title" content="[^"]*" \/>/, '<meta name="twitter:title" content="' + escapeAttr(title) + '" />', "twitter:title");
        html = swap(html, /<meta name="twitter:description" content="[^"]*" \/>/, '<meta name="twitter:description" content="' + escapeAttr(description) + '" />', "twitter:description");
        if (icon) {
          const image = SITE_ORIGIN + "/" + icon;
          html = swap(html, /<meta property="og:image" content="[^"]*" \/>/, '<meta property="og:image" content="' + image + '" />', "og:image");
          html = swap(html, /<meta property="og:image:alt" content="[^"]*" \/>/, '<meta property="og:image:alt" content="' + escapeAttr(name + (product.category ? " " + product.category : "") + " in " + metal) + '" />', "og:image:alt");
          html = swap(html, /<meta name="twitter:image" content="[^"]*" \/>/, '<meta name="twitter:image" content="' + image + '" />', "twitter:image");
        }
        // The early products.json hint names the featured series; an item of
        // another series needs its own.
        if (featured && series.slug !== featured.slug) {
          html = html.split('href="' + featured.products + '"').join('href="' + series.products + '"');
        }
        writeFileSync(join(distDir, slug + ".html"), html);
      }
    }
  };
}

// Dev and preview have no .htaccess, so this does what its rewrite rules do
// (keep the two in step): /gallery is index.html, /<page> is <page>.html, and
// an item's /<slug> is its own page — in preview that is the per-item file
// emitItemPages() wrote, in dev (where none exists) the shared product.html,
// which finds its product from the address. Only extension-less single-segment
// paths are touched.
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

// three's own DRACOLoader.js resolves its bundled decoder with
// `new URL('../libs/draco/draco_decoder.wasm', import.meta.url)` (and four
// siblings). Vite treats that pattern as a static asset reference, so it
// emits all five into dist/assets/ — ~1.26MB of .wasm and .js — even though
// this site can never request them: js/three-viewer.js calls
// setDecoderPath(new URL("assets/draco/", document.baseURI).href) before any
// load, which replaces every one of those URLs with our own self-hosted copy
// under assets/draco/ (kept, and still copied by the plugin above).
//
// Deleting them from the bundle rather than from disk afterwards, so the
// manifest stays truthful and nothing else can end up referencing a file
// that isn't there. If the decoder path in js/three-viewer.js is ever
// removed or made conditional, this has to go with it — three would then
// genuinely need the copies it emitted.
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
  // The site is served from the domain root (OVH), so every built
  // <script>/<link> reference resolves from "/". If it ever goes into a
  // subfolder instead, set this to that subfolder's path (e.g. "/shop/").
  base: "/",
  // Module workers (js/hdr-worker.js): the default worker format is an IIFE,
  // which cannot be loaded with { type: "module" }.
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
    // The one chunk over Vite's 500kB default is three.js itself (the lazy
    // three-viewer chunk, ~645kB / ~168kB gzipped) — a known, deliberate size
    // that only loads when a 3D model is actually drawn (js/viewer-entry.js).
    // The limit is raised just past it so the warning stays meaningful: a
    // second chunk growing that large, or this one doubling, would still show.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // Vite only treats index.html as an entry by default — every other
      // page needs listing explicitly or its own <script type="module">
      // tags (three-viewer.js on product.html) would ship unprocessed,
      // with the same unresolved bare-specifier "three" import that broke
      // index.html on the first deploy. Add a line here for any new page.
      input: {
        main: resolve(__dirname, "index.html"),
        product: resolve(__dirname, "product.html"),
        launchOrder: resolve(__dirname, "launch-order.html"),
        archives: resolve(__dirname, "archives.html"),
        creationProcess: resolve(__dirname, "creation-process.html"),
        series: resolve(__dirname, "series.html"),
        terms: resolve(__dirname, "terms.html"),
        // Served by Apache for any missing path (ErrorDocument in
        // public/.htaccess). A real entry rather than a public/ file so Vite
        // rewrites its stylesheet and logo to absolute hashed URLs.
        notFound: resolve(__dirname, "404.html")
      }
    }
  }
});
