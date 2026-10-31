/* Companion-site links, derived from the current hostname so no domain is written into the pages.
   On video.example the app is https://example and the docs https://docs.example.
   Locally (file://, localhost, a bare IP) the relative href already in the page is kept. */
(function () {
  var host = (window.location.hostname || "").toLowerCase();
  var local = !host || host === "localhost" || /\.localhost$/.test(host) || /^[\d.]+$/.test(host) || host.indexOf(":") >= 0;
  var root = host.replace(/^(www|docs|video|ppt)\./, "");
  var urls = {
    app: "https://" + root + "/",
    docs: "https://docs." + root + "/",
    video: "https://video." + root + "/",
    ppt: "https://ppt." + root + "/",
  };
  window.CREDORA_SITES = local ? null : urls;
  if (local) return;
  var links = document.querySelectorAll("a[data-site]");
  for (var i = 0; i < links.length; i++) {
    var u = urls[links[i].getAttribute("data-site")];
    if (u) links[i].href = u;
  }

  /* View counter. Each site keeps one number and nothing about the visitor. A browser counts once a day. */
  var site = (host.match(/^(docs|video|ppt)\./) || [])[1];
  if (!site || !window.fetch) return;
  var key = "credora-viewed-" + site, today = new Date().toISOString().slice(0, 10), seen = null;
  try { seen = window.localStorage.getItem(key); } catch (e) { seen = null; }
  var req = seen === today ? fetch("/api/views") : fetch("/api/views/" + site, { method: "POST" });
  req.then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    if (!c) return;
    try { window.localStorage.setItem(key, today); } catch (e) { /* private mode: counted again next visit */ }
    var fmt = function (n) { return Number(n || 0).toLocaleString("en-IN"); };
    var spots = document.querySelectorAll("[data-views]");
    for (var j = 0; j < spots.length; j++) {
      spots[j].textContent = fmt(c[spots[j].getAttribute("data-views")]) + " views";
    }
  }).catch(function () { /* counter is optional */ });
})();
