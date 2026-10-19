#!/usr/bin/env node
// Pure text helpers for the tools that edit the data files (no fs/http):
// inserting, patching and removing entries in hand-aligned JSON without
// re-serializing, and rendering whole product/series blocks in canonical formatting.
// renderProductBlock copies the auto-render-owned maps (icons, fallback-img,
// wheel-poster, top-shot) from the on-disk product, never from form input.

"use strict";

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

function num(n) {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function bool(b) {
  return !!b;
}

// The product's "geometry" line, shared with scripts/measure-models.js so
// neither drops a field. `indent`: 6 spaces (product) by default, 12 for a
// design entry.
function geometryLine(g, indent) {
  const triple = (v) => "[" + (v || []).map(num).join(", ") + "]";
  const box = g["min-box"];
  const print = g.print;
  return (indent === undefined ? "      " : indent) + '"geometry": { "volume-cm3": ' + num(g["volume-cm3"]) +
    ', "dimensions-mm": ' + triple(g["dimensions-mm"]) +
    (box
      ? ', "min-box": { "center": ' + triple(box.center) +
        ', "axes": [' + (box.axes || []).map(triple).join(", ") + "] }"
      : "") +
    (print
      ? ', "print": { "volume-cm3": ' + num(print["volume-cm3"]) + ', "dimensions-mm": ' + triple(print["dimensions-mm"]) +
        ', "stl-sha1": "' + esc(print["stl-sha1"]) + '" }'
      : "") +
    ', "model-sha1": "' + esc(g["model-sha1"]) + '" },';
}

// ---- bracket matching ----
// From just after an opening bracket, the index of its matching close (-1 if
// unbalanced), skipping string contents.
function findMatchingClose(text, afterOpenIdx, openChar, closeChar) {
  let i = afterOpenIdx;
  let depth = 1;
  let inString = false;
  let escaped = false;
  while (depth > 0 && i < text.length) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

// Appends an already-indented element to the array opened by `openAnchor`
// (e.g. '"products": ['). null if not found or unbalanced.
function insertBeforeArrayClose(text, openAnchor, newEntryText) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "[", "]");
  if (closeIdx === -1) return null;
  const inner = text.slice(afterOpen, closeIdx);
  const isEmpty = /^\s*$/.test(inner);
  const trimmedInner = inner.replace(/\s+$/, "");
  const insertion = isEmpty
    ? "\n" + newEntryText + "\n  "
    : trimmedInner + ",\n" + newEntryText + "\n  ";
  return text.slice(0, afterOpen) + insertion + text.slice(closeIdx);
}

// Same, for a `"key": value` line in the object opened by `openAnchor`.
function insertBeforeObjectClose(text, openAnchor, newEntryText) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "{", "}");
  if (closeIdx === -1) return null;
  const inner = text.slice(afterOpen, closeIdx);
  const isEmpty = /^\s*$/.test(inner);
  const trimmedInner = inner.replace(/\s+$/, "");
  const insertion = isEmpty
    ? "\n" + newEntryText + "\n  "
    : trimmedInner + ",\n" + newEntryText + "\n  ";
  return text.slice(0, afterOpen) + insertion + text.slice(closeIdx);
}

// Appends to a single-line string array (data/series.json "metals"), keeping it on one line.
function appendToInlineStringArray(text, openAnchor, value) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "[", "]");
  if (closeIdx === -1) return null;
  const inner = text.slice(afterOpen, closeIdx);
  const isEmpty = /^\s*$/.test(inner);
  const trimmed = inner.replace(/\s+$/, "");
  const insertion = isEmpty ? '"' + esc(value) + '"' : trimmed + ', "' + esc(value) + '"';
  return text.slice(0, afterOpen) + insertion + text.slice(closeIdx);
}

// Replaces an existing top-level string field.
function updateTopLevelScalarInText(text, fieldName, newValueText) {
  const fieldPattern = new RegExp('"' + fieldName + '":\\s*"[^"]*"');
  if (!fieldPattern.test(text)) return null;
  return text.replace(fieldPattern, '"' + fieldName + '": ' + newValueText);
}

// An object's inner text -> one string per top-level `"key": value` entry
// (commas at depth 0 only, string-aware).
function splitTopLevelEntries(inner) {
  const entries = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === "]") { depth--; continue; }
    if (ch === "," && depth === 0) {
      entries.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(inner.slice(start));
  return entries.map((e) => e.trim()).filter(Boolean);
}

// Removes a key from a flat object (categories{}, hdris{}), rebuilding its
// body from the surviving entries. null if the key isn't found.
function removeObjectEntryInText(text, openAnchor, key) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "{", "}");
  if (closeIdx === -1) return null;
  const inner = text.slice(afterOpen, closeIdx);
  const entries = splitTopLevelEntries(inner);
  const keyPrefix = '"' + key + '":';
  const filtered = entries.filter((e) => !e.startsWith(keyPrefix));
  if (filtered.length === entries.length) return null;
  const newInner = filtered.length ? "\n    " + filtered.join(",\n    ") + "\n  " : "";
  return text.slice(0, afterOpen) + newInner + text.slice(closeIdx);
}

// Removes a value from a single-line string array; its values are plain slugs,
// so a comma split is safe.
function removeFromInlineStringArray(text, openAnchor, value) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "[", "]");
  if (closeIdx === -1) return null;
  const inner = text.slice(afterOpen, closeIdx);
  const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
  const targetQuoted = '"' + esc(value) + '"';
  const filtered = items.filter((it) => it !== targetQuoted);
  if (filtered.length === items.length) return null;
  return text.slice(0, afterOpen) + filtered.join(", ") + text.slice(closeIdx);
}

// Replaces a key's value (string, or a one-level object) in a flat object.
function updateObjectEntryInText(text, openAnchor, key, newValueText) {
  const startIdx = text.indexOf(openAnchor);
  if (startIdx === -1) return null;
  const afterOpen = startIdx + openAnchor.length;
  const closeIdx = findMatchingClose(text, afterOpen, "{", "}");
  if (closeIdx === -1) return null;
  const block = text.slice(afterOpen, closeIdx);
  const keyPattern = new RegExp('("' + key + '":\\s*)(\\{[^}]*\\}|"[^"]*")');
  if (!keyPattern.test(block)) return null;
  const newBlock = block.replace(keyPattern, "$1" + newValueText);
  return text.slice(0, afterOpen) + newBlock + text.slice(closeIdx);
}

// Patches one field (name/year/hdri, or the flat categories array) of a
// series, field by field so its hand-authored "hero" is never rewritten.
function updateSeriesFieldInText(text, seriesSlug, fieldName, newValueText) {
  const span = anchoredSpan(text, "slug", seriesSlug);
  const fieldPattern = new RegExp('"' + fieldName + '":\\s*(\\[[^\\]]*\\]|"[^"]*")');
  return span && replaceInSpan(text, span, fieldPattern, '"' + fieldName + '": ' + newValueText);
}

// The span from `"key": "value"` to the next `"key": "` (or `end`): an
// entry's fields, bounded by its next sibling's anchor. null if the anchor
// isn't in [from, end].
function anchoredSpan(text, key, value, from, end) {
  const limit = end === undefined ? text.length : end;
  const anchor = '"' + key + '": "' + value + '"';
  const start = text.indexOf(anchor, from || 0);
  if (start === -1 || start > limit) return null;
  const next = text.indexOf('"' + key + '": "', start + anchor.length);
  return { start, end: next === -1 || next > limit ? limit : next };
}

// The first match of `pattern` within span replaced; null without a match.
function replaceInSpan(text, span, pattern, replacement) {
  const block = text.slice(span.start, span.end);
  if (!pattern.test(block)) return null;
  return text.slice(0, span.start) + block.replace(pattern, replacement) + text.slice(span.end);
}

// The full { ... } span of a block whose first field is
// `"anchorKey": "anchorValue"` (a product's "id", a series' "slug").
function findBlockSpanByAnchor(text, anchorKey, anchorValue) {
  const anchor = '"' + anchorKey + '": "' + anchorValue + '"';
  const anchorIdx = text.indexOf(anchor);
  if (anchorIdx === -1) return null;
  const openIdx = text.lastIndexOf("{", anchorIdx);
  if (openIdx === -1) return null;
  const closeIdx = findMatchingClose(text, openIdx + 1, "{", "}");
  if (closeIdx === -1) return null;
  return { start: openIdx, end: closeIdx + 1 };
}

function findProductBlockSpan(text, productId) {
  return findBlockSpanByAnchor(text, "id", productId);
}

// Replaces one product's block; the new text's outer indentation is trimmed.
function replaceProductBlockInText(text, productId, newBlockText) {
  const span = findProductBlockSpan(text, productId);
  if (!span) return null;
  return text.slice(0, span.start) + newBlockText.trim() + text.slice(span.end);
}

// Deletes the element at `span` with one adjacent comma, keeping the array valid.
function removeArrayEntryInText(text, span) {
  let start = span.start;
  let end = span.end;
  let i = end;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === ",") {
    end = i + 1;
  } else {
    let j = start - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (text[j] === ",") start = j;
  }
  return text.slice(0, start) + text.slice(end);
}

// The caller deletes the product's asset folder.
function removeProductBlockInText(text, productId) {
  const span = findProductBlockSpan(text, productId);
  if (!span) return null;
  return removeArrayEntryInText(text, span);
}

// The caller deletes the series' folders.
function removeSeriesBlockInText(text, seriesSlug) {
  const span = findBlockSpanByAnchor(text, "slug", seriesSlug);
  if (!span) return null;
  return removeArrayEntryInText(text, span);
}

function renderMetalPathMap(map, metals, indent) {
  map = map || {};
  return metals.map((m) => indent + '"' + m + '": "' + esc(map[m]) + '"').join(",\n");
}

// A product's hand-authored "designs" block, carried through in canonical form:
// the default design on one line, every other with its geometry, model and
// per-metal maps.
function renderDesignsBlock(designs, metals) {
  const strList = (list) => "[" + (list || []).map((v) => '"' + esc(v) + '"').join(", ") + "]";
  const picks = (p) => "{ " + Object.keys(p || {}).map((k) =>
    '"' + esc(k) + '": ' + (Array.isArray(p[k]) ? strList(p[k]) : '"' + esc(p[k]) + '"')).join(", ") + " }";
  const metalLine = (map) => "{ " + metals.map((m) => '"' + m + '": "' + esc((map || {})[m] || "") + '"').join(", ") + " }";
  const options = (designs.options || []).map((o) =>
    '          { "key": "' + esc(o.key) + '", "label": "' + esc(o.label) + '"' +
    (o.multiple ? ', "multiple": true' : "") + ', "choices": ' + strList(o.choices) + " }");
  const list = (designs.list || []).map((d) => {
    const head = '"key": "' + esc(d.key) + '", "name": "' + esc(d.name) + '", "picks": ' + picks(d.picks);
    if (d.key === designs.default) return "          { " + head + " }";
    const pad = "            ";
    return [
      "          {",
      pad + '"key": "' + esc(d.key) + '",',
      pad + '"name": "' + esc(d.name) + '",',
      pad + '"picks": ' + picks(d.picks) + ",",
      ...(d.geometry ? [geometryLine(d.geometry, pad)] : []),
      pad + '"model": "' + esc(d.model) + '",',
      ...(d.wireframe ? [pad + '"wireframe": "' + esc(d.wireframe) + '",'] : []),
      ...(d.stl ? [pad + '"stl": "' + esc(d.stl) + '",'] : []),
      pad + '"icons": ' + metalLine(d.icons) + ",",
      pad + '"fallback-img": ' + metalLine(d["fallback-img"]),
      "          }"
    ].join("\n");
  });
  return [
    '      "designs": {',
    '        "default": "' + esc(designs.default) + '",',
    '        "options": [',
    options.join(",\n"),
    "        ],",
    '        "list": [',
    list.join(",\n"),
    "        ]",
    "      }"
  ].join("\n");
}

function renderProductBlock(p, metals) {
  const specs = p["per-metal-specs"] || {};
  const perMetal = metals
    .map((m) => {
      const s = specs[m] || { price: 0 };
      return '        "' + m + '": { "price": ' + num(s.price) + " }";
    })
    .join(",\n");

  // Written by scripts/measure-models.js; carried through, absent until it runs.
  const geometry = p.geometry ? geometryLine(p.geometry) : null;

  const assets = p.assets || {};
  const hhv = p["hero-hand-visibility"] || { visible: false, x: 50, y: 50, scale: 6, rotation: 0 };
  const cam = p["3d-viewer-camera-default"] || { rotation: 0, tilt: 75, zoom: 105 };
  // One { src, description } per line.
  const photoLines = (assets.photos || [])
    .map((ph) => '          { "src": "' + esc(ph.src) + '", "description": "' + esc(ph.description) + '" }')
    .join(",\n");
  const photos = photoLines ? "[\n" + photoLines + "\n        ]" : "[]";

  return [
    "    {",
    '      "id": "' + esc(p.id) + '",',
    '      "name": "' + esc(p.name) + '",',
    '      "category": "' + esc(p.category) + '",',
    '      "description": "' + esc(p.description) + '",',
    '      "default-metal": "' + esc(p["default-metal"]) + '",',
    '      "per-metal-specs": {',
    perMetal,
    "      },",
    ...(p["size-range"] ? ['      "size-range": { "min": ' + num(p["size-range"].min) + ', "max": ' + num(p["size-range"].max) + " },"] : []),
    ...(geometry ? [geometry] : []),
    '      "hero-hand-visibility": { "visible": ' + bool(hhv.visible) + ', "x": ' + num(hhv.x) + ', "y": ' + num(hhv.y) + ', "scale": ' + num(hhv.scale) + ', "rotation": ' + num(hhv.rotation) + " },",
    // roll is optional: written only when present.
    '      "3d-viewer-camera-default": { "rotation": ' + num(cam.rotation) + ', "tilt": ' + num(cam.tilt) + ', "zoom": ' + num(cam.zoom) +
      (typeof cam.roll === "number" && Number.isFinite(cam.roll) ? ', "roll": ' + cam.roll : "") + " },",
    '      "assets": {',
    '        "model": "' + esc(assets.model) + '",',
    // Optional, hand-added.
    ...(assets.wireframe ? ['        "wireframe": "' + esc(assets.wireframe) + '",'] : []),
    ...(assets.stl ? ['        "stl": "' + esc(assets.stl) + '",'] : []),
    '        "icons": {',
    renderMetalPathMap(assets.icons, metals, "          "),
    "        },",
    '        "fallback-img": {',
    renderMetalPathMap(assets["fallback-img"], metals, "          "),
    "        },",
    '        "wheel-poster": {',
    renderMetalPathMap(assets["wheel-poster"], metals, "          "),
    "        },",
    '        "xray": "' + esc(assets.xray) + '",',
    '        "top-shot": {',
    renderMetalPathMap(assets["top-shot"], metals, "          "),
    "        },",
    '        "photos": ' + photos,
    p.designs ? "      }," : "      }",
    ...(p.designs ? [renderDesignsBlock(p.designs, metals)] : []),
    "    }"
  ].join("\n");
}

// A new series' block (existing ones are edited via updateSeriesFieldInText).
function renderSeriesBlock(s) {
  const categories = (s.categories || []).map((c) => '"' + esc(c) + '"').join(", ");
  const hero = s.hero || {};
  const preload = (hero.preload || []).map((x) => '"' + esc(x) + '"').join(", ");
  return [
    "    {",
    '      "slug": "' + esc(s.slug) + '",',
    '      "name": "' + esc(s.name) + '",',
    '      "year": "' + esc(s.year) + '",',
    '      "categories": [' + categories + "],",
    '      "products": "' + esc(s.products) + '",',
    '      "hdri": "' + esc(s.hdri) + '",',
    '      "manifest": "' + esc(s.manifest) + '",',
    '      "hero": {',
    '        "fragment": "' + esc(hero.fragment) + '",',
    '        "css":      "' + esc(hero.css) + '",',
    '        "js":       "' + esc(hero.js) + '",',
    '        "preload": [' + preload + "]",
    "      }",
    "    }"
  ].join("\n");
}

module.exports = {
  esc,
  num,
  geometryLine,
  insertBeforeArrayClose,
  insertBeforeObjectClose,
  appendToInlineStringArray,
  updateTopLevelScalarInText,
  updateObjectEntryInText,
  removeObjectEntryInText,
  removeFromInlineStringArray,
  updateSeriesFieldInText,
  anchoredSpan,
  replaceInSpan,
  findBlockSpanByAnchor,
  findProductBlockSpan,
  replaceProductBlockInText,
  removeArrayEntryInText,
  removeProductBlockInText,
  removeSeriesBlockInText,
  renderProductBlock,
  renderSeriesBlock
};
