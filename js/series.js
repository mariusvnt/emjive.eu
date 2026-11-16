// Series resolution (window.EmjiveSeries), plus the page-wide helpers every
// page needs first: EmjiveHero, EmjiveMessage, EmjiveMenus, and the homepage
// hero bundle loader.
//
// Blocking in <head>: EmjiveSeries must exist before any deferred script runs,
// and the data/series.json fetch starts at head-parse time so the hero can
// load without a flash.
(function () {
  "use strict";

  var INDEX_PATH = "data/series.json";

  // data/*.json paths are repo-root-relative, which only resolves because every page sits at the root.
  var index = null;
  var activeSlug = null;
  var activeSeries = null;

  // Memoized per slug: the gallery and the hero share one request. A failure
  // is evicted, so a later call retries.
  var productCache = {};
  var manifestCache = {};

  function memoized(cache, slug, load) {
    if (!cache[slug]) {
      cache[slug] = load().catch(function (err) {
        delete cache[slug];
        throw err;
      });
    }
    return cache[slug];
  }

  function queryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function resolveSlug(data) {
    var wanted = queryParam("series");
    if (wanted) {
      for (var i = 0; i < data.series.length; i++) {
        if (data.series[i].slug === wanted) return wanted;
      }
      console.warn("Unknown series: " + wanted);
    }
    return data.featured;
  }

  function get(slug) {
    if (!index || !slug) return null;
    for (var i = 0; i < index.series.length; i++) {
      if (index.series[i].slug === slug) return index.series[i];
    }
    return null;
  }

  // A series' "hdri" key -> asset path, for options.hdri. null when unresolved,
  // leaving js/three-viewer.js's DEFAULT_HDRI_SRC as the only fallback.
  function hdriPath(slug) {
    var entry = get(slug);
    var key = entry && entry.hdri;
    if (!key) return null;
    var all = (index && index.hdris) || {};
    if (!all[key]) {
      console.warn("Unknown hdri: " + key);
      return null;
    }
    return all[key];
  }

  // A request that never settles (stalled connection, captive portal) is
  // aborted into an ordinary failure.
  var FETCH_TIMEOUT_MS = 20000;

  function fetchJson(path) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(path, controller ? { signal: controller.signal } : undefined).then(function (res) {
      if (!res.ok) throw new Error("Could not load " + path);
      return res.json();
    }).then(function (data) {
      if (timer) clearTimeout(timer);
      return data;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function loadProducts(slug) {
    var entry = get(slug);
    if (!entry) return Promise.reject(new Error("Unknown series: " + slug));
    return memoized(productCache, slug, function () {
      return fetchJson(entry.products).then(function (data) {
        return data.products || [];
      });
    });
  }

  function loadManifest(slug) {
    var entry = get(slug);
    if (!entry) return Promise.reject(new Error("Unknown series: " + slug));
    return memoized(manifestCache, slug, function () { return fetchJson(entry.manifest); });
  }

  // Addresses: / (the gallery), /series?series=<slug>, and /<item slug> flat at the
  // root (pages reference css/, js/, assets/ relatively). public/.htaccess and
  // vite.config.js map them to the .html files. The featured series gets no
  // ?series=, keeping common URLs clean.
  function isFeatured(slug) {
    return !!index && slug === index.featured;
  }

  function seriesParam(slug, leading) {
    if (!slug || isFeatured(slug)) return "";
    return (leading || "?") + "series=" + encodeURIComponent(slug);
  }

  function mainHref(slug) {
    return "/" + seriesParam(slug);
  }

  function manifestHref(slug) {
    return "/series?series=" + encodeURIComponent(slug);
  }

  // Mirrors slugify() in scripts/slugs.js; validate-data compares them on every
  // product and parses this function's source, so keep it one self-contained
  // declaration.
  function productSlug(product) {
    return String(product.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Item slugs are unique across series, so no ?series=.
  function productHref(product) {
    return "/" + productSlug(product);
  }

  // A product shown as one of its designs. The product's own fields are the
  // default design; another design swaps in its model, icons, fallback
  // image, plan views and geometry, keeping the rest (name, prices, camera, x-ray,
  // photos). Returns { view, design }: view adds designKey and designName;
  // design is null without designs. An unknown key falls back to the default,
  // so an old selection still opens.
  function resolveDesign(product, key) {
    var designs = product && product.designs;
    var list = (designs && designs.list) || [];
    var design = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) design = list[i];
    }
    if (!design) {
      for (var j = 0; j < list.length; j++) {
        if (list[j].key === designs.default) design = list[j];
      }
    }
    var view = Object.assign({}, product);
    view.designKey = design ? design.key : "";
    view.designName = design ? design.name : (product && product.name) || "";
    if (design && design.key !== designs.default) {
      view.assets = Object.assign({}, product.assets, {
        model: design.model || "",
        icons: design.icons || {},
        "fallback-img": design["fallback-img"] || {},
        "plan-views": design["plan-views"] || {}
      });
      view.geometry = design.geometry || null;
    }
    return { view: view, design: design };
  }

  /* ---- hero <-> chrome scroll bridge ----
     A function registry rather than a CustomEvent: it fires every scroll frame.
     The hero publishes; js/selection-bar.js subscribes on every page (nothing
     publishes without a hero). */
  var heroScrollSubscribers = [];
  // The wheel's entrance progress (0..1, js/gallery-stack.js); null until published.
  var heroStageSubscribers = [];
  var heroStage = null;
  // How the wheel plays that progress (part of it may only turn the wheel), so
  // the hero keeps pace: mapStage(p), identity when unset.
  var heroStageMap = null;
  // The hero's layout changed (its stylesheet landed, a resize, the rings
  // placed), never per scroll: js/gallery-stack.js re-measures on it.
  var heroLayoutSubscribers = [];

  window.EmjiveHero = {
    onLayout: function (fn) {
      if (typeof fn === "function") heroLayoutSubscribers.push(fn);
    },
    publishLayout: function () {
      for (var i = 0; i < heroLayoutSubscribers.length; i++) heroLayoutSubscribers[i]();
    },
    onScroll: function (fn) {
      if (typeof fn === "function") heroScrollSubscribers.push(fn);
    },
    publishScroll: function (pastTriggerPx, hasScrollRange) {
      for (var i = 0; i < heroScrollSubscribers.length; i++) {
        heroScrollSubscribers[i](pastTriggerPx, hasScrollRange);
      }
    },
    onStage: function (fn) {
      if (typeof fn === "function") heroStageSubscribers.push(fn);
    },
    publishStage: function (progress) {
      heroStage = progress;
      for (var i = 0; i < heroStageSubscribers.length; i++) {
        heroStageSubscribers[i](progress);
      }
    },
    stage: function () { return heroStage; },
    setStageMap: function (fn) {
      heroStageMap = typeof fn === "function" ? fn : null;
    },
    mapStage: function (progress) {
      return heroStageMap ? heroStageMap(progress) : progress;
    }
  };

  /* ---- page messages ----
     show(container, text, button, role): the site's one "didn't load / doesn't
     exist" layout (.page-message). `button` is { label, href } or
     { label, onClick }; with neither it reloads. */
  window.EmjiveMessage = {
    show: function (container, text, button, role) {
      container.textContent = "";
      container.classList.add("page-message");
      if (role) container.setAttribute("role", role);
      else container.removeAttribute("role");

      var textEl = document.createElement("span");
      textEl.className = "page-message__text";
      textEl.textContent = text;
      container.appendChild(textEl);

      if (button) {
        var control;
        if (button.href) {
          control = document.createElement("a");
          control.href = button.href;
        } else {
          control = document.createElement("button");
          control.type = "button";
          control.addEventListener("click", button.onClick || function () { window.location.reload(); });
        }
        control.className = "page-message__button";
        control.textContent = button.label;
        container.appendChild(control);
      }
    }
  };

  /* ---- click-away for chrome panels ----
     The header menu and the selection-bar drawer don't know about each other.
     Each registers a `root` (trigger and content) and reports opening and
     closing; a click outside every open root closes the most recent one only. */
  var openPanels = []; // oldest first

  window.EmjiveMenus = {
    opened: function (panel) {
      var i = openPanels.indexOf(panel);
      if (i !== -1) openPanels.splice(i, 1);
      openPanels.push(panel);
    },
    closed: function (panel) {
      var i = openPanels.indexOf(panel);
      if (i !== -1) openPanels.splice(i, 1);
    }
  };

  // Escape closes the most recent panel, unless a dialog holds the focus trap.
  // Focus returns to the trigger only if it was inside the panel.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !openPanels.length) return;
    if (window.EmjiveFocusTrap && window.EmjiveFocusTrap.isActive && window.EmjiveFocusTrap.isActive()) return;
    var top = openPanels.pop();
    var hadFocus = top.root.contains(document.activeElement);
    top.close();
    if (hadFocus && top.returnFocus) top.returnFocus.focus();
  });

  document.addEventListener("click", function (e) {
    if (!openPanels.length) return;
    // A click inside any open panel is its own concern.
    for (var i = 0; i < openPanels.length; i++) {
      if (openPanels[i].root.contains(e.target)) return;
    }
    var top = openPanels[openPanels.length - 1];
    openPanels.pop();
    top.close();
  });

  /* ---- hero bundle loading (index.html, #seriesHero) ---- */
  // hero.preload lists originals: the first is the first-paint picture (with a
  // low-res pair), the rest are layers with high-res versions only.
  function injectPreload(href, isLcp) {
    var link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    if (window.EmjiveLoader) href = window.EmjiveLoader.versions(href, !!isLcp).first;
    // The hero picture is above the fold but undiscoverable early (inside a
    // fragment); the clipped layers must never take bandwidth from it.
    link.fetchPriority = isLcp ? "high" : "low";
    link.href = href;
    document.head.appendChild(link);
  }

  // Fragment images carry data-full (and data-lo with a low-res pair) instead of
  // src; each gets the version for this viewport while still inert in the template.
  function chooseHeroImages(root) {
    var imgs = root.querySelectorAll("img[data-full]");
    for (var i = 0; i < imgs.length; i++) {
      var full = imgs[i].getAttribute("data-full");
      var v = window.EmjiveLoader
        ? window.EmjiveLoader.versions(full, imgs[i].hasAttribute("data-lo"))
        : { first: full };
      imgs[i].src = v.first;
    }
  }

  // Once revealed and idle, low-res pictures are swapped for high-res.
  function upgradeHeroImages(slot) {
    if (!window.EmjiveLoader) return;
    var imgs = slot.querySelectorAll("img[data-full][data-lo]");
    for (var i = 0; i < imgs.length; i++) {
      window.EmjiveLoader.upgradeImage(imgs[i], window.EmjiveLoader.versions(imgs[i].getAttribute("data-full"), true).hi);
    }
  }

  // Crossing the phone/desktop line reshapes the hero (hero.css): switch every
  // picture to the other set's high-res version.
  var watchingPhone = false;
  function watchHeroForPhoneChange() {
    if (watchingPhone || !window.EmjiveLoader) return;
    watchingPhone = true;
    window.EmjiveLoader.onPhoneChange(function () {
      var imgs = document.querySelectorAll("img[data-full]");
      for (var i = 0; i < imgs.length; i++) {
        var full = imgs[i].getAttribute("data-full");
        imgs[i].src = window.EmjiveLoader.versions(full, imgs[i].hasAttribute("data-lo")).hi;
      }
    });
  }

  function injectStylesheet(href) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function injectScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(el);
    });
  }

  function loadHero(slot, entry) {
    var hero = entry && entry.hero;
    if (!hero) return Promise.resolve(false);

    // First: the fragment's images are invisible to the preload scanner.
    (hero.preload || []).forEach(function (href, i) { injectPreload(href, i === 0); });

    // Before the fragment lands, so the x-ray is never painted unclipped.
    if (hero.css) injectStylesheet(hero.css);

    // hero.js has no side effects on execution, so script, stylesheet and
    // fragment load in parallel.
    var fragmentPromise = fetch(hero.fragment).then(function (res) {
      if (!res.ok) throw new Error("Could not load " + hero.fragment);
      return res.text();
    });
    var scriptPromise = hero.js ? injectScript(hero.js) : Promise.resolve();

    return Promise.all([fragmentPromise, scriptPromise]).then(function (results) {
      var doc = new DOMParser().parseFromString(results[0], "text/html");

      // One <template data-series-slot="id"> per destination. Template content is
      // inert, so images fetch only once cloned, resolving against the page.
      var templates = doc.querySelectorAll("template[data-series-slot]");
      for (var i = 0; i < templates.length; i++) {
        var target = document.getElementById(templates[i].dataset.seriesSlot);
        if (target) {
          var clone = templates[i].content.cloneNode(true);
          chooseHeroImages(clone);
          target.appendChild(clone);
        }
        else console.warn("No slot #" + templates[i].dataset.seriesSlot + " for the hero fragment");
      }

      watchHeroForPhoneChange();
      if (window.EmjiveSeriesHero && window.EmjiveSeriesHero.init) {
        window.EmjiveSeriesHero.init(slot, { slug: activeSlug, series: entry });
      }
      return true;
    });
  }

  // Lifts the arrival loader (no-op without one). Idempotent.
  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  // No hero is coming: tell the wheel its entrance is done.
  function noHero() {
    window.EmjiveHero.publishStage(1);
  }

  function heroFailed(slot, err) {
    console.error("Hero bundle failed to load: " + (err && err.message ? err.message : err));
    // Otherwise .has-series-hero keeps the selection bar off-screen for good.
    document.body.classList.remove("has-series-hero");
    if (slot) slot.innerHTML = "";
    noHero();
  }


  var ready = fetchJson(INDEX_PATH).then(function (data) {
    index = data;
    activeSlug = resolveSlug(data);
    activeSeries = get(activeSlug);

    window.EmjiveSeries.index = index;
    window.EmjiveSeries.metals = index.metals || [];
    window.EmjiveSeries.hdris = index.hdris || {};
    window.EmjiveSeries.slug = activeSlug;
    window.EmjiveSeries.series = activeSeries;

    // data-products="eager" on <html> starts products.json as soon as the slug is
    // known; loadProducts() memoizes, so the page's own call reuses it.
    if (activeSeries && document.documentElement.getAttribute("data-products") === "eager") {
      loadProducts(activeSlug).catch(function () {});
    }

    var slot = document.getElementById("seriesHero");
    if (slot && activeSeries) {
      loadHero(slot, activeSeries)
        .then(function (loaded) {
          if (!loaded) {
            document.body.classList.remove("has-series-hero");
            noHero();
            pageReady();
            return;
          }
          // The arrival loader waits for the hero's first paint, not the products: the
          // images marked data-first-paint matching data-hero ("play": the photo,
          // "skip": the x-ray and what's in sight with it), else the slot's first
          // <img>. A grid landing without the hero is released by js/gallery.js instead.
          var mode = document.documentElement.getAttribute("data-hero") === "skip" ? "skip" : "play";
          var gridFirst = mode === "skip" && document.documentElement.getAttribute("data-gallery-view") === "grid";
          var heroImgs = Array.prototype.slice.call(slot.querySelectorAll('img[data-first-paint~="' + mode + '"]'));
          if (!heroImgs.length && slot.querySelector("img")) heroImgs = [slot.querySelector("img")];
          if (gridFirst) {
            upgradeHeroImages(slot);
          } else if (heroImgs.length && window.EmjiveLoader) {
            Promise.all(heroImgs.map(window.EmjiveHelpers.imageReady)).then(function () {
              pageReady();
              upgradeHeroImages(slot);
            });
          } else {
            pageReady();
          }
          // Its own catch: the hero is working, and the outer catch would tear it down.
          return loadProducts(activeSlug).then(function (products) {
            if (window.EmjiveSeriesHero && window.EmjiveSeriesHero.onProducts) {
              window.EmjiveSeriesHero.onProducts(products);
            }
          }).catch(function (err) {
            console.error("Hero could not receive the products: " + (err && err.message ? err.message : err));
          });
        })
        .catch(function (err) { heroFailed(slot, err); pageReady(); });
    } else if (slot) {
      document.body.classList.remove("has-series-hero");
      noHero();
      pageReady();
    }

    return { index: index, slug: activeSlug, series: activeSeries };
  });

  // Without the index nothing else lifts the cover but its watchdog; the
  // page's own error handling shows the message.
  ready.catch(function () { pageReady(); });

  /* ---- the visitor's metals ----
     A metal per item, picked on its grid tile (js/gallery.js) and kept for
     the visit (sessionStorage, by item name): the tile and the wheel show
     the item in it, and its page opens on it. A new visit opens on the
     items' own default metals. */
  var METAL_KEY = "emjive_metals";

  function pickedMetals() {
    return window.EmjiveHelpers.readStorageJson("sessionStorage", METAL_KEY) || {};
  }

  // Null until one is picked for the item, or once it is no longer offered.
  function chosenMetal(product) {
    var metal = product ? pickedMetals()[product.name] : null;
    return metal && index && (index.metals || []).indexOf(metal) !== -1 ? metal : null;
  }

  function chooseMetal(product, metal) {
    var picked = pickedMetals();
    picked[product.name] = metal;
    window.EmjiveHelpers.writeStorage("sessionStorage", METAL_KEY, JSON.stringify(picked));
  }

  function metalFor(product) {
    return chosenMetal(product) || product["default-metal"];
  }

  window.EmjiveSeries = {
    ready: ready,

    index: null,
    metals: [],
    hdris: {},
    slug: null,
    series: null,

    // Sizing belongs to the category, in the global vocabulary.
    categoryInfo: function (id) {
      var all = (index && index.categories) || {};
      return all[id] || { sizes: [], unit: "" };
    },

    hdriPath: hdriPath,

    all: function () { return (index && index.series) || []; },
    get: get,
    featuredSlug: function () { return index && index.featured; },
    isFeatured: isFeatured,

    loadProducts: loadProducts,
    loadManifest: loadManifest,

    mainHref: mainHref,
    manifestHref: manifestHref,
    productHref: productHref,
    productSlug: productSlug,
    resolveDesign: resolveDesign,

    chosenMetal: chosenMetal,
    chooseMetal: chooseMetal,
    metalFor: metalFor,

    // The raw ?series=, without the featured fallback (series.html shows not-found instead).
    requestedSlug: function () { return queryParam("series"); }
  };
})();
