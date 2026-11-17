# em·ji·ve — website

The website of em·ji·ve, a jewelry brand whose pieces are designed in 3D and printed in metal (steel, silver or bronze), each one made to order.

The pieces come in **studies**, collections with a theme of their own. The first, *Bones*, is a set of rings drawn from the shapes of the human skeleton. The homepage belongs to the current study: it opens on that study's own animation (an x-ray of a hand wearing the rings), then pulls back to a **wheel** of every piece in 3D, which the visitor turns to bring one to the front. A compact **grid** of the pieces, two side by side on a phone, is one tap away for a quicker look. In the grid, each piece has its own row of metal swatches, which shows it and prices it in that metal, and its page then opens in it.

Each piece has its own page:

- **Photographs** and a description.
- **The piece in 3D**, to turn freely, in the chosen metal (with its composition and how it is printed) and, for some pieces, one of several designs.
- **Its specifications**: the size (set on a dial under the piece; a visitor unsure of theirs can order a sizing strip, which comes with free shipping on their next order, measure a ring they own on their phone's screen, or read the size chart), a front and a side view (a tap turns the piece to one and lays its outline over it, its length, width and depth marked), and how its price breaks down.

Visitors build a **selection** as they go, which follows them from page to page. They can review it on an order page, change an item or how many of it they want, remove it, and accept the terms.

## Where it stands

The site is a working prototype whose look keeps evolving. Most pieces are still waiting for their photographs and descriptions. The order page ends with a "Proceed to checkout" button, but there is no payment step behind it yet. "Who are we?", intent, 3D printing and environment pages are placeholders, and so are the legal pages the footer links to (legal notice, terms of sale, privacy policy).

## Working on it

```bash
npm install
npm run dev
```

Then open the address it prints. Everything else, from how the site is built to how a new piece is added, is in [`CLAUDE.md`](CLAUDE.md) and [`dev-guidelines/`](dev-guidelines/).
