# Code guide

How the code is put together and why, across HTML, JavaScript and CSS, plus the build and the deploy. Where each file is and what it exposes is in [index.md](index.md) (generated from the code). What must always hold is in [rules.md](rules.md). The catalog, its assets and the tools that make them are in [item-guide.md](item-guide.md).

## 1. The shape of the site

A static site: HTML pages at the repo root, one stylesheet, vanilla JavaScript and JSON data fetched by the pages themselves. There is no backend and no framework. The site is a catalog with a cart, and everything a visitor does fits in the browser: the selection lives in `localStorage`, and the order page stops at a "Proceed to checkout" button with nothing behind it yet.

**Vite is required, both to run the site and to ship it.** The 3D layer is made of ES modules that import `three` from npm, and only a bundler resolves those imports. Everything else is classic scripts that Vite can't trace, so `vite.config.js` copies them across as they are. A plain static host serving the raw repo would break at the first `import "three"`, which is why what ships is `dist/`, never the repo.

**Every page stays at the repo root.** The pages fetch `data/series.json` with a relative path, every path inside the data is relative to the root, and every page links `css/`, `js/` and `assets/` relatively. A page one folder down would resolve all of them against the wrong prefix, silently. The addresses are flat for the same reason: see below.

## 2. Pages and addresses

**One page per kind, never one per item or per series.**

- `index.html` shows any series' gallery.
- `product.html` shows any item.
- `series.html` shows any series' manifest.
- `launch-order.html` is the selection's checkout review.

Adding a product or a series never adds a page. Then there are the shells (`archives`, `creation-process`, `terms`), the not-found page, and three dev-only pages (`json-tool`, `scene-tool`, `loader-test`), which are kept out of the build.

**Clean, flat addresses.** `/` for the gallery, `/archives`, and `/<item>` for every item, where the item's address is its name made URL-safe. No address shows a file name or an `?id=`. The address is flat (no series, no folder) because of the relative links above, which is also why a trailing slash is redirected away. In production the server does the mapping (`public/.htaccess`). In dev and preview, a small middleware in `vite.config.js` does the same, and the two must agree. Every redirect names the full canonical address, so search engines see exactly one URL per page. The gallery is the root itself, not a `/gallery` page, because Google reads a site's name only from the domain root; `/gallery` redirects there.

**One built page per item.** The pages render their content in JavaScript, so crawlers and link previews would only ever see the template. The build therefore writes `dist/<item>.html` for every item: the built `product.html` with that item's own title, description, canonical address and social tags, its name and description already in the markup, schema.org Product data (with its price span), and a link-preview picture drawn at build time. The template itself doesn't ship: an item-less page would only be an indexable "not found", so `/product` is a real 404. The gallery gets the same treatment: the build writes the featured series' grid into its markup (each item's picture, name linked to its page, and facts), which the live grid replaces at once without the page ever shrinking, and adds the site's Organization and WebSite data with a square logo, for the site name and logo in search results. Every other page has its own static title, `h1`, canonical and social tags. Pages that aren't meant to be indexed yet (the shells, the per-visitor order page) are `noindex`, and `check-dist` enforces exactly that set.

**One shared header.** Every page opens with the same header and nav. The category filter row is rendered from the active series' data, never written in the markup, because each series declares its own categories.

**The homepage decides what the visitor lands on before `<body>` is parsed.**

- **The hero.** It plays on every landing from outside the site and never again within a visit.
- **The view.** The wheel or the grid, remembered within the visit. A switch happens under a veil that lifts only once the page holds still (a phone settles its bars after the jump), the wheel laid out last against the hand where it then is, so nothing moves into place in view.
- **Back and reload.** They rebuild exactly what was left, mid-hero included.
  Being on the wheel is remembered as such, not as an offset: the page's length follows the phone's browser bars, so the same offset can fall short of the wheel. iOS Safari can show a page back from its back-forward cache at the top and then reload it, so a page coming back saves nothing until it is touched. The gallery stays hidden until the restored page holds still, so what settles after doesn't show.

All of this is decided in the `<head>` (`js/scroll-memory.js`) because the page's height is built asynchronously (series index, hero bundle, products), and native scroll restoration would clamp to the top. CSS keys on the decision at first paint, so nothing flashes and then collapses.

**The series hero is a swappable bundle.** `index.html` carries empty slots, and the featured series' hero (`series/<slug>/`: an HTML fragment of `<template>`s, a stylesheet and a script) is cloned into them at runtime. That lets each collection bring its own hero animation without the page changing. The hero's script is injected by a runtime string path, so Vite never sees it. It may not use bare imports, and it must be inert until called so the fragment, styles and script can all load in parallel. Two path conventions live side by side in a bundle: the fragment's image paths resolve against the page, the stylesheet's `url()`s against the stylesheet.

**The gallery has two views of the same products** (the code calls the wheel `stack`):

- **The wheel.** After the hero, the camera pulls back from the x-ray hand to a circle of 3D models round its wrist, the rings on the hand sliding to their places on it. Those rings are the wheel's own models, drawn in an x-ray look so they read as part of the radiograph, and they turn to metal as they leave the hand. The circle is then a plate the visitor turns to bring an item to the top. A scroll that stops short of the wheel still lands on it, with no snap: over the entrance's last stretch the shown progress runs ahead of the scroll, moving only when the scroll moves and in its direction, more during a fling's inertia than under a finger, so the help is never seen as a motion of its own.
- **The grid.** Each item is two tiles, its pictures over its facts, two items side by side on a phone, no 3D: for a quick pick.

Filtering hides what is already built and never rebuilds it (see rules.md).

**One metal for the whole gallery.** A material picker at the gallery's top left, in both views, shows every item in one metal. The choice is the visitor's, kept for the visit (not across visits, so the site always opens on the items' default metal, steel) and owned by `EmjiveSeries`, which knows the metals offered, so an item's page opens on it, priced in it as a pick. Until the visitor picks, each item shows its own default metal.

**The product page is a two-stage scroll show**: inspiration (description and photos), then design (the model, its configuration under it, then the information). It's a tall track holding one sticky stage, so scrolling moves the show on, not the page. `js/product-stages.js` turns the scroll into a few eased numbers, and CSS fades everything from them. A screen too short to pin a stage gets the same pieces as one plain column.

**Design configures the item with a row of dials, so a phone shows the model and its options on one screen.** Shape (when there's more than one design), material and size are each a round button under the model (`js/option-dial.js`), the same dials the Modify sheet uses. Shape and material open a disc over layered blurs, cut into one section per option, each always in the same place, and pointing into a section picks it live: hovering on a desktop, a tap or a held finger slid across on a phone. The size opens a vertical slider instead.

**Plan views tell the size on the model itself.** Two icons at the model box's corner turn the model to its front or side view and hold it there until a drag or the reset; the view's dimensions are laid over the live model, measured from the model's own silhouette at the chosen size. Nothing about their place is guessed: the viewer reports where the view's centre lands on its canvas and how large a millimetre is at the model's current scale. A dimension is a straight-on (orthographic) measure while the live camera has perspective, which would show the near edges larger; so the turn to a view flattens the camera as a dolly zoom (it backs far off while the field of view narrows to match, the target's plane keeping its scale), done around the draw only so the controls never see the moved camera, and undone on the way back or under a drag. Solid lines on the front (x and y) and the side (z) mark the model's length, width and depth between the silhouette's two farthest points along each axis: the line sits at one of those two points and, when its other end is off the model, a dashed line reaches on to the point it stands for. Which point, and where along it, is a choice between near-equal candidates that a changing silhouette keeps swapping, so the lines don't follow a size change: they fade out as it starts and back in, measured afresh, once the model holds still, rather than jitter through the glide. Each is labelled with its letter and its length in cm at the chosen size. A model whose finger runs along its own x rather than z says so (`"finger-axis": "x"`) and `planFrame` turns the views to match. The views' geometry (which axes each view measures, how they are cropped) is computed in one place, `EmjiveHelpers.planFrame`, that the render tool, the page and the live viewer all read, so a dimension and the model's turn to it can't disagree.

**Add shows the item before it goes in the selection**: the bar's Add opens a review of the shape, material and size, and Confirm adds it. The review can still change them, through the page's own handlers so the dials and model follow: shape and material from a short list of the other options, the size typed. The lists' chevrons line up in one column fitted to the longest option when the sheet opens, so they hold still while options change.

**The information follows the configuration, always shown**: label | value rows in clusters (the material, the price breakdown, shipping and returns) on two columns they all share. The design stretch is as long as scrolling the last of it clear of the bottom bars takes.

**An item is one configuration with a count.** Adding a piece already in the selection, or modifying one into another's configuration, merges them, so the selection never lists the same piece twice.

**A selection row is edited in place first.** A tap turns the row into its own controls (the count, Modify, a close), so changing how many, or removing one by counting down to zero, never opens a sheet. Its Undo is the row itself, held for a moment.

**The Modify sheet is on every page**, opened from a row's Modify in the floating selection bar's drawer or in the order list, and it shows the item's live 3D model over the product page's dials. That's why every page loads the sheet's scripts and the size finder, and can load the 3D chunk. Its back and Save sit on the row it rests on, whose band they take over, rather than on the page's bar, which stays as it was: the row turns into the sheet's controls and back with only the labels changing.

## 3. Scripts

**Two kinds.**

- **Classic scripts**: almost all of `js/`, and each series' `hero.js`. No bundler is needed to ship them: they are copied verbatim and minified in place. They talk to each other through `window.Emjive*` globals, each set by one file. The index lists who sets and who reads each one, and `eslint.config.mjs` declares them, so a typo is caught.
- **ES modules: the 3D layer** (`three-viewer.js`, `stack-scene.js`, the HDR worker and the small `viewer-entry.js` that loads them). Vite bundles these into hashed chunks.

**Load order is a contract.**

- Four scripts block in the `<head>`, each for a reason:
  - `helpers.js`, first on every page: the shared helpers every other script uses, the head ones included.
  - `scroll-memory.js`, homepage only, next: the landing decision and the reserved height must be in place before the body is parsed.
  - `loader.js`: the arrival cover must be up before the body is parsed, and every script uses it.
  - `series.js`: `window.EmjiveSeries` must exist before anything runs, and starting the series fetch at head-parse time is what the hero's no-flash arrival relies on.
- Everything else is `defer`red, so it downloads in parallel and runs in document order. Where one script builds on another, that order matters. The index shows each page's script list in order.

**Everything starts from the series index.** `EmjiveSeries.ready` resolves the active series (the `?series=` in the address, or the featured one), and every page script starts from it rather than fetching data itself. Product lists are fetched once per series and shared. On the pages that need them first, they are requested the moment the index resolves.

**Three ways scripts talk.**

- **Globals** for APIs.
- **A plain function registry** for the hero's scroll progress (`EmjiveHero`): it publishes once per animation frame, and a registry allocates nothing per publish. The same registry carries the hero's rarer layout changes, which the wheel re-measures on instead of polling.
- **`CustomEvent`s on `window`** for state changes several scripts react to (the selection changing, the Modify sheet opening and closing).

The index lists the event names and storage keys.

**Shared code lives in one place, one per runtime.** The small utilities several scripts need (building elements, easing, waiting on a frame or a transition, web storage, slider keys, a product's pictures) are in `js/helpers.js`, and the Node tooling's (paths, catalog lookups, the dev servers' plumbing, the glTF reader) in `scripts/helpers.js`. There are two because neither runtime can load the other's. The 3D modules read the browser one too, which is why the dev pages and the render harness that load them include it.

**Failure is a designed state, not an exception.**

- Every "didn't load" or "doesn't exist" message is one component (`EmjiveMessage`).
- Every 3D model has a picture to fall back to: no WebGL, a failed chunk, a lost context, reduced motion.
- A page that waits for its first paint (the homepage, the item page, the series page) holds an arrival loader until the pictures that paint is made of have decoded, so nothing pops in after the reveal.

## 4. The 3D layer

**One viewer factory for everything that draws a model.** `js/three-viewer.js` builds every viewer on the site, and the tools render through it: `auto-render` loads the real module in headless Chrome, and `scene-tool` previews and tunes through it. A render or a tuned value therefore can't drift from what the site shows. The model's own materials are ignored, and every mesh gets a metal from `data/series.json`'s `metal-shaders`, which is why the model optimizer strips textures. The module stays series-unaware all the same: on the site it reads the shaders from the loaded index, and the tools, which don't load it, hand them over.

**One studio for every scene, matched to Blender.** The models are shot in a Blender studio, and every scene reproduces it the same way whatever the HDRI: Blender's plain AgX view (no look), a sun, a blur of the HDRI and a reflection detail, all set once in `data/series.json` and tuned in `scene-tool`. The HDRI only supplies what the metal reflects. Blender forms its image through a 3D lookup table that material shaders can't hold, so the colour is three.js's AgX frame with Blender's measured grey response swapped in. The blur and the detail answer the same problem: three.js reads a reflection from a level of the environment map as coarse as the metal's roughness allows, which on polished metal shows that level's texels. Reading finer levels removes the grid, and blurring the HDRI gives back the softness the coarse level carried.

**A metal change fades, on the site.** Each material's colour, metalness and roughness are eased to the new metal's rather than the material being swapped: with the colours linear, that is close to a crossfade of the two renders, it holds on a turning model, and nothing recompiles. The pictures standing in for a model crossfade too, a copy of the old one fading out over the new, since a model's silhouette is the same in every metal. The tools ask for the metal at once, so a render never catches a fade.

**Free rotation.** The viewers use `TrackballControls`, so a model can be turned over its poles. The extra code around it handles what that freedom costs: a drift that levels "up" so it doesn't flip at a pole, spherical easing back to the default pose, and inertia that brakes cleanly.

**Lazy.** The pages load only `viewer-entry.js` up front, and three.js plus the viewer (by far the largest download) come after the first paint. A page that never draws a model never fetches it unless a Modify sheet opens. The item page starts its model, HDRI and chunk itself once its first paint is in: hinting them in the `<head>` was measured to delay the largest picture.

**The size is a shift and a stretch, done in the shader.** A ring changes size as it will be printed (item-guide.md): every point moves away from the finger axis and the ring stretches along it, never a uniform scale. The viewer does it in the vertex shader, since the geometry's JavaScript copy is gone after the first draw, and bakes each mesh's own transform into its geometry at load, so the axis is the same in every mesh. The plan views live in the viewer too: the item page measures its dimensions off the live model's silhouette, at the chosen size. The chosen size holds in every stage, so in design the model's box leaves room around the model for the largest size, the model drawn at its own share of the box.

**The wheel draws every model in one canvas.** `js/stack-scene.js` gives the wheel one WebGL context and one environment map for all the models, and the Modify sheet has the only other renderer on the homepage. There are at most two at a time, and the wheel holds still while the sheet is open. Its drawing (a flat camera, the HDRI fixed on the screen) differs from a viewer's, which is why the wheel, and the rings on the hand it draws, have posters rendered its own way.

**iOS Safari's memory limit shapes the whole layer.** Safari ends a tab that uses too much memory, and the designs below follow from that:

- **Low-poly models.** A small file can still decode to a lot of geometry.
- **Geometry freed after the first draw.** The JavaScript copy is released once the GPU holds its own.
- **One shared Draco loader.** A loader per model is a known cause of Draco failing on iOS, and its idle workers are ended.
- **Fixed pixel ratios.** Every canvas draws at the same density whatever the screen: supersampled on low-density screens, which also tames bright highlights on metal, and capped on phones, since the canvas budget is page-wide.
- **Disposal that is idempotent and survives late async loads.** A model arriving after teardown is freed on the spot.

`?mem=1` on any address shows the live counters, since a phone can't be inspected from the development machine.

**Render on demand.** A viewer draws only when something changed, and its loop stops once nothing moves (the wheel's too), so an idle page asks nothing of a phone's CPU; any change restarts it. A browser may throw the drawing buffer away without losing the context (iOS does, on backgrounding and back-forward restores), so there are explicit repaint triggers for those moments.

**No external requests.** The Draco decoder and the fonts are self-hosted, and the HDRI is decoded in a worker, off the main thread.

## 5. Styling

**One stylesheet, plain CSS**, in sections (listed in the index). A series' `hero.css` is injected after it and wins ties.

**Tokens on `:root`, picked by role** (see rules.md). Most dimensions and timings are tokens too, so a value is changed in one place.

**Phones are the baseline, with one breakpoint (640px).** The invert bands are the one exception: they grow steadily from the breakpoint to a desktop width instead of jumping. The phone query that picks image versions is a separate, narrower test (narrow *and* tall), because it's about what part of a picture the screen can show.

**Patterns that recur.** Recognising them saves re-deriving them:

- bands that invert what passes under them (`backdrop-filter: invert`);
- full-bleed breakouts from the centred column;
- `0fr → 1fr` grid rows to animate to an automatic height;
- selection dots that are always laid out and only toggled, so nothing shifts;
- mask fades instead of ellipses;
- blurred "glass" bars.

Wherever a rule sets `display`, the `hidden` attribute needs a matching `[hidden]` rule: the author rule beats the browser's.

**Accessibility is structural.**

- One `h1` and a distinct `<title>` per page, and a skip link to `<main>`.
- One `:focus-visible` ring for the whole site. It positions its element, so already-positioned controls keep their own position.
- The bottom sheets trap focus and lock the page.
- The wheel is a picture, so its keyboard and screen-reader path is a hidden list of links. A keyboard on that list drives the wheel itself, so the focus can be seen.
- Closed panels leave the tab order, and status changes go through live regions.
- Reduced motion is honoured in three places that don't know about each other: the stylesheet, the viewers and the loader.

## 6. Responsive images

The big pictures (the hero, the item x-rays) come in up to four versions: desktop or phone, low or high resolution. The hero's phone versions are **cropped** to the middle of the picture, because a phone only ever shows the middle; the x-rays' are uncropped, since the item page fits the x-ray to the screen. The crop is also why they are chosen in JavaScript from the phone query and not with `srcset`/`sizes`: `sizes` can't say "most of this is off-canvas". Low resolution comes first, and high resolution is swapped in once the page is idle. The crop fraction and the query live in several files (the image script, the stylesheets, the loader, the Node helpers), and `validate-data` checks that they agree.

## 7. Build, verify, deploy

**The build** (`vite.config.js`) makes a multi-page Vite build deployable:

- Every page is an entry, so a new page needs adding there.
- What Vite can't trace (classic scripts, and every path that only exists as data) is copied verbatim and the scripts are minified. Module sources, fonts that Vite already re-emits, the HDRIs no series uses, and print models are left out.
- Two things Vite does to every `<head>` are undone: it inlines the series index as `data:` and moves the stylesheet.
- Preload hints are added for the featured series.
- It writes the sitemap and the per-item pages and pictures.

**`npm run verify`** is the gate (see rules.md), in this order:

1. **Lint.** Typos and dead code across the shared globals; not a style gate.
2. **The docs index check.**
3. **Data validation.** The schemas, then what a schema can't check: every path exists with its exact case (the host is Linux, so case matters where Windows doesn't care), measured geometry matches its file, the image versions exist, mirrored constants agree.
4. **The build.**
5. **Assertions on the built output** (`check-dist`): nothing private shipped, every link resolves, the head order, the clean-URL rules, the per-item pages, the sitemap.

**CI.** `.github/workflows/verify.yml` runs `verify` (plus an audit of runtime dependencies) on every pull request. `deploy.yml` runs on every push to `main`: it calls `verify` and ships the very `dist/` it built.

**Hosting: OVH shared hosting (Apache), at the root of `emjive.eu`.**

`public/.htaccess` is the host's whole configuration:

- **Redirects:** HTTPS and a single host name.
- **The clean-URL rules.**
- **MIME types and compression.**
- **Caching.** Hashed bundles are cached forever. Fixed-name HTML, scripts and JSON are revalidated on every load, which is the cache-busting for files that keep their names. Images and models get a short max-age for now, while the art still changes often.
- **Security headers,** with the Content Security Policy still report-only.

Every block sits in an `<IfModule>`, so a module missing on the plan skips its block silently: confirm each part with `curl -I` after a deploy that changes it. Anything placed on the server by hand is wiped by the next deploy, so it lives in `public/`.

**The deploy** mirrors `dist/` to `www/` on the host over SFTP (`lftp`) in two passes: first upload everything, then delete what the build no longer produces. The previous releases' hashed bundles are kept back so that a visitor holding cached HTML doesn't 404 on a bundle that was just deleted. Clear them now and then by running the workflow by hand with **prune_old_assets**. **dry_run** lists what a run would upload and delete without touching the server. The job refuses to run without a built `dist/index.html`, so a broken build can't wipe the site. The server's SSH host keys are pinned in the workflow, so the password only ever goes to the real server. If OVH rotates its keys, the deploy stops with "Host key verification failed": re-scan with `ssh-keyscan` and replace the keys.

One-time setup: SFTP enabled on the hosting (the "FTP - SSH" tab), and three repository secrets (Settings → Secrets and variables → Actions). The names say FTP, but the values are the SFTP ones:

| Secret | Value |
| --- | --- |
| `FTP_SERVER` | the FTP/SSH host from the OVH control panel |
| `FTP_USERNAME` | the FTP login |
| `FTP_PASSWORD` | that login's password |

To deploy without GitHub, upload the contents of a fresh `dist/` to `www/` with any SFTP client. Moving the site into a subfolder means changing `base` in `vite.config.js`. A new domain means changing the absolute `https://emjive.eu/…` addresses in every page's social tags and the build's site origin.

**After a deploy that touches the host setup, check by hand** (only the live server proves these):

- http → https and www → apex redirects;
- the cache and compression headers on a fixed-name script, a hashed bundle and a model;
- the branded 404 for a missing path;
- `/robots.txt`, `/sitemap.xml` and `/favicon.ico`;
- clean URLs: `/`, `/archives` and an item answer `200`, `/gallery`, `/index.html` and `/archives.html` redirect, an unknown name is a real 404;
- the security headers.

When the CSP report-only header logs nothing on any page, switch it to enforcing. Raise the HSTS max-age once HTTPS has been stable.

## 8. Not built yet

- **The content pages are empty shells.** `archives`, `creation-process`, `terms` and `series` have real addresses, meta tags and styling hooks, but no designed content. The archives page is meant to list every series from `data/series.json`, which already holds everything it needs. When a shell gets content, drop its `noindex`, add it to the sitemap and to `check-dist`'s expectations.
- **There is no checkout.** "Proceed to checkout" (once the terms are accepted) only shows a notice saying so. A real payment step needs a backend (e.g. a Stripe Checkout session).
- **There is no contact form.** `js/main.js` keeps a guarded handler that does nothing until a page has `#contactForm`. A real form needs a form backend.
