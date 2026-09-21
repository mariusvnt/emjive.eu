# em·ji·ve — website

A static site for the em·ji·ve jewelry brand, organised into **series** —
each collection brings its own products, its own homepage hero animation,
and its own design manifest, with one field in `data/series.json` deciding
which one the homepage shows. A product grid that shows
each item as its own 3D model (glTF/GLB — click and drag to rotate, falls
back to a photo if no model is set yet). Clicking a product opens its
detail page — a carousel, a metal picker, a description, metal-dependent
specs, and a "Select size" flow that adds to a real, localStorage-backed
selection you can review on a dedicated order page — item rows you can
modify or unselect (with a few seconds to undo), a shipping pick, a terms
toggle, and a "Proceed to checkout" bar — with a floating selection bar
following you around everywhere else.

Plain HTML, CSS, and vanilla JavaScript — no framework. [Vite](https://vitejs.dev)
is used as the local dev server. 3D rendering is a custom [three.js](https://threejs.org)
scene with free, pole-crossing rotation (`js/three-viewer.js`) — Vite is
what resolves that module's `import "three"`, so it's required to run the
site locally, not optional. It's also required to *deploy* the site: a
plain static host serving the raw files can't resolve that import either,
so shipping this anywhere real means running `npm run build` first — see
"Deploying" below.

## Getting started

```bash
npm install
npm run dev
```

Then open the URL it prints. You can't just double-click `index.html` —
the product grid loads its data via `fetch`, which browsers block on
`file://`.

## Deploying

`npm run build` produces a real, portable `dist/` folder — a plain
`vite build` isn't enough on its own for this site, so `vite.config.js`
adds two things on top of Vite's defaults:

- **Multi-page entries** — Vite only treats `index.html` as a build entry
  by default; every other page is listed explicitly too, so all seven get
  their imports resolved. Add a line there for any new page.
- **A copy step for `js/`, `assets/`, `data/`, `series/`** — Vite's build can only
  see paths it can trace statically (`<script type="module">`,
  `url()` in CSS, that kind of thing). It can't bundle *classic*
  `<script src>` tags at all (so `js/main.js` etc. would silently vanish
  from the build without help), and it has no visibility into paths that
  only exist as runtime string data — a series' `products.json` icon/model
  paths, the hero bundle paths in `data/series.json`, or the HDRI path in
  `js/three-viewer.js`. Copying those four folders (`js/`, `assets/`,
  `data/`, `series/`) verbatim sidesteps tracing every case individually.

### The live setup: OVH, over SFTP

The site is served from the root of `emjive.eu` on OVH shared hosting.
Every push to `main` deploys it automatically: the GitHub Actions workflow
in `.github/workflows/deploy.yml` runs `npm ci` and `npm run build`, then
uploads the *contents* of `dist/` to the `www/` folder on the OVH hosting
over SFTP (port 22, via `lftp`), so `index.html` sits directly in `www/`.
It's also runnable by hand from the repo's Actions tab ("Run workflow").
After a deploy, hard-refresh (Ctrl+F5) to get past cached copies.

Every run re-uploads the whole build (about 20 MB) rather than diffing it.
The upload only adds and overwrites: a file that a later build no longer
produces (an old hashed asset, a removed image) stays on the server until
it's deleted by hand. Anything in `www/` the build never produced (an
`.htaccess`, say) is left alone. The server's host key is accepted on
connect rather than pinned.

**One-time setup:** the workflow reads three repository secrets (GitHub →
Settings → Secrets and variables → Actions). The names say FTP for
historical reasons; the values are the same ones OVH uses for SFTP:

| Secret | Value |
| --- | --- |
| `FTP_SERVER` | the FTP/SSH host from the OVH control panel, e.g. `ftp.cluster0XX.hosting.ovh.net` |
| `FTP_USERNAME` | the FTP login |
| `FTP_PASSWORD` | that login's password |

SFTP has to be enabled on the hosting (OVH control panel → the hosting's
"FTP - SSH" tab). Plain FTPS was tried first and OVH's server refuses it
(`500 This security scheme is not implemented`).

To deploy by hand instead (without GitHub), run `npm run build` and upload
the contents of `dist/` to `www/` with any FTP/SFTP client.

`vite.config.js` sets `base: "/"` to match. If the site ever goes into a
subfolder instead, set `base` to that subfolder's path (e.g. `"/shop/"`)
before building. Every page's `og:url`, `og:image` and `twitter:image` are
absolute `https://emjive.eu/...` URLs and would need updating on a domain
change.

The host is Linux, so filenames are **case-sensitive**: a path in
`products.json` that differs from the real filename only by case works on
Windows and 404s in production.

## Structure, at a glance

```text
index.html, product.html, launch-order.html    The shop
archives.html, creation-process.html, terms.html   Empty shells, design pending
series.html                                     Renders any series' design manifest
css/style.css                                   All shared styling, one file
js/                                             Vanilla JS + the three.js viewer module
data/series.json                                Series index + category vocabulary
data/series/<slug>/                             One series' products + manifest
series/<slug>/                                  One series' hero bundle (html/css/js)
assets/                                         Images, 3D models, fonts, HDRIs
scripts/auto-render.js                          Re-renders product icons/swatches
scene-tool.html, scripts/scene-tool-server.js   Camera/HDRI/shader tuning (npm run scene-tool)
json-tool.html, scripts/json-tool-server.js     Edit/add/remove series & products (npm run json-tool)
```

## Where to go next

**Adding a product, changing a metal, re-rendering icons, or any other
step-by-step task** — see [`dev-guidelines/procedures.md`](dev-guidelines/procedures.md).

**Understanding how the codebase is put together** — start at
[`CLAUDE.md`](CLAUDE.md), which indexes the rest of
[`dev-guidelines/`](dev-guidelines/): one doc per area of the site (pages,
styling, the client-side scripts, the data schema, the build/render
tooling, and the assets folder).

## Where the project stands

This is intentionally a starting skeleton so the aesthetic — colors, type,
layout, animations, real photography, real 3D models — can keep evolving
from here. Seven of the eight current products still have no photography,
no description, and no price, and every product's weight/composition is
still a placeholder waiting on real data. `launch-order.html`'s review page goes
all the way to a "Proceed to checkout" button, but there's still no real
payment step behind it — no backend exists yet to hand that off to (e.g. a
Stripe Checkout session); clicking it just says so.
