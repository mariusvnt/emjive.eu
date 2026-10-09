# Pages

The 7 HTML files at the repo root (plus `404.html`, also a root build entry — the Apache `ErrorDocument` — which has no scripts and uses only absolute URLs so it renders at any path depth; see `tooling.md`).

**They all stay at the repo root, deliberately.** `js/series.js` fetches `data/series.json` with a *relative* path, and every path inside the JSON is repo-root-relative too. Combined with `vite.config.js`'s `base: "/"`, a page moved into a subdirectory would resolve all of them against the wrong prefix and break silently. Any new page also needs adding to `vite.config.js`'s `rollupOptions.input` or it ships unprocessed (see `tooling.md`) — except the dev-only pages (`scene-tool.html`, `json-tool.html`, `loader-test.html`), which are deliberately kept out of the build.

## Addresses (clean URLs)

No address shows a file name or an `?id=`:

| What | Address | Served from |
|---|---|---|
| Gallery (home) | `/gallery` — and the bare `/` serves the same page **without a redirect** (no extra round trip on the main entry; the canonical says `/gallery`) | `index.html` |
| An item | `/<slug>`, e.g. `/furcula`, `/rib-cage` | its own built page, `dist/<slug>.html` |
| Any other page | `/archives`, `/creation-process`, `/terms`, `/launch-order`, `/series?series=<slug>` | `<page>.html` |
| A non-featured series' gallery | `/gallery?series=<slug>` (and `&cat=` for a category filter) | `index.html` |

- **An item's slug is its name** made URL-safe (`Furcula` → `furcula`, `rib-cage-extended` unchanged; the rule is `slugify()` in `scripts/slugs.js`, with `productSlug()` in `js/series.js` as its browser twin). It is flat — no series, no folder — because every page references `css/`, `js/`, `assets/` and `data/` **relatively**, which only resolves from a root-level URL (for the same reason a trailing slash is redirected away: `/archives/` would look for `/archives/css/…`). The consequences: slugs are unique across **all** series, and may not equal a page or a top-level file/folder (`gallery`, `archives`, `assets`, `js`…). `npm run validate-data` fails the build for either, and renaming a product changes its address.
- **One built page per item.** `emitItemPages()` (`vite.config.js`) copies the built `product.html` to `dist/<slug>.html` with that item's own `<title>`, description, canonical and `og:*`/`twitter:*` tags. The page's script is still the shared `js/product.js`, which finds the product from `location.pathname`. `product.html` stays as the template and as the **landing for old `product.html?id=01[&series=x]` links**, which `product.js` rewrites to `/<slug>` with `history.replaceState` (a `#hash` survives).
- **The server does the mapping** (`public/.htaccess`; `tooling.md`): `/index.html` → 301 `/gallery`; `/<page>.html` → 301 `/<page>` (not `product.html`, not `404.html`); trailing slash stripped; internally `/gallery` → `index.html` and `/<name>` → `<name>.html` when that file exists, so an unknown name is a real 404. `vite.config.js`'s `cleanUrls()` does the same for `npm run dev` and `vite preview` (in dev there are no per-item files, so an item slug is served `product.html`).
- **Links are root-absolute**: the header/nav/footer in the pages, and the `EmjiveSeries` builders `mainHref`/`manifestHref`/`productHref` (`client-scripts.md`). A new page needs a clean link, not `<page>.html`.


## Titles and headings — one `h1` per page, one distinct `<title>` per page

Every page used to ship `<title>em·ji·ve</title>`, with `product.html` and `series.html` overwriting it at runtime — so crawlers, browser history and shared links saw the same six characters for the homepage, Terms and the order page alike. Only `product.html` had an `h1`.

| page | static `<title>` | `h1` |
|---|---|---|
| `index.html` | `em·ji·ve` | `.visually-hidden`, first child of `<main>` |
| `product.html` | `Product — em·ji·ve` | `.product-detail__label-text` (the product name) |
| `launch-order.html` | `Your selection — em·ji·ve` | `.visually-hidden`, first child of `<main>` |
| `archives.html` | `Archives — em·ji·ve` | inside `.section-head` |
| `creation-process.html` | `Creation process — em·ji·ve` | inside `.section-head` |
| `terms.html` | `Terms & Conditions — em·ji·ve` | inside `.section-head` |
| `series.html` | `Series — em·ji·ve` | `#seriesManifestTitle`, inside `.section-head` |

Three things to keep in step when adding a page:

- `product.html` and `series.html` still overwrite `document.title` at runtime (`js/product.js`, `js/series-page.js`) with the real product/series name, in the same `<name> — em·ji·ve` shape. The static value is what a crawler and a social preview see, so it has to stand on its own.
- `og:title` and `twitter:title` carry the same string as `<title>` on every page. They were the same hardcoded `em·ji·ve` everywhere, which is why every shared link previewed identically.
- `og:url`, `og:image` and `twitter:image` are absolute `https://emjive.eu/...` URLs (crawlers don't resolve relative ones), `og:url` being the page's own clean address (`https://emjive.eu/gallery` for the homepage, `https://emjive.eu/archives`, `https://emjive.eu/<slug>` for an item). A new page needs its own `og:url`; if the domain ever changes, it's a find-and-replace across all seven (the per-item pages take theirs from `SITE_ORIGIN` in `vite.config.js`).
- The shell pages' heading is the *page's own title*, so it is an `h1`. `product.html`'s "Characteristics" and "Shipping & Returns" (both visually hidden) stay `h2` — they are subsections under the product's `h1`. `css/style.css` targets `.section-head :is(h1, h2)` so both get the same treatment; the level is about document structure, not size. `.visually-hidden` (see `styling.md`) is for the two pages whose design has nowhere to put a visible title.

## Head and landmarks — what every page carries

- **Indexing**: `archives`, `creation-process`, `series`, `terms` (empty shells) and `launch-order` (per-visitor) carry `<meta name="robots" content="noindex">`; `scripts/check-dist.js` enforces exactly that set. **Remove the line when a shell gets real content** and add the page to `emitSitemap()` in `vite.config.js`.
- **Canonical**: `index.html` has a static `<link rel="canonical" href="https://emjive.eu/gallery">` (not `/` — a root canonical on a page reached at another URL fails Lighthouse's canonical audit, and `/gallery` is the one address search engines should keep). Each item's built page (`dist/<slug>.html`) carries its own static canonical, title and description; the shared `product.html` has none, and `js/product.js` `updateSearchMetadata()` only fills one in (from `location.origin` + `productHref`) when the page it runs on has none, plus the meta description from the product's own data. `scripts/check-dist.js` asserts each item page's canonical and `og:url`.
- **Icons/social**: `theme-color` is `#f8f8f8` (= `--bg`); `favicon.ico` + `apple-touch-icon.png` from `public/`; `twitter:card` is `summary` (the shared OG image is a 512px square); `og:image:alt`, `og:locale`.
- **Skip link + main target**: every page's first focusable element is `<a class="skip-link" href="#main">` (`#productDetail`/`#seriesManifest` on those two pages, which already had ids); each `<main>` has `tabindex="-1"` so focus can land on it.
- **`<noscript>`**: the JS-rendered pages (`index`, `product`, `launch-order`, `series`) open `<main>` with a "needs JavaScript" notice (`.page-shell__loading`).
- **Header**: the menu toggle's `aria-label` is a neutral "Menu" (state is `aria-expanded`); the `<nav>` has `aria-label="Site"`. Logo images carry intrinsic `width`/`height`. `<html data-viewer="idle">` (`index.html` only) controls when the 3D chunk starts downloading, and `<html data-products="eager">` (`index`, `product`) starts the `products.json` request as soon as the series index resolves (`client-scripts.md`); `product.html` has neither viewer attribute — it asks for the chunk itself once its first paint is in.
- **Live regions**: `#productLabelPrice` (`aria-live`), `#productDetailLoading` (`role=status`), the selection bar's hidden status, the grid's empty-filter message; load failures use `role="alert"` with a "Reload" button (built by `window.EmjiveMessage.show()`, see `client-scripts.md`; a missing product or series says "Item not found" / "The requested series doesn't exist" with "Back to gallery"). The skip link, when focused, is a full-header-height bar with no outline. The order page's terms control is a `role="checkbox"` button labelled by its sentence (`aria-checked`, not `aria-pressed`).

## Shared header — one byte-identical nav

All seven pages open with the same `<header class="site-header">`: brand logo linking home, a `+`/`-` hamburger toggle, and a dropdown nav with exactly three rows, in this order:

1. **Filter row** — dual-purpose, **rendered by `js/main.js`'s `renderHeaderFilter()`** from the active series' own category list, never hand-written — don't add markup for it, and don't assume there are three category tags, since each series declares its own subset (see `data.md`).
   - On `index.html` (`#productGrid` exists): a DINish "Filter gallery by" label plus one Geist Mono `.is-cat` tag per category, when the active series declares more than one. Exactly one category drops the label and renders that lone tag by itself, `.is-active` by default and inert (no `href`, nothing to actually filter). Zero categories hides the row entirely.
   - On every other page: a single DINish "Gallery" link (`class="is-info"`) back to `/gallery#products`, unconditionally — regardless of category count, so there's always a way back to the grid from the nav.

   `css/style.css` needs an explicit `.site-header__filter[hidden] { display: none }` for the zero-category case to actually disappear, same trap as `.product-card[hidden]` below: the row's own `display: flex` is an author rule and beats the UA `[hidden]` regardless of specificity.
2. **Archives** (`archives.html`) — DINish, `class="is-info"`.
3. **Creation process** (`creation-process.html`) — same.

Selection inside this menu — which category tag(s) are active, or the lone leftover one's default state — is signaled by a small dot before the text, the same always-rendered/background-toggled recipe used for size/metal selection elsewhere on the site (see `styling.md`'s "Recurring non-obvious techniques"), not a color change. "Gallery", Archives and Creation process never carry a dot — only category tags do.

The `<nav>` block is now **byte-identical across all seven pages** (verified by hashing it in each). The one remaining difference anywhere in the header is `.site-header__brand`'s href: `#top` on `index.html`, `/gallery#top` everywhere else. That has to stay — a link to the page's own address plus `#top` (here `/gallery#top`, or `index.html#top` before the clean URLs) would trigger a reload instead of the CSS `scroll-behavior: smooth` scroll.

**Opening the menu isn't limited to the `+`/`-` icon.** `js/main.js` also delegates a click handler to `.site-header__row` itself, so any empty space in that row toggles the menu the same way the icon does — it just ignores clicks that land on the brand logo (`.site-header__brand`, which keeps navigating home) or on `.menu-toggle` (which already has its own listener; letting the row's handler also fire there would double-toggle).

**Closing it isn't limited to picking a link, either.** `window.EmjiveMenus` (`js/series.js`) coordinates "click away to close" between the header menu and the floating selection bar's drawer (`js/selection-bar.js`) — two panels that don't know about each other and can be open at once. A click outside every currently-open panel's root closes only the most-recently-opened one; a second outside click is needed to close the other if both happened to be open together. See `client-scripts.md` for the mechanism.

The old `.ring`/`.neck`/`.wrist` links (three dead anchors all pointing at the same `#products`) and the "About us" link (pointing at a `#contact` section that never existed on any page) are both gone. `js/main.js` still carries a guarded `#contactForm` stub that no-ops, kept for whenever a contact form actually gets built — see `procedures.md`.

## The series hero bundle

`index.html` has no hero markup of its own. It carries two empty slots — `#seriesHero` in `<main>`, and `#seriesBackdrop` inside `.products` — and `js/series.js` clones the featured series' hero into them at runtime from `series/<slug>/`:

| File | What it is |
|---|---|
| `hero.html` | A set of `<template data-series-slot="...">` elements. The loader clones each into the matching element id, so a series can fill any subset of the slots without `index.html` changing. Its pictures carry **no `src`**: `data-full` names the original (the desktop high-res file, base name of the other three versions) and `data-lo` marks the ones that also have the low-res pair; `js/series.js` sets the `src` for the viewport on the inert clone (see "Responsive hero" below). |
| `hero.css` | That hero's styling, injected as a `<link>`. Lands after `css/style.css`, so it wins on ties. |
| `hero.js` | That hero's behavior. Assigns `window.EmjiveSeriesHero = { init, onProducts }` and **must have no side effects at execution time** — that's what lets the loader run all three fetches in parallel. It also **must not use bare specifiers**: it's loaded via a runtime string path, so Vite never sees it and couldn't resolve `import "three"`. |

Two path conventions live side by side in one folder, which is the easy thing to get wrong: `url()` inside `hero.css` resolves against **the CSS file** (`../../assets/...`), while the image paths inside `hero.html` (`data-full`, which becomes the `<img src>`) resolve against **the page**, because the element is cloned into the live document.

**Anti-flash measures**, all load-bearing:
- `.series-hero { min-height: 100svh }` reserves the above-the-fold box before the bundle lands, so the grid never flashes into the viewport. It must stay a plain box — `.reveal__pin` inside is `position: sticky`, which dies silently if an ancestor gets `overflow`/`transform`/`filter`/`contain`/`will-change`.
- `body.has-series-hero` is **static markup** in `index.html`. It replaced `body:has(#revealSection)`, which can't work with a runtime-injected hero: `:has()` is live, so it wouldn't match at first paint, the selection bar would paint visible, then snap away when the fragment landed.
- The series entry's `hero.preload` list gets `<link rel="preload">` tags the instant the index loads (`js/series.js`), because a fragment's images aren't discoverable by the browser's preload scanner — and for the featured series the build adds the same hints, plus the fragment, `hero.css`, `hero.js` and `products.json`, to `index.html`'s `<head>` itself, so they start with the HTML rather than after `series.json` (`tooling.md`, `injectLoadHints`). `hero.preload` lists **originals**: the first entry is the picture the first paint is made of and is preloaded as its low-res version for the viewer's viewport (`fetchpriority="high"`; the build emits one `<link>` per side of the phone query, `media=` picking the right one); the rest are layers that start clipped away and are preloaded at `fetchpriority="low"`, as the right high-res version.
- If the bundle fails to load, `js/series.js` strips `has-series-hero` and empties the slot — otherwise the bar would stay hidden forever, since nothing would ever publish a scroll position.

**Responsive hero.** Each hero picture exists in up to four versions (desktop/smartphone × low/high res — `assets.md`; the smartphone ones are cropped to the middle of the picture), and `js/series.js` picks per viewport as it clones the fragment in (`data-full` → `src`), so the browser never fetches the wrong one. Low-res first, high-res swapped in when the page is idle (`client-scripts.md`, `loader.js`). On a phone the pictures are portrait, which `series/<slug>/hero.css` handles from three variables on `:root` — `--hero-aspect` (every layer's shape: the photo, the x-ray group and the extension panels all size from it, so they stay exactly on top of one another), `--hero-crop` and `--hero-crop-left` (what share of the full width is left, and where it starts, which `.reveal__ring` uses to re-express each product's `hero-hand-visibility` x/size against the cropped picture; `y` is untouched, the crop is of the width only). Those numbers, and the phone media query that switches them, are the generator's `PHONE_CROP.hero` and `PHONE_QUERY` — `scripts/validate-data.js` fails the build if they disagree. A new series' hero bundle has to follow the same convention (`data-full`/`data-lo`, and the three variables) or ship only the desktop pictures.

## `index.html` — homepage / the featured series

Hero slots (above), then `#productGrid`, empty in the markup and populated by `js/main.js` from the active series' products. `?series=<slug>` shows any past series' main page instead of the featured one; `?cat=ring,neck` pre-applies the category filter.

**Filtering hides already-built cards** (`card.hidden`) rather than re-rendering the grid. Re-rendering would destroy and recreate every three.js `WebGLRenderer` on each toggle. `.product-card[hidden] { display: none }` in `css/style.css` is required for the hiding to work at all, since the card's own `display: grid` beats the UA `[hidden]` rule — same trap `.product-card__figure > img[hidden]` exists for below, just on a different element.

**A card's own 3D viewer is now built/disposed lazily as it scrolls in and out of range** (`js/main.js`'s `buildViewerFor`/`disposeViewerFor`, two `IntersectionObserver`s — see `client-scripts.md`), not once for the whole grid at page load. Past the browser's per-page WebGL context budget `buildThreeViewer()` returns `null` and that card just keeps showing its icon — retried the next time it scrolls back into the build observer's range, not permanent. Added after eagerly building every product's viewer at once — a `WebGLRenderer`, a full glTF fetch/decode, an HDRI PMREM build, each — stopped being safe once the catalog grew past a handful of products (at the time eight bones products, some tens of MB each before Draco compression, over 100MB combined; eleven and about 1MB now): real devices crashed outright rather than just running slowly. `.product-card__figure > img[hidden] { display: none }` is the matching fix for the icon a lazily-built viewer replaces — without it the "hidden" icon stayed laid out and pointer-interactive on top of the canvas, silently swallowing every drag meant for the model.

**The floating selection bar here specifically** slides in as a continuation of the hero's own wipe. The hero owns that geometry and publishes one number via `window.EmjiveHero`; `js/selection-bar.js` subscribes and measures its own travel (see `client-scripts.md`).

## `product.html` — product detail

Driven by the address: `/<slug>` (see "Addresses" above). The slug is unique across every series, so it alone identifies the product and its series — `product.js` resolves it against the active series first, then scans the rest (see `client-scripts.md`). The old `product.html?id=...` form (optionally with `?series=...`) still resolves — a bare `?id=` only to the first series that has that id, since ids are unique per series — and is rewritten to `/<slug>`.

The page is a **two-stage scroll show**, not a column of sections: `.product-stage#productStage` is a tall track holding one `position: sticky` pin (`.product-stage__pin`), so scrolling moves the show on, not the page, and the title bar stays where it is. `js/product-stages.js` turns the scroll into one eased number, `--to-specs`, plus `--browse-0` / `--browse-1` and `data-stage` (`presentation` / `specs`; `flow` on a screen under 560px tall), and `css/style.css` fades everything from them **in phases** — what a stage shows fades out, there is a blank, the next stage fades in; never a crossfade. The transition is two screens of scrolling (`--stage-step: 200svh`), each stage a hold of `--hold-ratio` (0.3) of that — and in a hold the show **browses**: it goes up, by the two bottom bars and 4rem in presentation, and in specs by whatever takes the end of its column 16rem clear of the Select bar. A scrim above and a three-layer blur under the title bar (`.product-detail__label-veil`: a `--bg` panel from the header to the inverted band, 1px / 3px / 6px backdrop blurs fading out below it, and, on Chromium only, a colour-split layer) keep what slides up under it from clashing with it. Scrolling on at the end of specs loops back to the start, through a fade to the page background.

1. **Presentation** — label bar (`name.category.metal`, thumbnail, price); the description (`#productDescription`, plain text under it); the carousel (3D model or photo slides, over the x-ray backdrop; drag sideways to scroll freely, or tap a slide to center it — no arrows, no rim click zones; a vertical drag scrolls the page, and the model only takes a drag inside a circle in its box; its loading mark is one loader shared by the whole strip); and the metal picker, a vertical stack of squares beside the model (it slides away with the strip and fades out when the visitor pages on to the photos, and stays away until the second stage brings it back). Two blurred **edge bands** (`.product-edge-veil`, `--right`; markup in `product.html`'s carousel frame, over the carousel and under the picker) soften what slides in toward the screen's edges, with the title bar's blur and chromatic aberration (see `styling.md`).
2. **Specs** — an inversion band (`#productScan`, passing *under* the title bar) travels up the screen, and the model turns from metal to a plain grey with its wireframe drawn over it (in the page's line colour; products without a `wireframe` asset just get the grey), inside its minimum box drawn as twelve faint edges (the faces are switched off for now), with the dimensions (in cm) labelled beside three of them, at the chosen size and lifted so its middle is on the first quarter of the screen, 8rem lower (a gap before it) — it rises past that and settles down into it as the specs arrive. Under it is one column (`.product-below`) of label | value rows in four clusters — one standard gap inside a cluster, one separation gap between them (`--gap-row`, `--gap-group`): **Size** (a slider, the field, and a "?" button at the field's top right corner that opens the size guide under it; the slider goes under 320px of width), then **Material** (the picker, in a row, with a dot on the active square and its name after the last) with the **printing technology** (the chosen metal's, from `data/series.json`) under it, then the **production cost** (a three-column chart: labels, bars as shares of the total, amounts; the total alone in the third column), then **shipping** and **returns** (static text); plus a screen-reader row of the dimensions. Whatever can't be worked out reads "TBD" ("n/a" for the dimensions).

Under 560px of height there is no room to pin a stage: `data-stage="flow"` lays the same pieces out as one plain column, everything shown, the model staying in metal.

Then, outside `<main>`, the blurred **Select / Add bar** (`#productSelectBar`, a fixed strip stacked on the selection bar — see below) and the size-selection modal (`#sizeModal`, opened by that bar).

`#productSelectBar` is a full-bleed blurred strip (`class="glass"`, see `styling.md`) floating on top of the selection bar and riding up with its drawer. It says "Select"; clicking it opens `#sizeModal` *above itself*, and it then says "Add" — dimmed until the size field holds an orderable value. It's static markup, `hidden` until `js/product.js` shows it, and steps aside while the Modify sheet is up or an Add's peek has the newest row out of the drawer. It replaced the in-page Select button and the selection bar's old "Add" mode.

`#sizeModal` is a bottom sheet resting on that bar. Its first row is the **Material** picker (the page's own, kept in step with it); then one typed field — `<label>` "Size", the input, the category's unit — with the size guide's "?" button at its top right corner; the guide itself is the sheet's last row, so the sheet grows upward when it opens, and the button, or a click anywhere else, closes it. There's no confirm button in it: the bar's "Add" is the confirm, and Enter in the field adds too (see `client-scripts.md`). The specs stage's own size row is the same field (plus the slider), and pre-fills this one.

Everything text/image-related starts empty or `hidden` and gets filled in by `js/product.js`.

## `launch-order.html` — order / checkout review

No title, no footer — straight from the header into the full selection, in `js/selection-page.js`. Toggles between `#selectionEmpty` (now "No selected item" plus a plain-text "Back to gallery" link, both centered) and `#selectionList`, in order:

1. **Item rows** (`#selectionItems`, a `<ul class="order-items">`) — a full-bleed dark panel breaking out to the true viewport edge (same `100vw`/`calc(50% - 50vw)` technique `.product-detail__label-bar` uses), padded top and bottom by the same amount so the panel bookends itself. Each row (built by `js/order-rows.js`, the same component as the floating bar's drawer) is one `<button>` showing thumb + name.category.metal.size (one continuous label, ellipsis-free — it fade-masks instead when it overflows) + price. **Tapping a row opens the Modify sheet** (`#modifyModal`, built by `js/modify-modal.js` — no markup for it here) straight away; there's no hover state and no in-row overlay. While the sheet is up:
   - a **drawer opens over the checkout bar** holding a copy of the tapped row, and the sheet rests on it — this page's version of the floating bar's drawer shrinking to the tapped row;
   - the checkout bar turns into the sheet's **Unselect | Save** strip. Unselect removes the item and slides the sheet away; the bar goes back to normal and the item's row stays in the list as an **Undo** line for 4 s — its content fades out and a band grows in across the left quarter, under an "Undo" button. Undo puts the item back where it was (the band sweeps the whole row and the content fades back in); left alone, the band regresses to the left edge and the row closes.

   A Save crossfades just the parts of the row that changed. The last item leaving keeps the list up with just its Undo line for those 4 s, then crossfades the whole list into the empty state; an Undo brings the item back in place.
2. **Shipping** (`.order-shipping`) — a plain, unlabeled pick list (`.order-shipping__option`, dot-indicator style borrowed from the size modal) between a couple of placeholder carriers; no real rates wired up yet.
3. **Terms** (`.order-terms`) — a sentence with a real link to `terms.html`, and a square tick-box (opacity-toggled, no border) at the row's right edge.

No running total on the page itself any more — it lives only in the fixed **checkout bar** (`#orderCheckoutBar`, a sibling of `<main>`, not `js/selection-bar.js` — this page has never carried that): a blurred strip (`class="glass"`: a 1px frost and two opposed sets of layered blurs, strong at the top and bottom edges and clear in the middle — pure CSS, see `styling.md` — no black-bg chrome) at `--selection-bar-height`, showing the total and a plain-text "Proceed to checkout" button, disabled until a shipping option is picked and terms are ticked. It's a stub — see `client-scripts.md`. The Modify sheet's strip and the drawer over the bar are both added by script (`js/modify-modal.js`, `js/selection-page.js`), not markup.

It's still the **only** page **without** the floating selection bar (`selection-bar.js` isn't in its script list — showing the full list *and* a floating summary of the same thing would be redundant) — but no longer the only one with a footer; that's gone entirely now.

## `archives.html`, `creation-process.html`, `terms.html` — empty shells

Header, a `.section-head` title block, correct meta tags, and a deliberately empty `.page-shell__body`. No designed content yet; each carries a comment naming what belongs there. Archives will render the series list from `data/series.json` via `EmjiveSeries.all()`/`.manifestHref()` — that's deferred, not missing by accident. `terms.html` follows the identical shell pattern but isn't in the header nav at all — it's reached only from `launch-order.html`'s terms-acceptance link, so the checkbox row there isn't pointing at a dead page.

## `series.html` — a series' design manifest

One page renders **any** series' manifest, from `data/series/<slug>/manifest.json`, selected by `?series=<slug>` — so adding a series never means adding a page. Also an empty shell: `js/series-page.js` wires the title, year and subtitle plus a real not-found state, and nothing else.

It's the one page that resolves its slug **without** the featured-series fallback the others use. Silently showing the wrong series' manifest would be worse than saying it doesn't exist, so `series.html` with no `?series=` is a not-found state, not the featured series.

## Page × script matrix

| | `scroll-memory.js` (head, blocking) | `series.js` (head, blocking) | `viewer-entry.js` (module) | `main.js` | `focus-trap.js` | `selection.js` | `carousel.js` | `order-rows.js` | `metal-picker.js` | `modify-modal.js` | `product.js` | `product-stages.js` | `selection-bar.js` | `selection-page.js` | `series-page.js` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `index.html` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | |
| `product.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `launch-order.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | |
| `archives.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | |
| `creation-process.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | |
| `terms.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | |
| `series.html` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | ✓ |

Every body script is `defer`red (`loader.js` and `series.js`, and `scroll-memory.js` on the homepage, are the only blocking ones — all in `<head>`), so they download in parallel and run in document order after the parser is done, behind `viewer-entry.js`. That document order is **not** the column order above on every page: on `index.html` and `product.html` it is `focus-trap`, `selection`, `carousel`, `order-rows`, `metal-picker`, `modify-modal`, `selection-bar`, then `main.js`, then (`product.html`) `product-stages.js` and `product.js`; on the other pages `main.js` is first (`series.html` loads `series-page.js` straight after it), then the same helpers, `selection-bar.js` last (`launch-order.html`: `selection-page.js` in its place). What must hold: `selection.js` before anything that touches it; `carousel.js` → `order-rows.js` → `metal-picker.js` → `modify-modal.js` in that order and ahead of the page script and `selection-bar.js`, which build on them; `order-rows.js` before `selection-bar.js`; `focus-trap.js` and `carousel.js` before `product.js`; `product-stages.js` before `product.js` (which mounts it).

`main.js` loads everywhere — it owns the header menu and the filter row, which render on every page, and its grid code no-ops when `#productGrid` isn't present. **Every page loads `three-viewer.js` and the Modify sheet's four scripts**, because every page can open the Modify sheet — from the floating bar's drawer, or from the order list — and the sheet's carousel shows the item's live 3D model. `focus-trap.js` is everywhere for the same reason.

**`js/loader.js` is on all seven pages** (blocking, in `<head>`, after the stylesheet — and after `scroll-memory.js` on `index.html` — and before `series.js`), and three pages opt into its **arrival loader** with `data-page-loader` on `<html>`: `index.html` (until the hero image has decoded), `product.html` (until the product is built) and `series.html` (until the manifest is in). The other four never wait on anything and don't. This replaced the static "Loading…" text: `index.html`'s grid starts empty, and `product.html`'s `#productDetailLoading` and `series.html`'s `#seriesManifestLoading` are now `hidden` paragraphs that only ever hold the not-found message (`js/product.js`/`js/series-page.js` unhide them). See `client-scripts.md`'s `js/loader.js` section and `styling.md`'s Loader section.

**Why `js/series.js` is blocking in `<head>`** (no `defer`, not a module): it has to define `window.EmjiveSeries` before `main.js` and the other deferred scripts run, and blocking starts the `series.json` fetch at head-parse time, which is what the hero's anti-flash story depends on. It doesn't disturb the `defer` contract below: a blocking `<head>` script runs before the entire deferred queue.

**Why `js/scroll-memory.js` is blocking too, and first** (`index.html` only — it's the one page whose height is built asynchronously): it reserves the previous visit's document height as a `min-height` on `body`, and that has to be in place before `<body>` is parsed, which rules out `defer`. It sits immediately after `<link rel="stylesheet">` so the `.emjive-restoring-scroll` rules it relies on are already parsed when it adds the class, and ahead of `series.js` because nothing it does depends on series data. Two extra requests' worth of head-blocking is the cost; both are tiny and cached. See `client-scripts.md`.

**Why every body script is `defer`red** (it used to be only `main.js` and `product.js`): a plain classic script blocks the parser, so with ten of them at the end of `<body>` the parser waited on each file in turn — a staggered chain of round trips that held `DOMContentLoaded`, the arrival loader, `product.js` and the 3D module back by about a second on a slow link (measured: the x-ray backdrop's request started at 4.3s, 1s of it this chain). Deferred scripts download in parallel and run, in document order, once parsing is done. They share that queue with the module `viewer-entry.js` — which comes first because its tag is in `<head>` — so `window.EmjiveLoadViewer` is defined before any of them runs. `modify-modal.js` only reads `window.EmjiveModelViewer` once a row has been tapped and the sheet has slid in, long after the module has run.

## Pointers

- Markup classes/ids → what they look like: `styling.md`
- What the scripts on each page actually do: `client-scripts.md`
- The JSON shape these pages read: `data.md`
- Step-by-step "how do I add a product / a series / a category": `procedures.md`
