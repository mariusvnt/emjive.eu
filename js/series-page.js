// series.html: fills the requested series' title, year and subtitle from its manifest.

(function () {
  "use strict";

  var loadingEl = document.getElementById("seriesManifestLoading");
  var contentEl = document.getElementById("seriesManifestContent");
  if (!loadingEl || !contentEl) return;

  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  function showNotFound() {
    loadingEl.hidden = false;
    window.EmjiveMessage.show(loadingEl, "The requested series doesn't exist", {
      label: "Back to gallery",
      href: "/#gallery"
    }, "status");
    pageReady();
  }

  window.EmjiveSeries.ready
    .then(function () {
      // Not EmjiveSeries.slug, which falls back to the featured series.
      var slug = window.EmjiveSeries.requestedSlug();
      var entry = slug && window.EmjiveSeries.get(slug);
      if (!entry) return showNotFound();

      return window.EmjiveSeries.loadManifest(slug).then(function (manifest) {
        var title = manifest.title || entry.name || slug;
        document.title = "em·ji·ve: " + title.toLowerCase();

        document.getElementById("seriesManifestYear").textContent =
          manifest.year || entry.year || "";
        document.getElementById("seriesManifestTitle").textContent = title;

        var subtitleEl = document.getElementById("seriesManifestSubtitle");
        subtitleEl.textContent = manifest.subtitle || "";
        subtitleEl.hidden = !manifest.subtitle;

        loadingEl.hidden = true;
        contentEl.hidden = false;
        pageReady();
      });
    })
    .catch(function (err) {
      // A failed request or exception; a missing series is handled above.
      console.error("Could not load the series:", err);
      loadingEl.hidden = false;
      contentEl.hidden = true;
      window.EmjiveMessage.show(loadingEl,
        "This page couldn't be loaded. Check your connection and try again.",
        { label: "Reload" }, "alert");
      pageReady();
    });
})();
