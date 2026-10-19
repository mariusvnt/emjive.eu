# Rules

Process rules for how to work in this repo.

## Dev server / visual verification

Never launch `npm run dev` (or any dev server) in the background for the purpose of visually verifying a change — that's the user's call to make, not mine. Ask them to check it themselves instead of spinning one up on my own.

The one exception: when what's being checked is objective and hard to verify by hand — a textual value, a loading/error status, a numeric measurement (bounding boxes, computed styles, timing, whether an element exists/loaded) — rather than how something *looks* or *feels*. In that case, launching a dev server myself (e.g. with a headless browser) to check that specific metric is fine.

## Keep the documentation index in sync with the code structure

Doc updates don't need to happen in the same pass as the code change — they mostly happen at git-push time instead (see below). It's fine for a rename/move/create/delete, or a behavior change, to leave `CLAUDE.md` or a `dev-guidelines/*.md` file momentarily stale across one or more commits while the work is still in flight; don't stop mid-task just to fix a doc.

## Sync the docs at git push time

Before/after pushing, map the diff's changed paths to the doc(s) that cover them (see the table in `CLAUDE.md`) and review the diff against just those — a `css/style.css`-only change only needs `styling.md` checked, not the full set. This is the main sync point, and it covers two kinds of drift:

- **Structural drift**: a renamed/moved/created/deleted file or folder that isn't reflected leaves docs pointing at a path that no longer exists, which is worse than no docs at all — an agent that trusts it will fail immediately, and one that doesn't trust it has to re-derive the whole map from scratch anyway, defeating the point of having an index. Also grep for the old name/path across `dev-guidelines/` and `CLAUDE.md` to catch cross-references *other* docs make to the changed file, not just the doc that most directly covers it.
- **Behavioral/content drift**: changes that don't touch file structure at all (a config default changing, a new npm script, a section added to a page) but still make some doc's description inaccurate.

Do a full sweep — every `dev-guidelines/*.md` file plus `README.md` and `CLAUDE.md` — only periodically (e.g. before a release, or roughly every 10 pushes) rather than after each one. That's what catches drift the targeted check would miss; running it every push makes the doc-sync cost fixed and full-repo-sized regardless of how small the change was, which isn't worth paying that often.

## Code comments: minimal, present-tense, no history

Comments in code (JS, CSS, HTML, scripts, config) are kept to the minimum that is useful:

- **What, only for structure.** A file header (what the module is, its public API or options), section markers, and a line on a function or constant whose name doesn't say enough, worded as directly as possible. No comment that restates what the code already says.
- **Why, only when the code can't show it.** A browser bug or quirk being worked around, an ordering or timing constraint, a value that must stay in step with another file, a trade-off that would otherwise look like a mistake. A sentence or two, not an essay.
- **Never about past versions.** No "used to", "replaced", "the old…", "previously", "an earlier version…", no account of what was tried and failed or how a bug was found. A comment describes the code as it is now; history belongs in commit messages.
- **Not documentation.** Workflows, rationale write-ups and cross-file walkthroughs go in `dev-guidelines/`. A doc should hold its own detail rather than point to "the comment in X".
- **Kept true in the same pass.** Changing code means fixing or deleting the comments it invalidates right then. Unlike the docs, comments are not deferred to push time: a wrong comment is worse than none.

## Never attribute commits to the coding agent

Commit messages should read as if the user wrote them. Don't add a `Co-Authored-By` trailer, a "Generated with ..." line, or any other mention of an AI/agent's involvement — to the commit message, the PR description, or anywhere else in the commit itself. This holds regardless of how much of the change the agent actually authored.
