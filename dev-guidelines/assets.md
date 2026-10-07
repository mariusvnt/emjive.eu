# Assets

`assets/` is static binary content. Three things write into it programmatically: `scripts/auto-render.js`, into `assets/series/<slug>/products/*/` (the `icons`/`fallback-img`/`top-shot` triad only) and the top-level `metal-sample_*.webp` files; `scripts/make-image-variants.js` (also run by `auto-render`), which writes the extra versions of the x-ray, hero and icon images beside their originals — see "Responsive versions" below; and `npm run json-tool`, into the same per-product folders (model/x-ray/photos only — it never touches the same three auto-render owns) plus `assets/hdri/*.hdr` and the folders themselves (creating a new product/series' folders, deleting a removed one's) — see `tooling.md` for both.

## The split: series-scoped vs global

```text
assets/
  series/bones/
    hero/      hand-rings-under-flesh_3k.webp, hand_xray.webp,
               hand_xray_extension_1.webp, hand_xray_extension_2.webp
    products/  furcula_ring/  foramen_ring/  disc_ring/  marrow_ring/
               suture_ring/  cartilage_ring/  rib-cage_ring/  rib-cage-extended_ring/
               joint_ring/  omoplates-unified_ring/  omoplates-dual_ring/
  draco/                             ─┐
  fonts/  dinish-woff2/               │
          geist-mono-woff2/           │
  hdri/                               │
  logo.svg, logo_compact.svg          ├─ global — every series shares these
  metal-sample_{steel,silver,bronze}.webp
  hand-pointer-thumb-opened.svg      ─┘
```

Anything under `assets/series/<slug>/` belongs to that collection and dies with it; everything else is brand-level and referenced from series-unaware code. That boundary isn't a guess — it's exactly what the global code paths point at: `css/style.css`'s only file `url()`s are the five `@font-face` rules (three DINish weights + two Geist Mono subsets), the three `.product-metals__option[data-metal]` swatch strips and the `.emjive-3d-viewer__nudge-hand` mask pointing at the pointer SVG (the loader's masks are inline data-URIs, not files), `js/three-viewer.js` hardcodes its `DEFAULT_HDRI_SRC` fallback (`assets/hdri/studio_kontrast_04_1k.hdr` — the real per-call choice comes from `data/series.json`'s `"hdris"` map instead, see below), and `auto-render.js` writes `assets/metal-sample_<metal>.webp`.

**Paths are repo-root-relative with no leading slash** everywhere they appear (JSON fields, `<img src>` in a hero fragment). The one exception is `url()` inside a series' `hero.css`, which resolves against the CSS file instead (`../../assets/...`) — see `pages.md`.

## `series/<slug>/hero/`

That series' homepage hero art, referenced from its `hero.html` fragment and preloaded via the `hero.preload` list in `data/series.json`.

**Resolution convention: `_<n>k` by pixel WIDTH**, the same bucket naming `hdri/` uses, and only where a file needs disambiguating. Every hero image is 16:9; only the width varies. A file whose name says `_4k` while it is 5760px wide (as `hand-rings-under-flesh_4k.webp` did) is worse than no suffix at all, which is why the halving pass renamed it rather than leaving the label on a file it no longer described.

Sizes today, after a pass that halved the two above-the-fold images (1.27MB → 0.39MB, roughly a third of the homepage's above-the-fold weight): `hand-rings-under-flesh_3k.webp` 2880×1620 (233KB), `hand_xray.webp` 1920×1080 (159KB), and the two `hand_xray_extension_*.webp` panels still at 3840×2160 (56KB and 36KB — they're below the fold and already tiny, so they were left alone). Resize with `sharp` directly at **quality 90** and `alphaQuality: 90` (all four carry alpha). **Do not use `npm run optimize-images` for hero art** — see `tooling.md` for the four separate reasons it will quietly do the wrong thing here.

**The hero pictures ship in several versions each** (see "Responsive versions" below) — the sizes above are the *originals*, which are the desktop high-res ones. This replaces an earlier decision not to use `srcset` at all (`sizes` can't express "most of this is off-canvas", so an honest value would have left every phone downloading the original): the versions here aren't picked by `srcset`/`sizes` but by `js/series.js` from a phone query, and the phone ones are **cropped** to the middle of the picture instead of merely scaled, which is what "off-canvas" needs.

For Bones: WebP (quality 90) rather than PNG, since these are full-bleed photographic renders where the lossy compression buys a large size win with no visible quality loss. `hand-rings-under-flesh_3k.webp` is `.reveal__img--normal`'s source, showing the ring shapes already embossed under the skin — reworked to also embed the "SCROLL TO SCAN" hint directly into the image itself, like a tattoo on the skin, replacing the separate `.reveal__scan-hint` DOM element/CSS/JS that used to render that text on top (removed entirely — see `styling.md`/`client-scripts.md`).

## `series/<slug>/products/<slug>_<category>/`

One folder per product, matching that series' `products.json` path fields (the listing shows the files those fields name; beside the x-ray and each icon sit the generated `_lo`/`_m`/`_m_lo` and `_128` versions described under "Responsive versions" below — `furcula_xray.webp` also has `furcula_xray_lo.webp`, `furcula_xray_m.webp`, `furcula_xray_m_lo.webp`, and so on):

```text
disc_ring/                disc_gltf.glb, disc_icon_{bronze,silver,steel}.webp, disc_fallback-img_{bronze,silver,steel}.webp, disc_top-shot_{bronze,silver,steel}.webp, disc_xray.webp
foramen_ring/              Foramen_gltf.glb, foramen_icon_{bronze,silver,steel}.webp, foramen_fallback-img_{bronze,silver,steel}.webp, foramen_top-shot_{bronze,silver,steel}.webp, foramen_xray.webp
furcula_ring/              furcula_gltf.glb, furcula_icon_{bronze,silver,steel}.webp, furcula_fallback-img_{bronze,silver,steel}.webp, furcula_top-shot_{bronze,silver,steel}.webp,
                           furcula_xray.webp, Furcula_photo1.webp, Furcula_photo2.webp
marrow_ring/               Marrow_gltf.glb, marrow_icon_{bronze,silver,steel}.webp, marrow_fallback-img_{bronze,silver,steel}.webp, marrow_top-shot_{bronze,silver,steel}.webp, marrow_xray.webp
suture_ring/               suture_gltf.glb, suture_icon_{bronze,silver,steel}.webp, suture_fallback-img_{bronze,silver,steel}.webp, suture_top-shot_{bronze,silver,steel}.webp — no xray/photos
cartilage_ring/            cartilage_gltf.glb, cartilage_icon_{bronze,silver,steel}.webp, cartilage_fallback-img_{bronze,silver,steel}.webp, cartilage_top-shot_{bronze,silver,steel}.webp — no xray/photos
rib-cage_ring/             rib-cage_gltf.glb, rib-cage_icon_{bronze,silver,steel}.webp, rib-cage_fallback-img_{bronze,silver,steel}.webp, rib-cage_top-shot_{bronze,silver,steel}.webp — no xray/photos
rib-cage-extended_ring/    rib-cage-extended_gltf.glb, rib-cage-extended_icon_{bronze,silver,steel}.webp, rib-cage-extended_fallback-img_{bronze,silver,steel}.webp, rib-cage-extended_top-shot_{bronze,silver,steel}.webp — no xray/photos
joint_ring/                joint_gltf.glb, joint_icon_{bronze,silver,steel}.webp, joint_fallback-img_{bronze,silver,steel}.webp, joint_top-shot_{bronze,silver,steel}.webp — no xray/photos
omoplates-unified_ring/    omoplates-unified_gltf.glb, omoplates-unified_icon_{bronze,silver,steel}.webp, omoplates-unified_fallback-img_{bronze,silver,steel}.webp, omoplates-unified_top-shot_{bronze,silver,steel}.webp — no xray/photos
omoplates-dual_ring/       omoplates-dual_gltf.glb, omoplates-dual_icon_{bronze,silver,steel}.webp, omoplates-dual_fallback-img_{bronze,silver,steel}.webp, omoplates-dual_top-shot_{bronze,silver,steel}.webp — no xray/photos
```

**Every** `.glb` in the catalog now carries `KHR_draco_mesh_compression` (check via a model's `extensionsRequired` in its own glTF JSON chunk), and all of them are produced by one re-runnable script — `npm run optimize-models` (`scripts/optimize-models.js`, see `tooling.md`). That was not always true: three shipped compressed and five didn't, which left the series at **66.9MB of glTF** with a single ring at 20.6MB. After one pass it was **8.3MB** (10.7MB across all nine at the time; **about 1MB across all eleven today**, after the models were replaced by low-poly versions — see below). Run it on any newly added model; it is idempotent enough to run over the whole folder. **Any change to a `.glb` (including that re-optimization) must be followed by `npm run measure-models`**: the product's `geometry` in `products.json` is pinned to the file's hash, and `validate-data` fails on a stale one (see `data.md`).

Alongside Draco, that script strips each model's textures and its `TEXCOORD_0`/`COLOR_n`/`TANGENT` vertex attributes. That is safe **only because** `js/three-viewer.js`'s `applyMaterial()` unconditionally replaces every mesh's material with a freshly built, untextured `MeshStandardMaterial` from `METAL_PRESETS` — a model's own maps and UVs are never read by anything. If the viewer ever starts honoring them, that step has to go.

**The models are low-poly now** (Oct 2026): hand-made versions of every item, 14k–39k vertices and 29k–78k triangles, **~1 MiB decoded each**. The dense exports they replaced (`rib-cage-extended` 3.94M vertices / 2.84M triangles, `rib-cage` 2.40M / 1.25M, `joint` 1.77M / 885K, `suture` 1.38M / 721K …) decoded to 40–123MB of geometry *each* — Draco makes a file small on the wire, not in memory — and were the largest single contributor to iOS Safari killing the tab; see `client-scripts.md`'s teardown notes. When adding a model, check the vertex and triangle counts the optimizer prints: a few tens of thousands of vertices is plenty for a ring drawn into a ~260px box, and a dense export has to be decimated or remodelled before it comes in (`--simplify` is the blunt tool; see `tooling.md`).

**A model's node transform is part of its pose.** The saved `fallback-img`, icons and top-shots were rendered with whatever rotation/scale/translation the file's node carried, and the live viewer shows the same, so a re-export that loses or changes it makes the live model turn away from its own poster at the handover. Furcula carries a +90° rotation about Y for this reason (the low-poly export arrived without the old file's node rotation, turned 90° about the vertical axis; checked by rendering both candidates against its saved `fallback-img`). Compare a new model's world-space proportions and orientation against the old one's render before replacing it.

`js/three-viewer.js`'s `GLTFLoader` needs a `DRACOLoader` to decode the extension at all — see `draco/` below and `client-scripts.md`. Without one, `GLTFLoader` doesn't degrade gracefully: it throws synchronously per-model, the load promise rejects, and the model just never appears (the pre-load image stays up forever, silently, with no visible error) — confirmed as the root cause the one time rib-cage/rib-cage-extended shipped ahead of the decoder being wired up.

**Naming conventions:**
- Folder: `<slug>_<category>` (lowercase product name + underscore + category). **This one is load-bearing now** — `auto-render.js` *constructs* the render output path from `assets/series/<slug>/products/<slug(name)>_<category>/` rather than reading it off `product.assets.model`, so a hand-renamed folder gets a new one created beside it instead of being silently found. It warns when a model sits outside the folder the convention predicts.
- Model file: `<name>_gltf.glb` — capitalization follows whoever exported it (`Foramen_gltf.glb` and `Marrow_gltf.glb` are capitalized, the other nine aren't) — hand-authored/exported, not machine-generated, so don't assume consistent casing when scripting against it. `npm run json-tool`'s dropzone (or its Replace button on an existing model) always writes/overwrites `<slug(name)>_gltf.<ext>` (`.glb`/`.gltf` only) — always lowercase, since it goes through the same slug function as the icon/fallback-img/top-shot filenames below, and it does **not** preserve an existing file's own irregular casing: replacing `Foramen_gltf.glb` this way deletes it and writes `foramen_gltf.glb` in its place.
- Icons/fallback images/top-shots: always `<slugified-name>_icon_<metal>.webp` / `<slugified-name>_fallback-img_<metal>.webp` / `<slugified-name>_top-shot_<metal>.webp`, generated and kept in sync by `scripts/auto-render.js` — these ARE consistently lowercase, since the slug function produces them. `icon` and `fallback-img` come from the exact same underlying screenshot (one capture, two saves — see `tooling.md`), just processed differently. **Never written by `json-tool`** — it has no upload slot for these three at all, by design.
- Extra photography (`assets.photos` field): `<Name>_photo<N>.webp` — capitalized to match the product name, hand-added (Furcula is currently the only product with any). `json-tool`'s dropzone follows the same `<Name>_photo<N>.<ext>` shape but preserves whatever extension was dropped.
- X-ray backdrop (`assets.xray` field): `<slug>_xray.<ext>` — underscore, matching the icon/fallback-img/top-shot convention (not hyphenated — an earlier, Furcula-only version was, before the other three products picked up their own backdrops too). Hand-added — no `auto-render.js` involvement, unlike icons/fallback-img/top-shot. `json-tool`'s dropzone/Replace writes `<slug(name)>_xray.<ext>`, same canonical-lowercase, casing-isn't-preserved rule as the model file above.

**Hand-added art should be WebP, and `npm run optimize-images` (`scripts/optimize-images.js`) is what enforces it** — it converts any stray PNG/JPEG under `assets/` to WebP (quality 82, alpha preserved, capped at 2048px) and deletes the original. Furcula's three files were the reason it exists: they shipped as PNG at **8.4MB combined**, `furcula_xray.png` alone being 6.38MB — larger than every 3D model in the catalog put together after Draco, on a page whose own model is 0.3MB. They are now 0.42MB. The script deliberately does **not** rewrite the `products.json` paths that point at what it converts; it prints the list of renames for you to apply by hand, since silently editing the catalog while also deleting the source art is the wrong trade.

## Responsive versions (generated)

The big pictures exist in up to four versions, one file each, written **next to the original** by `scripts/make-image-variants.js` (`npm run image-variants`; `npm run auto-render -- --image-variants` runs the same thing, and a full `auto-render` rewrites the icon ones). Never edit or commit-by-hand a generated file; change the original, or the rule in the script, and re-run.

| | desktop | smartphone |
|---|---|---|
| **low res** (first paint) | `<name>_lo.webp` | `<name>_m_lo.webp` |
| **high res** (swapped in when idle) | `<name>.webp` — the **original** | `<name>_m.webp` |

The smartphone versions are **cropped** to the middle of the picture — all a phone ever shows — and so are smaller as well as lower-res. What gets which, and the numbers (`PHONE_CROP`, the sizes and qualities live in the script):

| Original | Versions | Smartphone crop |
|---|---|---|
| `products/<n>/<n>_xray.webp` (1500×2000) | `_lo` (640w), `_m` (1600 tall), `_m_lo` (800 tall) | middle 74% of the width |
| `hero/<n>_3k.webp` (2880×1620) | `_lo` (1280w), `_m` (full height), `_m_lo` (810 tall) | middle 40% of the width |
| `hero/hand_xray.webp`, `hero/hand_xray_extension_*.webp` | `_m` only (hidden / far down the page: no low-res step); the extensions are capped at **1600 tall** (7.3MB decoded rather than 12.7MB — each panel is one viewport tall, ~850 CSS px) | the same 40%, so the layers stay on top of one another |
| `products/<n>/<n>_icon_<metal>.webp` (512²) | one thumbnail, `_128.webp` (selection bar, order rows) | — |

The fallback-img, top-shot and photo files have no versions. A **smartphone** is `(max-width: 640px) and (max-aspect-ratio: 3/5)`. The crop fractions and that query are also written in `css/style.css` (`--xray-crop`), `series/<slug>/hero.css` (`--hero-crop`, `--hero-crop-left`, `--hero-aspect`), `js/loader.js` and `vite.config.js`; `scripts/validate-data.js` fails the build if any copy differs from the script's or if a version file is missing, so a new product or series can't ship without them (`procedures.md`). How the pages choose and swap them: `client-scripts.md`'s `loader.js` section.

## Global items

- `draco/` — `draco_decoder.js`, `draco_decoder.wasm`, `draco_wasm_wrapper.js`, copied verbatim (unmodified) from `node_modules/three/examples/jsm/libs/draco/` — three's own Draco decoder, self-hosted here rather than pointed at the Google CDN three.js's examples default to, so the site makes no external requests. `js/three-viewer.js` points **one** shared, module-scope `DRACOLoader` at this folder and attaches it to **one** shared `GLTFLoader`. Both the sharing and the count matter: a `DRACOLoader` per load is the most-reported cause of Draco failing specifically on iOS Safari (three.js#22445), since each instance spawns its own worker pool and WASM heap. The path is resolved once against `document.baseURI` rather than left as the bare relative string `"assets/draco/"`, which would break silently — and only for Draco models — if a page ever moved into a subdirectory. `setWorkerLimit()` is lowered from the default 4 to at most 2, since every viewer decodes exactly one model and each extra worker is just another copy of the WASM heap. `preload()` is fired as soon as the first model load starts, so the decoder's ~336KB downloads *alongside* the .glb instead of serially after it. In practice only `draco_wasm_wrapper.js` + `draco_decoder.wasm` are ever fetched; `draco_decoder.js` (719KB) is the pure-JS fallback for a browser with no WebAssembly, kept as a safety net and never requested in practice. Needs re-copying by hand from `node_modules/three` on a `three` upgrade if the decoder's own wire format ever changes (rare — Draco's bitstream is stable) — not automated by any script.
- `hdri/` — environment HDRIs. **All three are 1024×512 today, ~4.6MB combined**, and the `_<n>k` suffix in a filename is not to be trusted: `studio_kontrast_04_1k.hdr` (1.40MB — halved from a 2048×1024 original by `npm run optimize-hdri`, which cut 4.22MB; see `tooling.md` for why that file was the single heaviest thing on the homepage and why halving it costs nothing visible), `autumn_field_puresky_1k.hdr` (2.00MB, honestly named), and `white-room_2k.hdr` (1.15MB — **misnamed**: it is 1024×512, not 4096×2048 as this doc previously claimed. Left under the wrong name for now, since renaming means touching `data/series.json`'s `hdris` map too). Only `studio` is used by any series today; the other two are registered in the map and one field away from being used, which is why the build still ships them. Resolved by name via `data/series.json`'s top-level `"hdris"` map (`studio`/`blue-pure-sky`/`white-room`), not a single hardcoded path — each series picks one via its own `"hdri"` key (`js/series.js`'s `hdriPath()`), and the swatch renderer's own choice is the separate top-level `"swatch-hdri"` key (see `data.md`). A brand-new `.hdr` file plus its `hdris` map key is added (or replaced/removed) via `npm run json-tool`'s Global tab now, rather than hand-copying the file in and hand-editing the map — see `procedures.md`. `js/three-viewer.js`'s `DEFAULT_HDRI_SRC` (`studio_kontrast_04_1k.hdr` — **keep it in step with the real filename**; it is the one HDRI reference that lives outside `data/series.json`) is only the fallback of last resort for a caller that omits `options.hdri` entirely — `scripts/auto-render.js`'s bare harness is one such caller, since it never loads `js/series.js`. Loaded by `loadEnvironment(renderer, hdriSrc)`, used by the live site and by every one of `scripts/auto-render.js`'s renders — icons, swatches, and top shots alike (top shots used to be lit with a plain `RoomEnvironment` instead; that override was removed, see `procedures.md`).
- `logo.svg`, `logo_compact.svg` — brand marks. `logo_compact.svg` (also every page's favicon) is **pure vector, 448 bytes**: two `<circle>`s and one `<path>` for the V in a 1500×1500 `viewBox`. It used to carry the V as an embedded base64 PNG (25KB, unanimatable); the path was traced from that PNG and matches it to within anti-aliasing. `loader-test.html`'s three stacked SVGs reuse its exact geometry, cropped to `viewBox="48 411 1405 678"` — keep the two in step if the logo changes.
- `metal-sample_steel.webp`, `metal-sample_silver.webp`, `metal-sample_bronze.webp` — the metal picker's squares, **72×72** WebPs (3× the 1.5rem squares): each is the metal-coloured part of a tube lit by the studio, cut out of a 1600×48 capture and squeezed square by `sharp` (`SWATCH_CROP`, `SWATCH_SIZE` in `scripts/auto-render.js`; all from one stacked scene, see `tooling.md`/`procedures.md`), shown as they are by `css/style.css`'s `.product-metals__option[data-metal="..."]` rules. Global by nature: a material sample, not any product. Lit by `data/series.json`'s `"swatch-hdri"` and turned by `"swatch-rotation"` — the only two swatch settings; `scene-tool.html` (`npm run scene-tool`) is how they get previewed and tuned. Vite inlines them into the stylesheet (they are a few hundred bytes).
- `hand-pointer-thumb-opened.svg` — the floating hand icon of the 3D viewer's idle "nudge" hint: `css/style.css`'s `.emjive-3d-viewer__nudge-hand` uses it as a `mask-image` (the element itself is created by `js/three-viewer.js`).
- `hand_normal.webp` — **dead**. The plain hand that `hand-rings-under-flesh_3k.webp` replaced; no live HTML/CSS/JS references it. Still on disk (deleting a binary is a separate call from a doc pass) but **no longer shipped**: `vite.config.js`'s copy step now names it explicitly in `NEVER_COPY`, so it costs 0.64MB in the repo and nothing in `dist/`. See `tooling.md`.

## `fonts/geist-mono-woff2/` — 2 files

`GeistMono-latin.woff2` and `GeistMono-latin-ext.woff2`, pulled from Google's own CDN and committed here. Geist Mono (SIL OFL, by Vercel) used to arrive at runtime via a `<link rel="stylesheet">` to `fonts.googleapis.com` in all seven pages' `<head>` — two extra DNS+TLS handshakes plus a **render-blocking third-party stylesheet** ahead of first paint, for 37KB of font. Self-hosting made the site genuinely external-request-free (verified: zero cross-origin resource entries on every page), which the `draco/` note above had already been claiming on the site's behalf.

Both weights the site uses (400 and 500) resolve to the same file — Geist Mono ships as one variable font — so `css/style.css` declares `font-weight: 400 500` per `@font-face` rather than one block per weight. Only the `latin` and `latin-ext` subsets are here; Google also serves cyrillic/vietnamese/symbols subsets, deliberately skipped since nothing on the site uses them and a browser never downloads a subset whose `unicode-range` it doesn't need. Each page preloads `GeistMono-latin.woff2` and `DINish-Regular.woff2` directly (`<link rel="preload" as="font" crossorigin>`) — `crossorigin` is mandatory there even same-origin, since fonts are always fetched in CORS mode and a mismatched preload is simply downloaded twice.

## `fonts/dinish-woff2/` — 43 files

The full DINish family (every weight/width/italic combination). Only three files are actually referenced by the site's CSS — `DINish-Regular.woff2` (400), `DINish-Bold.woff2` (700), `DINish-Black.woff2` (900).

**This whole folder is excluded from the build** (`NEVER_COPY` in `vite.config.js`, 1.35MB saved), and so is `fonts/geist-mono-woff2/`. That is not a statement that the fonts don't ship — Vite traces the `@font-face` `url()`s and every page's `<link rel="preload">` hrefs, emits its own content-hashed copies into `dist/assets/`, and rewrites both references to point there. The verbatim copy was pure duplication of the 5 used files plus 40 unused ones. If a font ever starts being loaded from a runtime string rather than from CSS, that exclusion has to be revisited — see `tooling.md`.

The three used files sit at exactly these paths:

```text
assets/fonts/dinish-woff2/DINish-Regular.woff2
```

That's the path `css/style.css`'s first `@font-face` rule points at, and it exists on disk — so the font file itself isn't the problem if DINish isn't rendering. See `styling.md`'s note: that rule previously had a real syntax bug (a trailing comma in its `src` value) that made browsers drop the whole declaration regardless of the file being present and correctly pathed.

## `public/` icons (outside `assets/`)

`public/favicon.ico` and `public/apple-touch-icon.png` are generated from `assets/logo_compact.svg` by `npm run render-favicons`. They live in `public/` (not `assets/`) because they are requested by fixed root URLs and must not be content-hashed; Vite copies `public/` to the root of `dist/`. See `tooling.md`.

## Pointers

- Which JSON fields point at these files: `data.md`
- What generates the icon/top-shot/swatch files: `tooling.md`
- How a hero bundle references its own art: `pages.md`
- Step-by-step "add a product" / "add a series" / "set up DINish": `procedures.md`
