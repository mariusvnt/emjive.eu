# Rules

Every rule that must hold in this repo, process and code alike, and the one place each is written down. The guides explain the reasoning; they don't restate the rules.

## Working

- **Never start a dev server to judge how something looks.** That's the user's call: ask them to check it. The exception is an objective check that is hard to make by hand (a text value, a load or error state, a measurement such as a bounding box, a computed style, a timing, or whether an element exists), which may be run in a headless browser.
- **`npm run verify` passes before anything is pushed.** It is the same gate CI runs before every deploy.
- **Never attribute commits to the coding agent.** No `Co-Authored-By` trailer, no "Generated with…" line, and no mention of an AI or agent anywhere in a commit message or a PR description, however much of the change the agent wrote.
- **Ask before committing print models (`*.stl`).** They are kept out of git (`.gitignore`) and out of the build on purpose, because they are large and only the printer needs them.

## Data and assets

- **Never run a formatter over `data/**/*.json`.** The files are hand-aligned, and every tool edits them by text surgery to keep that alignment.
- **Never edit a generated file by hand.** That means the renders (icons, fallback images, wheel posters, top shots, metal swatches), the image versions (`_lo`, `_m`, `_m_lo`, `_128`), a product's `geometry`, `public/` favicons and `dev-guidelines/index.md`. Change the source and re-run the tool that writes the file ([item-guide.md](item-guide.md) says which).
- **Re-run `npm run measure-models` after any change to a `.glb` or an `.stl`**, a re-optimization included: `geometry` is pinned to the file's hash.
- **Paths in data and hero fragments are repo-root-relative with no leading slash**, and every page stays at the repo root. The one exception is `url()` in a hero's CSS, which resolves against the CSS file.
- **A product's name is its address.** It must be unique across every series and must not be a reserved name (a page, a top-level file or folder). Renaming a product changes its address.
- **A product's asset folder is `<name>_<category>`.** The tools build that path; they don't read it.

## Code

- **Code meant for repeated or global use goes in the helper file, never written locally.** That is `js/helpers.js` (`window.EmjiveHelpers`) for the browser, the 3D modules and the dev pages included, and `scripts/helpers.js` for the Node tooling and `vite.config.js`. When a second file needs something another file defines for itself, move it to the helper file instead of copying it. `js/helpers.js` loads first on every page (`check-dist` checks), so no script guards it. Two things stay out of the helper files. An API owned by a module with its own state stays with that module: the selection, the series, the loader, the 3D `toolkit` in `js/three-viewer.js`, the JSON text surgery in `scripts/json-tool-blocks.js`. A value needed where the helper file can't reach (CSS, or both the browser and Node) is mirrored instead, under the rule below.
- **A series' `hero.js` has no side effects when it loads, and never uses a bare import specifier.** It only assigns `window.EmjiveSeriesHero`, and Vite never sees it.
- **Filtering hides what is already built; it never rebuilds it.** Rebuilding would recreate WebGL contexts.
- **Never change `js/stack-scene.js` to match the viewers.** The wheel's drawing is the reference, and the wheel posters follow it.
- **Pick colour tokens by role.** A light background is `--bg` (never `--white`, which is a text colour). A dark background is `--black-bg`. Dark text is `--black`, and light text on dark is `--white`.
- **Never put a `url()` behind a `var()` on anything the product page's scroll restyles.** Set the property directly. Also, never measure the screen's height with `window.innerHeight` on the product page: use `EmjiveProductStages.screenPx()`.
- **Gate hover styles with `@media (hover: hover)`.**
- **Reduced motion uses `0.01ms`, never `0s`.** A zero-length transition fires no `transitionend`, and script waits on it.
- **A value written in several files changes in all of them at once.** `validate-data` checks the phone query, the crop fractions and the slug rule across their copies. A new metal has to be added in every place [item-guide.md](item-guide.md) lists, because not all of them are checked.

## Comments

Comments in code (JS, CSS, HTML, scripts, config) are kept to the minimum that is useful:

- **What, only for structure.** Every file opens with a header comment: its first sentence is the file's line in the generated index, so it says plainly what the file is. Beyond that: section markers, and a line on a function or constant whose name doesn't say enough. No comment that restates the code.
- **Why, only when the code can't show it.** A browser bug or quirk being worked around, an ordering or timing constraint, a value that must stay in step with another file, a trade-off that would otherwise look like a mistake. A sentence or two, not an essay.
- **Never about past versions.** No "used to", "replaced", "the old…" or "previously", and no account of what was tried and failed or how a bug was found. History belongs in commit messages.
- **Local detail lives here, not in the docs.** A constraint that applies to one spot is a comment at that spot; the guides may point to the file.
- **Kept true in the same pass.** Changing code means fixing or deleting the comments it invalidates right then. A wrong comment is worse than none.

## Docs

- **What goes where.**
  - [index.md](index.md) is generated: where everything is.
  - [code-guide.md](code-guide.md): the big whys of the code.
  - [item-guide.md](item-guide.md): the big whys of the catalog, its assets and tools, and short procedures.
  - This file: every rule.
  - `CLAUDE.md` routes an agent to the right one.
  - `README.md` describes the site for a human, with almost nothing technical.
- **The docs never restate the code.** No values, signatures, field tables, line numbers, file sizes or history. They hold why things are the way they are, and the high-level shape of what there is. When the code is the source of truth (a schema, a token, a constant), the doc names the file.
- **Docs sync at push time, not mid-task.** A doc may be stale across commits while the work is in flight. Before pushing:
  1. Run `npm run docs-index`. `verify` fails on a stale index or a file without a header comment.
  2. Check whether the diff changed a big why, or the high-level structure that a guide or the README describes (a new page, a new kind of asset, a new tool, a changed pipeline step). If not, no hand-written doc needs touching, which is the common case.
