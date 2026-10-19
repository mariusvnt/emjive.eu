# CLAUDE.md

em·ji·ve is a static jewelry shop with no backend and no framework: HTML pages at the repo root, one stylesheet, vanilla JS, a three.js 3D layer, and JSON catalog data organised into series. The selection (cart) lives in `localStorage`, and checkout stops before payment. Vite is required to run it (`npm run dev`) and to build it, and `npm run verify` is the gate every change passes.

Read [`dev-guidelines/rules.md`](dev-guidelines/rules.md) before changing anything. Then go to the guide for what you're looking for:

| Looking for… | Read |
| --- | --- |
| Where a file is, what it exposes, who uses a global, event or storage key | [`dev-guidelines/index.md`](dev-guidelines/index.md) (generated: `npm run docs-index`) |
| Why the code is shaped as it is: pages and addresses, scripts and load order, the 3D layer, styling, images, build and deploy | [`dev-guidelines/code-guide.md`](dev-guidelines/code-guide.md) |
| Products, series, designs, metals, categories; asset files and naming; the model/render pipeline and the tools; how to add or remove things | [`dev-guidelines/item-guide.md`](dev-guidelines/item-guide.md) |
| What isn't built yet (empty pages, checkout, contact form) | [`dev-guidelines/code-guide.md`](dev-guidelines/code-guide.md) §8 |
| The detail of anything | the code and its comments: the guides hold only the big whys |

`README.md` is the human-facing description of the site and doesn't repeat any of this.
