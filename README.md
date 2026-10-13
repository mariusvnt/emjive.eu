# em·ji·ve — website

A static site for the em·ji·ve jewelry brand, organised into **series** —
each collection brings its own products, its own homepage hero animation,
and its own design manifest, with one field in `data/series.json` deciding
which one the homepage shows. A homepage gallery that is either a stack of
the items' 3D models (glTF/GLB) rising out of the hero onto the x-ray hand —
floating, turning slowly, then falling into a pile when the first one is
tapped; tap one to turn it round — or a plain grid of photos for a quick
pick. Falls back to photos if no model is set yet. Clicking a product opens its
detail page — a three-stage scroll: a feed of photos and a description, the
3D model with a metal picker and, for some items, a choice of designs, then
its specs (a size you set by dragging a circle round the model, dimensions
and weight, cost) — and a "Select size" flow that adds to a real, localStorage-backed
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
the gallery loads its data via `fetch`, which browsers block on
`file://`.

The dev server runs over HTTPS with a self-signed certificate
(`@vitejs/plugin-basic-ssl`), so your browser will warn about it once. That's
deliberate: it was put there for iOS's motion-sensor permission, which only
secure pages can ask, and it stays so a phone on the same Wi-Fi gets a secure
context like the real site: `https://<your-ip>:5173/` (`npm run dev -- --host`).

## Deploying

`npm run build` produces a real, portable `dist/` folder — a plain
`vite build` isn't enough on its own for this site, so `vite.config.js`
adds a few things on top of Vite's defaults:

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
  The copied `js/*.js` and each hero's `hero.js`/`hero.css` are minified in
  place (same names — nothing references a hash for them).
- **Head fixes** — Vite inlines the `series.json` preload as a `data:` URL
  and moves the stylesheet behind the blocking scripts; a post plugin puts
  both back. `sitemap.xml` is generated from the catalog data, and so is
  one page per item (`dist/<slug>.html`, with its own title, canonical and
  social tags) — that is how an item gets an address like `/furcula`.
- **`public/`** — copied to the root of `dist/` as-is: `.htaccess` (HTTPS,
  clean-URL rewrites, compression, cache and security headers), `robots.txt`, the favicons.

`npm run verify` is everything a change has to pass: ESLint, the data-file
schema check (including exact-case asset paths), a production build, and
assertions about the built output (`scripts/check-dist.js`). CI runs the same
thing on every pull request and before every deploy.

### The live setup: OVH, over SFTP

The site is served from the root of `emjive.eu` on OVH shared hosting.
Every push to `main` deploys it automatically: the GitHub Actions workflow
in `.github/workflows/deploy.yml` first runs `.github/workflows/verify.yml`
(the checks above), then uploads the *contents* of the `dist/` it built to the
`www/` folder on the OVH hosting over SFTP (port 22, via `lftp`), so
`index.html` sits directly in `www/`. It's also runnable by hand from the
repo's Actions tab ("Run workflow"). The HTML, scripts and JSON are served
with `no-cache` (see `public/.htaccess`), so a normal reload picks up a deploy.

Every run re-uploads the whole build (about 15 MB) rather than diffing it,
then makes `www/` an **exact mirror** of `dist/`: anything on the server
that the build doesn't produce (a removed image) is deleted, after the new
files are up so the site is never missing pages mid-deploy. The exception is
the previous releases' content-hashed bundles directly under `assets/`
(`three-viewer-<hash>.js`, `style-<hash>.css`, hashed fonts): they are kept,
so a visitor whose browser still holds the old HTML doesn't 404 on a bundle
that was just deleted. Clear them now and then (say monthly) by running the
workflow by hand with **prune_old_assets** ticked. Files put on the server by
hand (an `.htaccess`, a `robots.txt`) are wiped — they live in `public/`.
The job refuses to run if `dist/index.html` is missing, so a broken build
can't wipe the site.

To see what a run would do before it does it, use the Actions tab → "Deploy
to OVH (SFTP)" → "Run workflow" with **dry_run** ticked. It builds, connects,
and logs every file it would upload or delete (lftp prints "Removing old
file" followed by "Transferring file" for every file it merely overwrites, so
only a "Removing" with no matching "Transferring" is a real deletion) without
changing anything on the server.

The server's SSH host keys are pinned in the workflow (`SFTP_HOST_KEYS`), so
the password is only ever sent to the real OVH server; a different key stops
the deploy with "Host key verification failed" before any login. If OVH ever
rotates its keys or moves the hosting, that's the error you'll see — re-scan
with `ssh-keyscan -p 22 -t rsa,ecdsa,ed25519 <FTP_SERVER>` (and check the
fingerprints against the OVH control panel if it shows them) and replace the
two key lines in the workflow.

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
Windows and 404s in production. `npm run validate-data` checks every path in
`data/` with the exact case on disk.

### Production checklist

After the first deploy that includes `public/.htaccess`, confirm each part of
it actually applied on the OVH plan (a missing Apache module just skips its
block, silently):

- `curl -I http://emjive.eu/` redirects to `https://emjive.eu/` (and
  `www.` to the apex).
- `curl -I https://emjive.eu/js/main.js` shows `Cache-Control: no-cache` and
  `Content-Encoding: gzip`; a hashed `/assets/style-*.css` shows
  `max-age=31536000, immutable`; an image or model (e.g.
  `/assets/series/bones/hero/hand_xray.webp`) shows `max-age=604800,
  stale-while-revalidate=86400`.
- `curl -I https://emjive.eu/assets/hdri/studio_kontrast_04_1k.hdr` and a
  `.glb` / `.wasm` return a sensible `Content-Type` and are compressed.
- `https://emjive.eu/some/missing/path` shows the branded 404 page.
- `/robots.txt` and `/sitemap.xml` load; `/favicon.ico` is not a 404.
- **Clean URLs** (the rewrite block in `public/.htaccess`; Apache is the one
  place they can't be tried before deploy): `/gallery`, `/`, `/archives`,
  `/furcula` return `200`; `curl -I https://emjive.eu/index.html` is a `301` to
  `/gallery`; `/archives.html` a `301` to `/archives`; `/archives/` a `301` to
  `/archives`; `/product.html?id=01` is a `200` (the page then moves itself to
  `/furcula`); `/nope` is the branded 404, not a soft 200.
- The security headers are present (`curl -I`; securityheaders.com).
  `Content-Security-Policy-Report-Only` should log **nothing** in the browser
  console on any page — when that is true, rename the header to
  `Content-Security-Policy` in `public/.htaccess` to enforce it. Raise the
  `Strict-Transport-Security` max-age from 300 once HTTPS has been stable.
- Run Lighthouse (mobile) on `/gallery` and a product page (`/furcula`).
- Remove the `noindex` meta tag from `archives.html`, `creation-process.html`,
  `terms.html` and `series.html` (and add them to `sitemap.xml` in
  `vite.config.js`, and to `NOINDEX`/the sitemap check in
  `scripts/check-dist.js`) when they get real content.

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
scripts/auto-render.js                          Re-renders product icons/swatches (+ the generated image versions)
scripts/make-image-variants.js                  The desktop/smartphone, low/high-res versions of the big images
scripts/split-models.js                         One Blender export of every model, cut into the catalog's model + wireframe + print (STL) files (npm run split-models)
scripts/measure-models.js                       Each model's and print model's volume + size, written into products.json (npm run measure-models)
scripts/stl.js                                  Reads/cuts/writes binary STLs (the print models, which are not in git)
scripts/slugs.js                                An item's address (/<name>) and the names it may not take
scene-tool.html, scripts/scene-tool-server.js   Camera/HDRI/swatch/shader tuning (npm run scene-tool)
json-tool.html, scripts/json-tool-server.js     Edit/add/remove series & products (npm run json-tool)
loader-test.html, js/loader.js                  Logo loading animation + its endless-loop review page
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
from here. Eight of the nine current products still have no photography,
no description, and no selling price. (Each product's weight, size and an
estimated production cost are real: they're derived from the measured volume
of the piece as it is printed — its STL, kept out of git — see
`npm run measure-models` in the dev-guidelines.)
`launch-order.html`'s review page goes
all the way to a "Proceed to checkout" button, but there's still no real
payment step behind it — no backend exists yet to hand that off to (e.g. a
Stripe Checkout session); clicking it just says so.
