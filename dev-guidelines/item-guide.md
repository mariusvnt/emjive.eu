# Item guide

Everything about the catalog's items: how the data is organised, where their files live, the tools that build both, and the short procedures for common changes. The code that renders them is in [code-guide.md](code-guide.md). Where each file is: [index.md](index.md). What must always hold: [rules.md](rules.md).

## 1. The model

- **Series.** The catalog is organised into series (collections). Each has its own products, its own design manifest and its own homepage hero. Retired series stay reachable.
- **The featured series.** One field in `data/series.json`, `featured`, decides which series the homepage shows. Switching it is the whole switch.
- **Products.** A product belongs to one series and one category.
  - Its **name is its address** (`/furcula`), so names are unique across all series.
  - Its **id** only numbers it within its series.
- **Designs.** A product can have several designs: variants of the same item, a different shape, parts added or removed. A design is a combination of the visitor's picks among the product's options. The product's own fields *are* the default design. The other designs carry their own model and renders, and nothing else needs to know they exist.
- **Brand-wide vocabularies.** Categories, metals and lighting are brand-wide, declared once in `data/series.json`.
  - **Categories** own sizing: whether their items are sized at all (a unit), and the size guide. The site never shows the unit: a size is a plain number, since few people know a European ring size is the inner circumference in mm, and "62 mm" reads as a width. A series picks the categories it sells.
  - **Metals** are global, because the 3D materials are global.
  - **Lighting**: the HDRIs, named in one map; each series picks one, and only the picked ones ship. The rest of the studio (the sun, the HDRI's blur, the reflection detail) is one setting for every scene, so an HDRI changes only what the metal reflects.
- **A ring changes size the way it is printed.** Every point of the model moves away from the finger axis by the difference of the two sizes' inner radii: the sizing of the Jewelry Printing Toolbox, which `scripts/ring-size.js` ports. Thickness and band width stay as designed, so a smaller size never thins a delicate part below what prints, as a scale would. Models are drawn at the reference size with the finger axis through their origin. The model on the page, its outlines and dimensions, its price, and the print model sent to the printer all follow the same shift.
- **Two sizes, kept apart.** The reference size is what the models and their measurements are pinned to; the default size (`EmjiveHelpers.DEFAULT_SIZE_MM`) is the one a ring is first shown and offered at. Changing the default only takes a re-render; changing the reference would mean re-measuring every product.
- **Prices are derived, never typed.** Every price is what the printer charges to make the piece, in the chosen metal, size and design, plus the brand's margin and VAT, rounded up to the euro (`EmjiveHelpers.salePrice`). Nothing per product is stored that could go stale. The printer's charge is a fit of its quotes on the printed piece's volume and surface area, kept with the date it was last checked against them (`production-costs` and `pricing` in `data/series.json`), so new quotes are a data edit. A fit only holds over the volumes it was made on: `validate-data` fails a ring that grows past one. The printed piece, not the 3D model on the page, is what is made and priced, and the two can differ.
- **The price is shown broken down**: design (the margin, with the rounding up, so the rows add up to the price), manufacturing (the printer's charge, flat while its minimum applies) and VAT.

## 2. Data files

All JSON, fetched by the pages themselves, so everything in them is public.

| File | What it is |
| --- | --- |
| `data/series.json` | The brand-wide settings and vocabularies, plus one entry per series (the paths to its data and its hero bundle). |
| `data/series/<slug>/products.json` | That series' catalog. |
| `data/series/<slug>/manifest.json` | That series' design manifest, for `series.html` (only its title, year and subtitle render so far). |

**The schemas are in `scripts/validate-data.js`**, which is the source of truth for every field. It also checks what a schema can't: every path exists with its exact case, references resolve across files, names are valid addresses, measured geometry matches its file, the generated image versions exist.

**Who writes what.** Every part of the data has an owner, and the tools never touch each other's parts:

| Part | Written by |
| --- | --- |
| Series, products, descriptions, categories, metals, HDRIs, `featured` | by hand or with `json-tool` |
| The printer's charges (`production-costs`), the margin and VAT (`pricing`) | by hand |
| A product's `designs` block | by hand only (`json-tool` carries it through untouched) |
| Default camera angle, a series' HDRI, the studio (`sun`, `hdri-blur`, `reflection-detail`), the swatch scene, the metal shaders (`metal-shaders`) | `scene-tool` |
| The rings' x-ray look on the hero's hand, and their fade where the finger hides them (`hand-shader`) | by hand |
| `geometry` | `measure-models` |
| Icons, fallback images, wheel posters, hand posters, plan views (paths and files) | `auto-render` |

The files are hand-aligned, and every tool writes them by text surgery, never by re-serializing (rules.md).

## 3. Assets

**Series-scoped or brand-wide.** Everything under `assets/series/<slug>/` belongs to that series: its hero art, and one folder per product. Everything else in `assets/` (fonts, HDRIs, the Draco decoder, logos, metal swatches) is brand-wide and referenced from code that knows nothing about series.

**One folder per product, `<name>_<category>`**, holding everything that product is made of. The tools build that path, so a hand-renamed folder gets a new one beside it. Files follow the name:

- `<name>_gltf.glb`, the model: what the site draws;
- `<name>_stl.stl`, the print model: what is printed, weighed and priced;
- `<name>_<kind>_<metal>.webp`, the renders: `icon`, `fallback-img`, `wheel-poster`;
- `<name>_hand-poster.webp`, the render of the ring on the hero's hand, one for every metal;
- `<name>_plan-<front|side>.webp`, its outline views, one set for all metals (not shown by the site at present);
- `<name>_xray.webp`, the design stage's backdrop;
- `<Name>_photo<N>.webp`, photography.

A non-default design's files are named `<name>-<design key>_…`. The renders are always lowercase. The hand-exported models are not consistently so, so don't assume a case.

**Generated or hand-added.**

- **Generated, and committed:** the renders and the image versions. Never edit one; change the source and re-run its tool.
- **Hand-added:** the models (or split out of a Blender export), the x-rays, the photos and the hero art.

Hand-added art is WebP. Don't put the hero art through `optimize-images`, whose fixed size cap and quality are wrong for it: resize it with `sharp` directly.

**Print models are not in git, and not in the build.** They are large and only the printer needs them. A clean checkout has none: `validate-data` says so and skips their checks, and `measure-models` refuses to measure without them. Keep the Blender export they were cut from.

**Models are low-poly on purpose.** A small file can decode to a lot of geometry, and iOS Safari ends a tab that uses too much memory. A few tens of thousands of vertices is plenty for a ring on a phone screen. A dense export has to be decimated before it comes in.

**A model's node transform is part of its pose.** The renders were made with whatever rotation the file carries, and the live viewer shows the same. A re-export that loses it turns the model away from its own poster at the handover. When replacing a model, compare it against its old `fallback-img`. `split-models` puts a lost rotation back when it can tell.

**Image versions.** The x-rays and the hero pictures come in desktop/phone × low/high versions written beside the original (`_lo`, `_m`, `_m_lo`), and each icon has a small thumbnail (`_128`). See code-guide.md §6 for why.

## 4. The pipeline

From a Blender export to a shippable item, in the order that works. None of these runs in the build: each is a deliberate pass whose output is committed and reviewed.

1. **`npm run split-models`**: the models are authored together and exported as one glTF (a root node per model or design) and one binary STL of their print models. This cuts them into the files `products.json` names. The STL has no names, so its objects are paired with entries by triangle count: a print model is its model subdivided once or twice, so it has exactly 4× or 16× the triangles of the exported model. Only what a count can't settle, designs that share a mesh, is measured and matched by shape, and an ambiguous match is refused. A print model that isn't a plain subdivision of its model falls back to being measured, against the geometry last measured.
2. **`npm run optimize-models`** (run by `split-models`): strips what the viewer never reads, welds and Draco-compresses. It re-reads what it wrote and fails unless the result decodes to the same shape, because it overwrites the only copy.
3. **`npm run measure-models`**: each model's and print model's volume, surface area and minimum bounding box, and what the size does to them (the volume and area gained per mm of size, the smallest size, the box across the sizes), written as the product's `geometry`, pinned to the files' hashes. It refuses a model whose finger axis doesn't run through its origin (along its `finger-axis`, along Y for a print model), and warns when a print model's bore measures far from the reference size.
4. **`npm run auto-render`**: the renders, through the site's own viewer code in Chrome with a real GPU, written next to the model and patched into `products.json`:
   - the **fallback image** is the viewer's first frame, pixel for pixel, so the swap from poster to live model doesn't jump. A ring's is drawn at the default size, as the item page first shows it, and so are its icon and plan views; the wheel and hand posters are not, since the wheel draws its models unsized;
   - the **icon** is the same capture, cropped tight;
   - the **wheel poster** is the model as the wheel draws it;
   - the **hand poster** is the ring as the wheel draws it on the hero's hand: straight down, fading out with depth where a finger would hide it, in the x-ray look and no metal. It stands in until the 3D models take the hand over;
   - the **plan views** are front and side outline drawings (the item page doesn't show them at present, measuring its dimensions off the live model): the model's silhouettes and edges in the category colour on transparent, seen as on a technical drawing and cropped to one common rectangle, so the two share a scale. Their frame comes from the model's box (`geometry["axis-box"]`, from `measure-models`) and, for a model whose finger runs along its own x, the product's optional `"finger-axis": "x"` (hand-added; the front view must look through the finger hole). One set per product and per design;
   - the **metal swatches** are one sphere, re-tinted for each metal.

   Its flags narrow a run (`--product=`, `--series=`, `--swatches-only`, `--wheel-posters-only`, `--hand-posters-only`, `--plan-views-only`, `--image-variants`).
5. **`npm run image-variants`**: writes any missing image versions (a new x-ray, a new hero picture). `auto-render` rewrites the icon thumbnails itself.
6. **`npm run verify`**.

Renders never regenerate on their own. After a change to a model's shape, a camera, a metal's shader, the `hand-shader`, an HDRI, the studio settings, the wheel's drawing, the default size, or the plan views' look (the category colour, their axes), re-render what used it.

## 5. Tools

- **`npm run json-tool`** (local page): edits the global settings and adds, edits or removes a series or a product, with drag-and-drop for the hand-owned files (model, x-ray, photos). It files them where the conventions say. It never writes what another tool owns (renders, `geometry`, the `designs` block), never runs another tool, and only reminds you what to run next. Every removal is confirmed, and is blocked while something still depends on what it removes.
- **`npm run scene-tool`** (local page): previews a product or the swatch sphere through the real viewer, to set a product's default camera, a series' HDRI, the studio (sun, HDRI blur, reflection detail), the swatch scene and the metal shaders, then saves the ticked parts into the source files.
- **`npm run size-stl -- <name> <size>`**: a product's or design's print model at an ordered size, written next to it: what goes to the printer. The same sizing as the model on the page, with the toolbox's output exactly.
- **`optimize-images`, `optimize-hdri`**: occasional squeezers for heavy hand-added art. `optimize-images` converts stray PNG/JPEG to WebP and prints the paths to update. `optimize-hdri` shrinks an oversized HDRI into a new file, since the file name carries the width.
- **`render-favicons`**: the favicons, from the compact logo. Re-run only if the logo changes.

Both local pages run their own small servers on loopback only, and both are kept out of the build.

## 6. Procedures

### Add a product

1. Pick its name. It becomes its address, so it must not clash with another product in any series or with a page.
2. Add it with `json-tool` (or by hand, in its series' `products.json`, with its folder).
3. Bring in its model: `split-models` from the Blender exports, or drop the model in `json-tool` and run `optimize-models`. Check the vertex count it prints.
4. `measure-models`. If its finger hole runs along the model's x, add `"finger-axis": "x"` to the product.
5. Set its default camera in `scene-tool`.
6. `auto-render -- --product=<name>`.
7. If it has an x-ray, drop it in, then run `image-variants`.
8. Photos and their captions in `json-tool`.
9. Place it on the hero's hand (`hero-hand-visibility`) by trial and error, or leave it hidden.
10. `verify`.

### Add designs to a product

In Blender, one root node per design, named as the design. Write the `designs` block by hand (the options, then one entry per design, each a different combination of picks), then run `split-models`, `measure-models`, `auto-render -- --product=<name>` and `verify`.

### Replace a model

Keep its orientation (§3), re-run `measure-models` (its hash changed), and re-render if its shape changed.

### Add a series

`json-tool` → Series → Add new scaffolds the data files, the asset folders and a copy of an existing hero bundle as a starting point. Then write the series' own hero (its contract is in code-guide.md §2) and add its art. It shows on the homepage once `featured` names it.

### Add a category

`json-tool`'s Global tab, then list it in each series that sells it. The header's filter renders from the data. A category with no unit disables selection for its products.

### Add a metal

`json-tool` adds it to the `metals` list, with a neutral grey shader to tune in `scene-tool`, and reminds you of the rest, which is by hand:

- its `production-costs` (the printer's charge for it), `metal-composition` and `metal-technology` in `data/series.json`;
- a swatch rule in `css/style.css`, which the material dial and the gallery's picker share.

Then re-render everything. Removing a metal in `json-tool` cascades through every product.

### Tune a camera, a metal, an HDRI, the studio or the swatches

In `scene-tool`, then re-render what used it.

### Add an HDRI

`json-tool`'s Global tab (drop the file, name it), as a Radiance `.hdr` (convert an `.exr` in Blender first). Shrink it with `optimize-hdri` if it is wider than the tool's default width: the models never show it, only reflect it, and the environment's sharpest level is a quarter of its width, so narrower reflects blocky and wider only costs download and memory.

### Remove anything

With `json-tool`, whose blocking checks keep the catalog whole. By hand means finding every folder, entry and reference yourself.

## 7. Current content

Placeholder content is expected, not a bug. Only Furcula has a description and photos. Every other product has a placeholder description with no photos, and a few aren't placed on the hero's hand yet. Every product has its model, wireframe, measured geometry and full set of renders.
