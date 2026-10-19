#!/usr/bin/env node
// Generates dev-guidelines/index.md: the repo's tree down to each file's public
// surface, described by the code's own header comments.
//
//   npm run docs-index                 write the index
//   npm run docs-index -- --check      exit 1 if it is stale or a file lacks a header comment
//
// Descriptions are the first sentence of a file's header comment (JS, CSS,
// HTML, YAML, .htaccess). Surfaces: the window.Emjive* globals a script sets
// and who reads them, module exports, CSS "==== Section ====" markers, the
// scripts and landmark ids of a page, top-level JSON keys, shared string names
// (events, storage keys). Folders and binaries, which can't hold comments,
// take theirs from FOLDERS below.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const postcss = require("postcss");

const ROOT = path.resolve(__dirname, "..");
const OUT = "dev-guidelines/index.md";
const CHECK = process.argv.includes("--check");

const FOLDERS = {
  "css/": "The site's one stylesheet.",
  "js/": "Client scripts: classic scripts talking through window.Emjive* globals, and the ES modules of the 3D layer.",
  "series/": "One folder per series: its homepage hero bundle (fragment, styles, behaviour), injected by js/series.js.",
  "data/": "The catalog, fetched client-side: the series index and one folder per series.",
  "data/series/": "One folder per series: its products and its design manifest.",
  "assets/": "Static binaries. Everything outside series/ is brand-wide.",
  "assets/draco/": "three's Draco decoder, self-hosted (the site makes no external requests).",
  "assets/fonts/": "Self-hosted fonts: DINish and Geist Mono.",
  "assets/hdri/": "Environment maps the models are lit with.",
  "assets/series/": "One folder per series: its hero art and its products' files.",
  "hero/": "That series' homepage hero art.",
  "products/": "One folder per product, <name>_<category>: model, wireframe, print model (not in git), renders, x-ray, photos.",
  "scripts/": "Node tooling: the build checks, the catalog pipeline and the dev tools' servers.",
  "public/": "Copied as-is to the root of dist/.",
  ".github/workflows/": "CI: verify on every pull request, deploy on every push to main.",
  "package.json": "Dependencies and the npm scripts (table below).",
  "public/robots.txt": "Allows everything, points at the sitemap.",
  "public/favicon.ico": "Generated from assets/logo_compact.svg (npm run render-favicons).",
  "public/apple-touch-icon.png": "Generated from assets/logo_compact.svg (npm run render-favicons).",
  "assets/logo.svg": "The brand mark.",
  "assets/logo_compact.svg": "The compact mark, also the favicon.",
  "assets/hand-pointer-thumb-opened.svg": "The 3D viewer's idle nudge hand.",
  "assets/hand_normal.webp": "Unused, never shipped (NEVER_COPY in vite.config.js).",
  "assets/metal-sample_*.webp": "The metal picker's swatches, rendered by npm run auto-render."
};

const problems = [];
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const list = (dir, test) =>
  exists(dir || ".")
    ? fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .filter(test)
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "en"))
    : [];
const filesIn = (dir, re) => list(dir, (e) => e.isFile() && re.test(e.name)).map((n) => dir + n);
const dirsIn = (dir) => list(dir, (e) => e.isDirectory()).map((n) => dir + n + "/");

/* ---- header comments ---------------------------------------------------- */

// The first sentence of a header; its paragraph ends at a blank line or an indented (list) line.
function firstSentence(lines) {
  const para = [];
  for (const line of lines) {
    if (!line.trim() || (para.length && /^\s{2,}/.test(line))) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  const text = para.join(" ").replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).replace(/:$/, ".");
}

// A block comment's lines after the first, shifted left by their common indent.
function dedent(lines) {
  const indents = lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
  const by = indents.length ? Math.min(...indents) : 0;
  return lines.map((l, i) => (i ? l.slice(by) : l));
}

function slashHeader(text) {
  const lines = text.split("\n");
  let i = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^\s*\/\*/.test(lines[i] || "")) {
    const start = lines.slice(0, i).join("\n").length;
    const block = text.slice(text.indexOf("/*", start) + 2);
    return firstSentence(dedent(block.slice(0, block.indexOf("*/")).split("\n")));
  }
  const out = [];
  for (; i < lines.length && /^\s*\/\//.test(lines[i]); i++) out.push(lines[i].replace(/^\s*\/\/\s?/, ""));
  return out.length ? firstSentence(out) : "";
}

function hashHeader(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && i < 4 && !/^\s*#/.test(lines[i])) i++;
  const out = [];
  for (; i < lines.length && /^\s*#/.test(lines[i]); i++) out.push(lines[i].replace(/^\s*#\s?/, ""));
  return out.length ? firstSentence(out) : "";
}

function htmlHeader(text) {
  const m = /^(?:\s*<!doctype[^>]*>)?\s*<!--([\s\S]*?)-->/i.exec(text);
  return m ? firstSentence(dedent(m[1].split("\n"))) : "";
}

/* ---- JS ----------------------------------------------------------------- */

const GLOBAL_OBJECTS = new Set(["window", "global", "globalThis", "self"]);
const SHARED_NAME = /^emjive[:_][\w:-]*$/;

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}

const propName = (node) => (node.computed ? (node.property.type === "Literal" ? String(node.property.value) : null) : node.property.name);
const keysOf = (node) =>
  node && node.type === "ObjectExpression"
    ? node.properties.filter((p) => p.type === "Property" && !p.computed).map((p) => p.key.name || String(p.key.value))
    : [];
const isGlobalObject = (node) => node.type === "Identifier" && GLOBAL_OBJECTS.has(node.name);

function parseJs(file, text, comments) {
  const options = { ecmaVersion: "latest", allowHashBang: true, onComment: comments };
  try {
    return acorn.parse(text, { ...options, sourceType: "module" });
  } catch {
    comments.length = 0;
    try {
      return acorn.parse(text, { ...options, sourceType: "script", allowReturnOutsideFunction: true });
    } catch (err) {
      problems.push(file + ": cannot parse (" + err.message + ")");
      return null;
    }
  }
}

// { globals: Map name -> Set(keys), exports: [], names: Set(shared string names), code: text with comments blanked }
function jsSurface(file, text) {
  const surface = { globals: new Map(), exports: [], names: new Set(), code: text };
  const comments = [];
  const ast = parseJs(file, text, comments);
  if (!ast) return surface;
  surface.code = comments.reduceRight((t, c) => t.slice(0, c.start) + " ".repeat(c.end - c.start) + t.slice(c.end), text);
  const addGlobal = (name, keys) => {
    if (!surface.globals.has(name)) surface.globals.set(name, new Set());
    keys.forEach((k) => surface.globals.get(name).add(k));
  };
  walk(ast, (node) => {
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
      const left = node.left;
      const name = propName(left);
      if (isGlobalObject(left.object) && /^Emjive/.test(name || "")) {
        addGlobal(name, keysOf(node.right));
      } else if (left.object.type === "MemberExpression" && isGlobalObject(left.object.object) &&
                 /^Emjive/.test(propName(left.object) || "") && name) {
        addGlobal(propName(left.object), [name]);
      } else if (left.object.type === "Identifier" && left.object.name === "module" && name === "exports") {
        surface.exports.push(...keysOf(node.right));
      } else if (left.object.type === "Identifier" && left.object.name === "exports" && name) {
        surface.exports.push(name);
      }
    } else if (node.type === "ExportNamedDeclaration") {
      const d = node.declaration;
      if (d && d.id) surface.exports.push(d.id.name);
      else if (d && d.declarations) d.declarations.forEach((v) => v.id.name && surface.exports.push(v.id.name));
      node.specifiers.forEach((s) => surface.exports.push(s.exported.name || s.exported.value));
    } else if (node.type === "Literal" && typeof node.value === "string" && SHARED_NAME.test(node.value)) {
      surface.names.add(node.value);
    } else if (node.type === "TemplateElement" && SHARED_NAME.test(node.value.cooked || "")) {
      surface.names.add(node.value.cooked);
    }
  });
  surface.exports = [...new Set(surface.exports)];
  return surface;
}

/* ---- HTML, CSS, JSON ---------------------------------------------------- */

const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

function htmlSurface(html) {
  const text = stripHtmlComments(html);
  const headEnd = text.search(/<\/head>/i);
  const scripts = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    if (/type="importmap"/.test(attrs)) continue;
    const src = /\bsrc="([^"]+)"/.exec(attrs);
    const mode = /type="module"/.test(attrs) ? "module" : /\bdefer\b/.test(attrs) ? "defer" : m.index < headEnd ? "head, blocking" : "blocking";
    scripts.push((src ? src[1] : "inline") + " (" + mode + ")");
  }
  const ids = [];
  const idRe = /<(main|section|nav|aside|dialog|header|footer)\b[^>]*\bid="([^"]+)"/gi;
  while ((m = idRe.exec(text))) ids.push("#" + m[2]);
  const slots = [];
  const slotRe = /data-series-slot="([^"]+)"/g;
  while ((m = slotRe.exec(text))) slots.push("#" + m[1]);
  return { scripts, ids, slots };
}

function cssSurface(file, text) {
  let root;
  try {
    root = postcss.parse(text, { from: file });
  } catch (err) {
    problems.push(file + ": cannot parse (" + err.message + ")");
    return { header: "", sections: [] };
  }
  const sections = [];
  let header = "";
  root.nodes.forEach((node, i) => {
    if (node.type !== "comment") return;
    const marker = /^=+\s*(.+?)\s*=+/.exec(node.text);
    if (marker) sections.push(marker[1]);
    else if (i === 0) header = firstSentence(dedent(node.text.split("\n")));
  });
  return { header, sections };
}

function jsonSurface(file, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    problems.push(file + ": invalid JSON (" + err.message + ")");
    return "";
  }
  const keys = Object.keys(data).map((k) => "`" + k + "`").join(", ");
  if (Array.isArray(data.products)) {
    return keys + ". " + data.products.length + " products: " + data.products.map((p) => p.name).join(", ") + ".";
  }
  if (Array.isArray(data.series)) {
    return keys + ". Series: " + data.series.map((s) => s.slug).join(", ") + "; featured: " + data.featured + ".";
  }
  return keys + ".";
}

/* ---- collect ------------------------------------------------------------ */

const entries = []; // { path, depth, kind: "dir"|"file", desc, details: [] }
const surfaces = new Map(); // file -> JS surface (globals, names)
const codeFiles = new Map(); // page or script outside the root configs -> code without comments, for the readers scan

function describe(file, desc, required) {
  if (!desc && required) problems.push(file + ": no header comment");
  return desc || FOLDERS[file] || "";
}

function addDir(dir, depth, key) {
  entries.push({ path: dir, depth, kind: "dir", desc: FOLDERS[key || dir] || "", details: [] });
}

function addBinary(file, depth) {
  entries.push({ path: file, depth, kind: "file", desc: FOLDERS[file] || "", details: [] });
}

function addFile(file, depth) {
  const text = read(file);
  const ext = path.extname(file);
  const entry = { path: file, depth, kind: "file", desc: "", details: [] };
  const rootConfig = !file.includes("/") && ext !== ".html";
  if (ext === ".js" || ext === ".mjs") {
    entry.desc = describe(file, slashHeader(text), true);
    const surface = jsSurface(file, text);
    surfaces.set(file, surface);
    if (!rootConfig) codeFiles.set(file, surface.code);
    for (const [name, keys] of [...surface.globals].sort()) {
      entry.details.push("sets `" + name + "`" + (keys.size ? " { " + [...keys].join(", ") + " }" : ""));
    }
    if (surface.exports.length) entry.details.push("exports " + surface.exports.map((e) => "`" + e + "`").join(", "));
  } else if (ext === ".css") {
    const css = cssSurface(file, text);
    entry.desc = describe(file, css.header, true);
    if (css.sections.length) entry.details.push("sections: " + css.sections.join(" · "));
  } else if (ext === ".html") {
    entry.desc = describe(file, htmlHeader(text), true);
    const html = htmlSurface(text);
    if (html.scripts.length) entry.details.push("scripts: " + html.scripts.join(", "));
    if (html.ids.length) entry.details.push("landmarks: " + html.ids.join(", "));
    if (html.slots.length) entry.details.push("slots: " + html.slots.join(", "));
    const surface = { globals: new Map(), exports: [], names: new Set() };
    let code = stripHtmlComments(text);
    const inline = /<script\b(?![^>]*\bsrc=)(?![^>]*importmap)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = inline.exec(text))) {
      const s = jsSurface(file, m[1]);
      s.names.forEach((n) => surface.names.add(n));
      code = code.replace(m[1], s.code);
    }
    surfaces.set(file, surface);
    codeFiles.set(file, code);
  } else if (ext === ".yml" || path.basename(file) === ".htaccess") {
    entry.desc = describe(file, hashHeader(text), true);
  } else if (ext === ".json") {
    entry.desc = describe(file, "", false);
    if (file !== "package.json") entry.details.push(jsonSurface(file, text));
  } else {
    entry.desc = describe(file, "", false);
  }
  entries.push(entry);
}

filesIn("", /\.html$/).forEach((f) => addFile(f, 0));

addDir("css/", 0);
filesIn("css/", /\.css$/).forEach((f) => addFile(f, 1));

addDir("js/", 0);
filesIn("js/", /\.js$/).forEach((f) => addFile(f, 1));

addDir("series/", 0);
for (const dir of dirsIn("series/")) {
  addDir(dir, 1);
  filesIn(dir, /\.(html|css|js)$/).forEach((f) => addFile(f, 2));
}

addDir("data/", 0);
filesIn("data/", /\.json$/).forEach((f) => addFile(f, 1));
addDir("data/series/", 1);
for (const dir of dirsIn("data/series/")) {
  addDir(dir, 2);
  filesIn(dir, /\.json$/).forEach((f) => addFile(f, 3));
}

addDir("assets/", 0);
dirsIn("assets/").filter((d) => d !== "assets/series/").forEach((d) => addDir(d, 1));
addDir("assets/series/", 1);
for (const dir of dirsIn("assets/series/")) {
  addDir(dir, 2);
  dirsIn(dir).forEach((sub) => addDir(sub, 3, path.posix.basename(sub) + "/"));
}
const assetFiles = filesIn("assets/", /./);
const swatches = assetFiles.filter((f) => /^assets\/metal-sample_.*\.webp$/.test(f));
assetFiles.filter((f) => !swatches.includes(f)).forEach((f) => addBinary(f, 1));
if (swatches.length) addBinary("assets/metal-sample_*.webp", 1);

addDir("scripts/", 0);
filesIn("scripts/", /\.js$/).forEach((f) => addFile(f, 1));

addDir("public/", 0);
list("public/", (e) => e.isFile()).forEach((n) => {
  const f = "public/" + n;
  if (n === ".htaccess" || /\.txt$/.test(n)) addFile(f, 1);
  else addBinary(f, 1);
});

addDir(".github/workflows/", 0);
filesIn(".github/workflows/", /\.ya?ml$/).forEach((f) => addFile(f, 1));

["vite.config.js", "eslint.config.mjs", "package.json"].filter(exists).forEach((f) => addFile(f, 0));

/* ---- cross-file tables -------------------------------------------------- */

const setters = new Map(); // global -> [files]
const names = new Map(); // shared name -> [files]
for (const [file, surface] of surfaces) {
  for (const name of surface.globals.keys()) {
    if (!setters.has(name)) setters.set(name, []);
    setters.get(name).push(file);
  }
  for (const name of surface.names) {
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(file);
  }
}
const readersOf = (token, exclude) =>
  [...codeFiles.keys()].filter((f) => !exclude.includes(f) && new RegExp("\\b" + token + "\\b").test(codeFiles.get(f)));
const byName = (a, b) => a[0].localeCompare(b[0], "en");

/* ---- render ------------------------------------------------------------- */

const link = (p) =>
  p.includes("*") ? "`" + p + "`" : "[" + (p.endsWith("/") ? p : path.posix.basename(p)) + "](../" + p + ")";
const code = (files) => files.map((f) => "`" + f + "`").join(", ");

const out = [
  "<!-- Generated by scripts/docs-index.js (npm run docs-index). Do not edit by hand: change the code's header comments and re-run. -->",
  "",
  "# Index",
  "",
  "The repo's structure, generated from the code. Each description is the first sentence of the file's header comment; the lines under a file are its public surface. The why behind it is in [code-guide.md](code-guide.md) and [item-guide.md](item-guide.md), the rules in [rules.md](rules.md).",
  "",
  "## Tree",
  ""
];
for (const e of entries) {
  const indent = "  ".repeat(e.depth);
  const label = e.kind === "dir" ? "**" + link(e.path) + "**" : link(e.path);
  out.push(indent + "- " + label + (e.desc ? " — " + e.desc : ""));
  e.details.forEach((d) => out.push(indent + "  - " + d));
}
out.push("", "## Globals", "", "The `window.Emjive*` names the classic scripts publish to each other.", "");
out.push("| Global | Set by | Read by |", "| --- | --- | --- |");
for (const [name, files] of [...setters].sort(byName)) {
  const readers = readersOf(name, files);
  out.push("| `" + name + "` | " + code(files) + " | " + (readers.length ? code(readers) : "—") + " |");
}
out.push("", "## Shared names", "", "Event names and storage keys: the string literals starting with `emjive:` or `emjive_`.", "");
out.push("| Name | Used in |", "| --- | --- |");
for (const [name, files] of [...names].sort(byName)) out.push("| `" + name + "` | " + code(files) + " |");
out.push("", "## npm scripts", "", "| Script | Runs |", "| --- | --- |");
for (const [name, command] of Object.entries(JSON.parse(read("package.json")).scripts || {})) {
  out.push("| `" + name + "` | `" + command.replace(/\|/g, "\\|") + "` |");
}
out.push("");

const result = out.join("\n");

if (CHECK) {
  if ((exists(OUT) ? read(OUT) : "") !== result) problems.push(OUT + " is stale: run `npm run docs-index`");
  if (problems.length) {
    problems.forEach((p) => console.error("docs-index: " + p));
    process.exit(1);
  }
  console.log("docs-index: " + OUT + " is up to date");
} else {
  fs.writeFileSync(path.join(ROOT, OUT), result);
  problems.forEach((p) => console.error("docs-index: " + p));
  console.log("docs-index: wrote " + OUT + " (" + entries.length + " entries)");
  if (problems.length) process.exit(1);
}
