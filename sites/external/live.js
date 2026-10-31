// Live counts from the three mock 3rd party data APIs. Each relay's /status endpoint is public
// (no API key) and reports what its own database holds right now.
(function () {
  var host = location.hostname.replace(/^www\./, "");
  var local = host === "localhost" || host === "127.0.0.1" || location.protocol === "file:";
  var base = function (name, port) {
    return local ? "http://localhost:" + port : "https://" + name + "." + host;
  };
  var parties = [
    { id: "cibil", name: "CIBIL (credit bureau)", url: base("cibil", 8101), stats: [
      ["consumer_reports", "partner credit reports"], ["commercial_reports", "company credit reports"]] },
    { id: "gst", name: "GSTN (GST network)", url: base("gst", 8102), stats: [
      ["registrations", "GST registrations"], ["filings", "monthly GST returns"]] },
    { id: "aa", name: "Account Aggregator", url: base("aa", 8103), stats: [
      ["accounts", "accounts at other banks"], ["transactions", "account transactions"], ["consents", "consents given"]] },
  ];
  var fmt = new Intl.NumberFormat("en-IN");
  var root = document.getElementById("live-counts");
  if (!root) return;
  var stamp = document.getElementById("live-stamp");

  parties.forEach(function (p) {
    var card = document.createElement("div");
    card.className = "live-card";
    card.innerHTML = '<p class="live-name">' + p.name + '</p><p class="live-state">Loading…</p><dl class="live-stats"></dl>';
    root.appendChild(card);
    fetch(p.url + "/status", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        card.querySelector(".live-state").textContent = "Live";
        card.querySelector(".live-state").classList.add("is-up");
        var dl = card.querySelector(".live-stats");
        p.stats.forEach(function (s) {
          if (d[s[0]] == null) return;
          dl.insertAdjacentHTML("beforeend", "<div><dt>" + fmt.format(d[s[0]]) + "</dt><dd>" + s[1] + "</dd></div>");
        });
        if (stamp && d.generated_at) {
          stamp.textContent = "Data generated " + new Date(d.generated_at).toLocaleString("en-IN", {
            dateStyle: "medium", timeStyle: "short" }) + (d.seed != null ? " · seed " + d.seed : "");
        }
      })
      .catch(function () {
        card.querySelector(".live-state").textContent = "Unavailable right now";
      });
  });
})();
