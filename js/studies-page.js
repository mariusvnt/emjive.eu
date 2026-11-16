// studies.html: names the tab after the requested study's manifest, or shows that it doesn't exist.

(function () {
  "use strict";

  var loadingEl = document.getElementById("studyManifestLoading");
  var contentEl = document.getElementById("studyManifestContent");
  if (!loadingEl || !contentEl) return;

  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  function showNotFound() {
    loadingEl.hidden = false;
    window.EmjiveMessage.show(loadingEl, "The requested study doesn't exist", {
      label: "Back to gallery",
      href: "/#gallery"
    }, "status");
    pageReady();
  }

  window.EmjiveStudies.ready
    .then(function () {
      // Not EmjiveStudies.slug, which falls back to the featured study.
      var slug = window.EmjiveStudies.requestedSlug();
      var entry = slug && window.EmjiveStudies.get(slug);
      if (!entry) return showNotFound();

      return window.EmjiveStudies.loadManifest(slug).then(function (manifest) {
        var title = manifest.title || entry.name || slug;
        document.title = "em·ji·ve: " + title.toLowerCase();

        loadingEl.hidden = true;
        contentEl.hidden = false;
        pageReady();
      });
    })
    .catch(function (err) {
      // A failed request or exception; a missing study is handled above.
      console.error("Could not load the study:", err);
      loadingEl.hidden = false;
      contentEl.hidden = true;
      window.EmjiveMessage.show(loadingEl,
        "This page couldn't be loaded. Check your connection and try again.",
        { label: "Reload" }, "alert");
      pageReady();
    });
})();
