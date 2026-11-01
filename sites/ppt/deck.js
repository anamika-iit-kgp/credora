/* Credora deck engine: navigation, fragments, timelines, packets on paths, per-slide scenes.
   Resting DOM = final state. On entering a slide the engine plays each element in from a start
   state (WAAPI, fill: backwards), and runs SMIL packets along the diagram paths. Print, ?print,
   ?static and prefers-reduced-motion skip the motion and show the final state. */
(function () {
  "use strict";

  /* ======================================================================================
     DATA: numbers shown on the slides. Values come from README.md (measured on the live
     deployment). A value written as {{NAME}} is a placeholder still to fill: it renders with a
     dashed amber outline on screen so it cannot be missed, and plain in print.
     ====================================================================================== */
  var DATA = {
    RUN_TOTAL: "17.5 s",            // RUN_ANALYSIS, 13 steps, 1,000 companies, one r6i.xlarge node
    RUN_SECONDS: "17.5",
    AUC_CHAMPION: "0.756",          // gradient-boosted trees, monotonic (TRAIN_PD), hold-out
    GINI_CHAMPION: "0.512",
    AUC_CHALLENGER: "0.769",        // logistic regression scorecard (TRAIN_SCORECARD), same hold-out
    GINI_CHALLENGER: "0.538",
    CHALLENGER_GRADES: "713",       // grades the challenger would change on the last run, of 1,000
    CHALLENGER_DECISIONS: "62",     // decisions it would change (42 refer to approve, 20 approve to refer)
    ANOMALY_FLAGGED: "30",          // Isolation Forest flags, of 1,000 (CONFIG ANOMALY_CONTAMINATION_PCT = 3)
    ANOMALY_REFERRED: "4",          // APPROVE that became REFER because of the flag
    CERTIFIED_METRICS: "16",        // CREDORA_SEM.PORTFOLIO
    RM_BOOK: "25",                  // demo seed: companies assigned to RM001 (exasol/sql/14_seed_rm_book.sql)
    T_RISK_MODEL: "<0.1 s", // step 8 "Risk model": 2 ms in run R20261031-2109
    // Published run R20261031-1923: 530 APPROVE, 202 REFER, 268 DECLINE. Offers 1,168.9 crore against
    // a credit need on file of 1,252.3 crore, negotiation room up to 1,414.2 crore. Top 50: 258.7 crore,
    // 10.82% average rate, 21.2% RAROC. These are written on slide 4 directly.
  };

  /* RUN_ANALYSIS steps: [no, name, kind, seconds (number, or a DATA key), rows out]
     Per-step times: docs/WHY_EXASOL.md and README.md section 7. */
  var RUN_STEPS = [
    [1, "Refresh virtual schemas", "sql", 1.8, "3"],
    [2, "Read credit needs and customer master", "sql", 0.3, "1,000"],
    [3, "CIBIL consumer reports", "api", 1.0, "3,492"],
    [4, "CIBIL commercial reports", "api", 0.6, "1,000"],
    [5, "GST returns", "api", 1.6, "71,665"],
    [6, "Account Aggregator", "api", 3.6, "5,775"],
    [7, "Features over Oracle (pushdown)", "sql", 3.6, "1,000"],
    [8, "Risk model ready", "lua", "T_RISK_MODEL", "1"],
    [9, "Score PD (ML UDF)", "py", 1.9, "1,000"],
    [10, "Flag anomalies (Isolation Forest)", "py", 1.3, "1,000"],
    [11, "Decide offer and negotiation limit", "sql", 0.07, "1,000"],
    [12, "Rank with PREFERRING", "sql", 0.03, "63"],
    [13, "Shadow-score the challenger", "py", 1.7, "1,000"]
  ];
  var LANG = { sql: "SQL", api: "UDF · API", py: "UDF", lua: "Lua" };

  /* README section 14, "Built with Exasol open source. Thank you." */
  var OSS = [
    ["exasol-labs", "exasol-personal-local-starterkit", "The starter kit (exakit 0.2.3) Credora began on, with local Exasol, MCP setup, exapump and pyexasol"],
    ["exasol", "exasol-personal", "Exasol Personal and its launcher (2.3.0, Exasol 2026.1.0), the database itself, deployed on AWS with one command"],
    ["exasol", "oracle-virtual-schema", "VS_CBS reads core banking in RDS Oracle live, with pushdown"],
    ["exasol-labs", "adbc-vs-rs", "VS_CIF and VS_LOS read the MySQL customer master and PostgreSQL loan origination live through ADBC"],
    ["exasol-labs", "language-container-rs", "The Rust script language container that runs the adbc-vs-rs adapter"],
    ["exasol", "script-languages-release", "The Python 3 and Java containers behind the API, ML and AI UDFs"],
    ["exasol-labs", "exasol-semantic-views", "CREDORA_SEM.PORTFOLIO, certified metrics shared by the app and the AI"],
    ["exasol-labs", "preprocessor-framework", "Owns the SQL preprocessor slot and routes semantic SQL per role"],
    ["exasol", "mcp-server", "exasol-mcp-server 2.3.0. Ask Credora's AI queries Exasol through it, as the signed-in role's user"],
    ["exasol", "pyexasol", "The Python driver used by the backend and the deploy tool"],
    ["exasol-labs", "exapump", "SQL and bulk-load CLI from the starter kit, used while building"],
    ["exasol", "virtual-schemas", "The virtual schema framework the Oracle adapter builds on"]
  ];

  var COLORS = { db: "#a78bfa", ext: "#94a3b8", exa: "#5fc33b", fe: "#22d3ee", svc: "#34d399", q: "#fb923c", sec: "#fb7185", cloud: "#fbbf24" };
  var SVGNS = "http://www.w3.org/2000/svg";
  var EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
  var EASE_IO = "cubic-bezier(0.77, 0, 0.175, 1)";

  var root = document.documentElement;
  root.classList.remove("no-js");
  var params = new URLSearchParams(location.search);
  var PRINT = params.has("print");
  var ALL = params.has("all") || PRINT;
  var REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var STILL = PRINT || REDUCED || params.has("static");
  if (PRINT) root.classList.add("print");

  var stage = document.getElementById("stage");
  var viewport = document.getElementById("viewport");
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var N = slides.length;
  var cur = -1, step = 0, uid = 0;
  var timers = [], cleanups = [];

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function isPh(v) { return /^\{\{.*\}\}$/.test(String(v)); }

  /* ---------------------------------------------------------------- data fill */
  $$("[data-k]").forEach(function (el) {
    var v = DATA[el.getAttribute("data-k")];
    if (v === undefined) return;
    el.textContent = v;
    if (isPh(v)) el.classList.add("ph");
  });

  /* ---------------------------------------------------------------- per-slide footer */
  slides.forEach(function (s, i) {
    if (i === 0 || i === N - 1) return;
    var f = document.createElement("div");
    f.className = "sf";
    f.innerHTML = '<img src="../_assets/credora-gem.svg" alt=""><span>Credora · ExaThon India 2026</span><span class="grow"></span>' +
      '<img class="sf-x" src="../_assets/exasol-x-on-dark.svg" alt=""><span>Exasol Personal</span><span class="n">' + (i + 1) + " / " + N + "</span>";
    s.appendChild(f);
  });

  /* ---------------------------------------------------------------- animation presets */
  function baseT(el) {
    var t = el instanceof SVGElement ? el.getAttribute("transform") : null;
    if (!t) return "";
    return t.replace(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/g, "translate($1px, $2px)")
            .replace(/translate\(\s*([-\d.]+)\s*\)/g, "translate($1px, 0px)")
            .replace(/rotate\(\s*([-\d.]+)\s*\)/g, "rotate($1deg)") + " ";
  }
  function around(el, sx, sy, fx, fy) {
    var b; try { b = el.getBBox(); } catch (e) { b = { x: 0, y: 0, width: 0, height: 0 }; }
    var cx = b.x + b.width * fx, cy = b.y + b.height * fy;
    return "translate(" + cx + "px, " + cy + "px) scale(" + sx + ", " + sy + ") translate(" + (-cx) + "px, " + (-cy) + "px)";
  }
  var drawn = [];
  function play(el, extra) {
    var kind = el.getAttribute("data-a") || "rise";
    var delay = (extra || 0) + (+el.getAttribute("data-d") || 0);
    var isSvg = el instanceof SVGElement && el.tagName.toLowerCase() !== "svg";
    var bt = baseT(el);
    var o = { duration: 560, delay: delay, easing: EASE, fill: "backwards" };
    var kf;
    if (kind === "draw" && el.classList.contains("dash")) kind = "fade";
    switch (kind) {
      case "fade": kf = [{ opacity: 0 }, { opacity: 1 }]; o.duration = 520; break;
      case "left": kf = [{ opacity: 0, transform: bt + "translateX(-24px)" }, { opacity: 1, transform: bt + "translateX(0px)" }]; break;
      case "slide": kf = [{ transform: bt + "translateX(-36px)" }, { transform: bt + "translateX(0px)" }]; o.duration = 900; o.easing = EASE_IO; break;
      case "pop":
        if (isSvg) kf = [{ opacity: 0, transform: bt + around(el, 0.9, 0.9, 0.5, 0.5) }, { opacity: 1, transform: bt + around(el, 1, 1, 0.5, 0.5) }];
        else kf = [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "scale(1)" }];
        o.duration = 520; break;
      case "growy":
        if (isSvg) kf = [{ transform: bt + around(el, 1, 0.001, 0.5, 1) }, { transform: bt + around(el, 1, 1, 0.5, 1) }];
        else { el.style.transformOrigin = "50% 100%"; kf = [{ transform: "scaleY(0.001)" }, { transform: "scaleY(1)" }]; }
        o.duration = 700; break;
      case "grow":
        if (isSvg) kf = [{ transform: bt + around(el, 0.001, 1, 0, 0.5) }, { transform: bt + around(el, 1, 1, 0, 0.5) }];
        else { el.style.transformOrigin = "0 50%"; kf = [{ transform: "scaleX(0.001)" }, { transform: "scaleX(1)" }]; }
        o.duration = 900; break;
      case "swing":
        kf = [{ transform: "translate(56px, 78px) rotate(-100deg) translate(-56px, -78px)" }, { transform: "translate(56px, 78px) rotate(0deg) translate(-56px, -78px)" }];
        el.style.transformBox = "view-box"; el.style.transformOrigin = "0 0";
        o.duration = 1100; o.easing = EASE_IO; break;
      case "draw":
        if (el.tagName.toLowerCase() === "path") {
          el.setAttribute("pathLength", "1");
          el.style.markerEnd = "none";
          drawn.push(el);
          kf = [{ strokeDasharray: "1 1", strokeDashoffset: 1 }, { strokeDasharray: "1 1", strokeDashoffset: 0 }];
          o.duration = 700; o.easing = EASE_IO;
          var a = el.animate(kf, o);
          a.onfinish = function () { el.style.markerEnd = ""; };
          return a;
        }
        kf = [{ opacity: 0 }, { opacity: 1 }]; break;
      default: /* rise */
        kf = [{ opacity: 0, transform: bt + "translateY(18px)" }, { opacity: 1, transform: bt + "translateY(0px)" }];
    }
    return el.animate(kf, o);
  }

  /* ---------------------------------------------------------------- packets (SMIL along paths) */
  function packet(path, opt, i) {
    if (!path.id) path.id = "pk" + (++uid);
    var color = COLORS[opt.color] || opt.color || "#94a3b8";
    var el;
    if (opt.tok) {
      el = svgEl("g", { "class": "pk", opacity: "0" });
      var w = Math.round(opt.tok.length * 7.6 + 20);
      svgEl("rect", { x: -w / 2, y: -12, width: w, height: 24, rx: 12, fill: "#020617", stroke: color, "stroke-width": 1.6 }, el);
      var t = svgEl("text", { x: 0, y: 4.5, "text-anchor": "middle", fill: color, style: "font-family:var(--mono);font-size:12.5px;font-weight:500" }, el);
      t.textContent = opt.tok;
    } else {
      el = svgEl("circle", { "class": "pk", r: 5.5, fill: color, opacity: "0" });
    }
    var a = Math.max(opt.win[0], 0.001), b = Math.min(opt.win[1], 0.999), e = 0.03;
    var p0 = opt.rev ? 1 : 0, p1 = 1 - p0;
    var kt, kp;
    if (opt.bounce) { kt = [0, a, (a + b) / 2, b, 1]; kp = [p0, p0, p1, p0, p0]; }
    else { kt = [0, a, b, 1]; kp = [p0, p0, p1, p1]; }
    var common = { begin: "indefinite", dur: opt.dur + "s", repeatCount: opt.once ? "1" : "indefinite", fill: opt.once ? "freeze" : "remove" };
    var am = svgEl("animateMotion", Object.assign({ calcMode: "linear", keyTimes: kt.join(";"), keyPoints: kp.join(";") }, common), el);
    var mp = svgEl("mpath", {}, am);
    mp.setAttribute("href", "#" + path.id);
    mp.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#" + path.id);
    var op = svgEl("animate", Object.assign({ attributeName: "opacity", values: "0;0;1;1;0;0", keyTimes: [0, a, a + e, b - e, b, 1].join(";") }, common), el);
    /* labelled tokens ride above the boxes; dots slide under them, as if entering */
    var top = path.ownerSVGElement, flat = true;
    for (var q = path.parentNode; q && q !== top; q = q.parentNode) if (q.getAttribute && q.getAttribute("transform")) flat = false;
    if (opt.tok && flat && top) top.appendChild(el); else path.parentNode.insertBefore(el, path.nextSibling);
    el.setAttribute("data-of", path.id);
    var at = opt.beg + (i * opt.dur) / opt.n;
    try { am.beginElementAt(at); op.beginElementAt(at); } catch (err) { /* SMIL unavailable: no packets */ }
    return el;
  }
  function startPackets(scope) {
    if (STILL) return;
    scope.forEach(function (p) {
      var win = (p.getAttribute("data-win") || "0-1").split("-").map(Number);
      var opt = {
        color: p.getAttribute("data-pk"), dur: +p.getAttribute("data-dur") || 2, beg: +p.getAttribute("data-beg") || 0,
        n: +p.getAttribute("data-n") || 1, once: p.hasAttribute("data-once"), rev: p.hasAttribute("data-rev"),
        bounce: p.hasAttribute("data-bounce"), tok: p.getAttribute("data-tok"), win: win
      };
      for (var i = 0; i < opt.n; i++) packet(p, opt, i);
    });
  }
  function clearPackets(s) { $$(".pk", s).forEach(function (e) { e.remove(); }); }
  function fragOf(el) { var f = el.closest("[data-f]"); return f ? +f.getAttribute("data-f") : 0; }

  /* ---------------------------------------------------------------- scenes */
  var scenes = {};
  function fmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function secOf(v) { if (typeof v === "number") return v; var d = DATA[v]; var n = parseFloat(d); return isNaN(n) ? null : n; }

  /* slide 2: the officer's counter ticks once per round of six systems */
  scenes.s2 = {
    play: function (s) {
      var t = $("#s2count"), n = 1;
      t.textContent = "company 1 of 1,000";
      var iv = setInterval(function () { n++; t.textContent = "company " + n + " of 1,000"; }, 8400);
      timers.push(iv);
    }
  };

  /* slide 8: 16 UDF instances (run 4 at a time on 4 cores) and their fan-out to the CONNECTION objects */
  scenes.s8 = {
    init: function (s) {
      var bars = $("#s8bars", s), fan = $("#s8fan", s);
      for (var i = 0; i < 16; i++) {
        var y = 40 + i * 34.5, ty = 165 + i * (290 / 15);
        var p = svgEl("path", { "class": "e c-ext thin nm", d: "M530 " + (y + 12) + " C 590 " + (y + 12) + " 580 " + ty + " 638 " + ty,
          "data-a": "draw", "data-d": 500 + i * 25, "data-pk": "ext", "data-dur": "1.5", "data-beg": (1.0 + (i % 4) * 0.12).toFixed(2) }, fan);
        p.style.strokeOpacity = ".55";
        var g = svgEl("g", { "class": "n t-svc", transform: "translate(410," + y + ")", "data-a": "pop", "data-d": 200 + i * 30 }, bars);
        svgEl("rect", { width: 120, height: 24, rx: 6 }, g);
        var t = svgEl("text", { x: 60, y: 17, "class": "mn-s mid", style: "fill:#f1f5f9" }, g);
        t.textContent = "UDF  b=" + i.toString(16);
      }
    }
  };

  /* slide 9: RUN_ANALYSIS steps light up one by one, the clock runs, RUN_LOG fills */
  function logLine(r) {
    var ms = secOf(r[3]);
    var msTxt = ms === null ? DATA[r[3]] : fmt(ms * 1000);
    function pad(s, n, left) { s = String(s); while (s.length < n) s = left ? " " + s : s + " "; return s; }
    return '<div><span>' + pad(r[0], 4, true) + '</span> <span class="ok">OK</span>     ' + pad(r[4], 9, true) + "  " + pad(msTxt, 7, true) + "</div>";
  }
  scenes.s9 = {
    init: function (s) {
      var ol = $("#s9steps", s), maxS = 10.4, w = 280;
      RUN_STEPS.forEach(function (r) {
        var sec = secOf(r[3]);
        var li = document.createElement("li");
        li.className = "st done";
        var tm = sec === null ? '<span class="ph">' + DATA[r[3]] + "</span>" : (sec < 0.1 ? "&lt;0.1 s" : sec.toFixed(1) + " s");
        li.innerHTML = '<span class="no">' + r[0] + '</span><span class="nm">' + r[1] + '</span><span class="lang ' + r[2] + '">' + LANG[r[2]] +
          '</span><span class="sb"><i style="width:' + Math.max(3, ((sec || 0.05) / maxS) * w) + 'px"></i></span><span class="tm">' + tm + "</span>";
        ol.appendChild(li);
      });
      this.final(s);
    },
    final: function (s) {
      $("#s9clock", s).innerHTML = DATA.RUN_SECONDS + "<small>s</small>";
      $("#s9log", s).innerHTML = RUN_STEPS.slice(-6).map(logLine).join("");
      $$(".st", s).forEach(function (li) { li.classList.add("done"); li.classList.remove("live"); });
    },
    play: function (s) {
      var lis = $$(".st", s), clock = $("#s9clock", s), log = $("#s9log", s);
      var total = parseFloat(DATA.RUN_SECONDS), known = 0;
      RUN_STEPS.forEach(function (r) { known += secOf(r[3]) || 0; });
      var k = total / known, acc = 0, t = 700, lines = [];
      lis.forEach(function (li) { li.classList.remove("done", "live"); li.querySelector(".sb i").style.transform = "scaleX(0.001)"; });
      clock.innerHTML = "0.0<small>s</small>";
      log.innerHTML = "";
      RUN_STEPS.forEach(function (r, i) {
        var sec = secOf(r[3]) || 0, vis = Math.max(260, sec * 330), li = lis[i], start = t, from = acc;
        after(start, function () {
          li.classList.add("live");
          li.querySelector(".sb i").animate([{ transform: "scaleX(0.001)" }, { transform: "scaleX(1)" }], { duration: vis, easing: "linear", fill: "forwards" });
          var t0 = performance.now();
          var iv = setInterval(function () {
            var f = Math.min(1, (performance.now() - t0) / vis);
            clock.innerHTML = ((from + sec * f) * k).toFixed(1) + "<small>s</small>";
            if (f >= 1) clearInterval(iv);
          }, 40);
          timers.push(iv);
        });
        after(start + vis, function () {
          li.classList.remove("live"); li.classList.add("done");
          li.querySelector(".sb i").style.transform = "";
          lines.push(logLine(r)); log.innerHTML = lines.slice(-6).join("");
          if (i === RUN_STEPS.length - 1) clock.innerHTML = DATA.RUN_SECONDS + "<small>s</small>";
        });
        acc += sec; t += vis + 90;
      });
    }
  };

  /* slide 10: the admin's approval switches IS_ACTIVE on */
  scenes.s10 = {
    step: function (s, k) {
      if (k !== 2 || STILL) return;
      var knob = $("#s10knob", s), track = $("#s10track", s);
      knob.animate([{ transform: "translateX(-20px)", fill: "#94a3b8" }, { transform: "translateX(0px)", fill: "#04110a" }], { duration: 520, delay: 1300, easing: EASE_IO, fill: "backwards" });
      track.animate([{ fill: "#334155" }, { fill: "#5fc33b" }], { duration: 520, delay: 1300, easing: "ease", fill: "backwards" });
    }
  };

  /* slide 11: PREFERRING skyline, peeled layer by layer */
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var sky = { pts: [], layers: [] };
  scenes.s11 = {
    init: function (s) {
      var r = rng(20261031), g = $("#s11dots", s), pts = [];
      for (var i = 0; i < 170; i++) {
        var pd = 0.004 + Math.pow(r(), 1.5) * 0.1;
        var ra = 16 + 30 * Math.pow(1 - pd / 0.11, 0.9) * (0.35 + 0.65 * r());
        var am = Math.pow(r(), 1.8);
        var x = 80 + ((pd - 0.004) / 0.104) * 760, y = 486 - ((ra - 16) / 31) * 450;
        var c = svgEl("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: (4 + am * 9).toFixed(1), "class": "dot" }, g);
        pts.push({ p: pd, r: ra, a: am, el: c, layer: 0 });
      }
      var left = pts.slice(), ranked = 0, L = 0, layers = [];
      while (ranked < 50 && L < 30) {
        L++;
        var front = left.filter(function (q) {
          return !left.some(function (o) { return o !== q && o.r >= q.r && o.p <= q.p && o.a >= q.a && (o.r > q.r || o.p < q.p || o.a > q.a); });
        });
        front.forEach(function (q) { q.layer = L; });
        layers.push(front); ranked += front.length;
        left = left.filter(function (q) { return !q.layer; });
      }
      sky.pts = pts; sky.layers = layers; sky.ranked = ranked;
      this.final(s);
    },
    meter: function (s, ranked, L, done) {
      $("#s11v", s).innerHTML = ranked + "<small> ranked · " + L + " layer" + (L === 1 ? "" : "s") + "</small>";
      $("#s11bar", s).style.transform = "scaleX(" + Math.min(1, ranked / 50) + ")";
      $("#s11p", s).textContent = done ? "50 reached: peeling stops, RANK_NO orders them" : "peeling layer " + L + " of the skyline";
    },
    final: function (s) {
      sky.pts.forEach(function (q) { q.el.setAttribute("class", q.layer ? "dot taken" : "dot"); });
      this.meter(s, sky.ranked, sky.layers.length, true);
    },
    play: function (s) {
      var self = this, ranked = 0;
      sky.pts.forEach(function (q) { q.el.setAttribute("class", "dot"); });
      self.meter(s, 0, 0, false);
      $("#s11p", s).textContent = "approved companies, before ranking";
      sky.layers.forEach(function (front, i) {
        after(1200 + i * 1250, function () {
          front.forEach(function (q) {
            q.el.setAttribute("class", "dot front");
            q.el.animate([{ transform: "scale(1.6)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }], { duration: 480, easing: EASE });
          });
          ranked += front.length;
          self.meter(s, ranked, i + 1, i === sky.layers.length - 1);
        });
        after(1200 + i * 1250 + 800, function () { front.forEach(function (q) { q.el.setAttribute("class", "dot taken"); }); });
      });
    }
  };
  /* circle scale needs its own origin */
  var dotStyle = document.createElement("style");
  dotStyle.textContent = ".sky .dot{transform-box:fill-box;transform-origin:center;transition:fill 300ms ease,stroke 300ms ease}";
  document.head.appendChild(dotStyle);

  /* slide 13: a refused query, then the RM's own view; rows filtered by CURRENT_USER */
  var ASSIGNED = [1, 4, 6, 9, 13, 16];
  scenes.s13 = {
    init: function (s) {
      var g = $("#s13rows", s);
      for (var i = 0; i < 18; i++) {
        var on = ASSIGNED.indexOf(i) >= 0;
        svgEl("rect", { x: (i % 6) * 78, y: Math.floor(i / 6) * 24, width: 66, height: 15, rx: 4, fill: on ? "#34d399" : "#64748b", opacity: on ? 1 : 0.22, "class": on ? "rw on" : "rw" }, g);
      }
      $$('svg [data-f="1"]', s).forEach(function (e) { e.setAttribute("data-a", "pop"); e.setAttribute("data-d", "1250"); });
      $$('.console [data-f="1"]', s).forEach(function (e, i) { e.setAttribute("data-a", "fade"); e.setAttribute("data-d", i ? "1350" : "0"); });
      $$('.console [data-f="2"]', s).forEach(function (e, i) { e.setAttribute("data-a", "fade"); e.setAttribute("data-d", i ? "1300" : "0"); });
    },
    step: function (s, k) {
      if (STILL) return;
      var p = $(k === 1 ? "#p12a" : "#p12b", s);
      packet(p, { color: k === 1 ? "sec" : "svc", tok: k === 1 ? "SELECT … DECISIONS" : "SELECT … V_RM_DECISIONS", dur: 1.3, beg: 0, n: 1, once: true, win: [0, 1] }, 0);
      if (k === 2) {
        $$(".rw", s).forEach(function (r) {
          if (r.classList.contains("on")) r.animate([{ fill: "#64748b", opacity: 0.22 }, { fill: "#34d399", opacity: 1 }], { duration: 500, delay: 1300, easing: "ease", fill: "backwards" });
        });
      }
    },
    enter: function (s, k) {
      /* before step 2 the RM's rows are not yet shown as returned */
      $$(".rw.on", s).forEach(function (r) { r.setAttribute("fill", k >= 2 ? "#34d399" : "#64748b"); r.setAttribute("opacity", k >= 2 ? "1" : "0.22"); });
    }
  };

  /* slide 16: the command types itself, then each deploy stage lights */
  scenes.s16 = {
    init: function (s) { $$(".deps div", s).forEach(function (d) { d.classList.add("lit"); }); },
    play: function (s) {
      var el = $("#s16cmd", s), full = "python deploy/credora.py deploy --env <name>", n = 0;
      el.textContent = "";
      after(900, function () {
        var iv = setInterval(function () { n++; el.textContent = full.slice(0, n); if (n >= full.length) clearInterval(iv); }, 22);
        timers.push(iv);
      });
      var deps = $$(".deps div", s);
      deps.forEach(function (d, i) { d.classList.remove("lit"); after(1800 + i * 150 + 300, function () { d.classList.add("lit"); }); });
    }
  };

  /* slide 17: volumes on a log scale; figures count up */
  var VOL = [
    ["Current-account transactions", "Oracle core banking", 850000, "~850,000", "db"],
    ["Other-bank transactions", "behind the Account Aggregator", 400000, "~400,000", "ext"],
    ["GST returns", "via the GSTN relay", 71217, "71,217", "ext"],
    ["Other-bank accounts", "via the Account Aggregator", 6000, "~6,000", "ext"],
    ["Past loans", "PostgreSQL, ~8% defaulted", 5000, "5,000", "db"],
    ["Credit reports", "CIBIL consumer + commercial", 4490, "4,490", "ext"],
    ["Partners", "MySQL customer master", 3500, "~3,500", "db"],
    ["Companies analysed", "the whole corporate book", 1000, "1,000", "exa"]
  ];
  scenes.s17 = {
    init: function (s) {
      var box = $("#s17vol", s);
      VOL.forEach(function (v, i) {
        var f = (Math.log10(v[2]) - 2) / 4;
        var row = document.createElement("div");
        row.className = "vol-r";
        row.innerHTML = '<div class="t">' + v[0] + "<small>" + v[1] + '</small></div><div class="b"><i data-a="grow" data-d="' + (150 + i * 70) + '" style="width:' + (f * 100).toFixed(1) + "%;background:" + COLORS[v[4]] + '"></i></div><div class="v">' + v[3] + "</div>";
        box.appendChild(row);
      });
      var ax = $(".vol-axis div", s);
      ax.innerHTML = "<span>100</span><span>1k</span><span>10k</span><span>100k</span><span>1M</span>";
    },
    play: countUp
  };
  function countUp(s) {
      $$("[data-count]", s).forEach(function (el) {
        var txt = el.textContent, target = parseFloat(txt);
        if (isNaN(target)) return;
        var dec = (txt.split(".")[1] || "").length, dur = 1300;
        el.textContent = (0).toFixed(dec);
        after(350, function () {
          var t0 = Date.now();
          var iv = setInterval(function () {
            var f = Math.min(1, (Date.now() - t0) / dur), e = 1 - Math.pow(1 - f, 3);
            el.textContent = f >= 1 ? txt : (target * e).toFixed(dec);
            if (f >= 1) clearInterval(iv);
          }, 30);
          timers.push(iv);
        });
        cleanups.push(function () { el.textContent = txt; });
      });
  }

  /* slide 4: the impact figures count up */
  scenes.s4 = { play: countUp };

  /* slide 19: screens linked to the Exasol features they prove */
  var FEAT = [
    ["fed", "Federation", "virtual schemas, pushdown", "db"],
    ["udf", "UDFs", "Python SET, CONNECTION objects", "svc"],
    ["ml", "Machine learning", "TRAIN_PD, BucketFS, IS_ACTIVE", "svc"],
    ["lua", "Lua orchestration", "RUN_ANALYSIS, RUN_LOG", "q"],
    ["rank", "Ranking", "PREFERRING skyline", "svc"],
    ["sem", "Semantics", "CREDORA_SEM, preprocessor", "db"],
    ["sec", "Security", "roles, V_RM_* views, purge", "sec"]
  ];
  var SCREENS = [
    ["Sources", "admin", ["fed"]],
    ["credora.link", "3rd party data via API", ["udf"]],
    ["Analysis runs", "loan operations, data scientist", ["lua", "fed", "udf"]],
    ["Company report", "loan operations", ["lua", "ml"]],
    ["Risk models, challenger", "data scientist", ["ml"]],
    ["Approvals", "admin, model activation, policy", ["ml", "lua"]],
    ["Top 50", "every role", ["rank"]],
    ["My book", "relationship manager", ["sec"]],
    ["Ask Credora", "every role", ["sem", "sec"]],
    ["Audit and purge", "admin", ["sec", "lua"]],
    ["Explain mode", "Exasol console · ⓘ glossary · control room", ["fed", "udf", "ml", "lua", "rank", "sem", "sec"]]
  ];
  scenes.s19 = {
    init: function (s) {
      var L = $("#s19left", s), R = $("#s19right", s), K = $("#s19links", s), fy = {};
      FEAT.forEach(function (f, j) {
        var y = 14 + j * 82;
        fy[f[0]] = { y: y + 32, c: f[3] };
        var g = svgEl("g", { "class": "n t-" + f[3], transform: "translate(1060," + y + ")", "data-a": "rise", "data-d": 120 + j * 50 }, R);
        svgEl("rect", { width: 380, height: 64, rx: 10 }, g);
        svgEl("text", { x: 16, y: 28, "class": "lbl-s" }, g).textContent = f[1];
        svgEl("text", { x: 16, y: 50, "class": "cap" }, g).textContent = f[2];
      });
      SCREENS.forEach(function (sc, i) {
        var y = 6 + i * 52, last = i === SCREENS.length - 1;
        var g = svgEl("g", { "class": "n " + (last ? "t-exa" : "t-fe"), transform: "translate(0," + y + ")", "data-a": "left", "data-d": 300 + i * 70 }, L);
        svgEl("rect", { width: 470, height: 44, rx: 9 }, g);
        svgEl("text", { x: 14, y: 28, "class": "lbl-s" }, g).textContent = sc[0];
        svgEl("text", { x: 456, y: 28, "class": "cap end" }, g).textContent = sc[1];
        sc[2].forEach(function (k, n) {
          var t = fy[k], y0 = y + 22;
          var p = svgEl("path", { "class": "e thin c-" + t.c + (last ? " dash nm" : ""), d: "M470 " + y0 + " C 760 " + y0 + " 770 " + t.y + " 1058 " + t.y,
            "data-a": "draw", "data-d": 700 + i * 110 + n * 40 }, K);
          if (last) p.style.strokeOpacity = ".45";
        });
      });
    }
  };

  /* slide 20: the open-source projects, from README section 14 */
  scenes.s20 = {
    init: function (s) {
      var box = $("#s20list", s);
      OSS.forEach(function (o, i) {
        var a = document.createElement("a");
        a.className = "oss-r";
        a.href = "https://github.com/" + o[0] + "/" + o[1];
        a.style.textDecoration = "none";
        a.setAttribute("data-a", "rise");
        a.setAttribute("data-d", String(150 + i * 55));
        a.innerHTML = '<svg class="ic" style="color:' + (o[0] === "exasol" ? "#5fc33b" : "#22d3ee") + '"><use href="#i-github"/></svg><div><div class="rp"><i' +
          (o[0] === "exasol" ? "" : ' class="lab"') + ">" + o[0] + "</i>/" + o[1] + "</div><p>" + o[2] + "</p></div>";
        box.appendChild(a);
      });
    }
  };

  /* ---------------------------------------------------------------- fragments */
  function maxStep(s) { var m = 0; $$("[data-f]", s).forEach(function (e) { m = Math.max(m, +e.getAttribute("data-f")); }); return m; }
  function setFragments(s, k) {
    $$("[data-f]", s).forEach(function (e) {
      var on = +e.getAttribute("data-f") <= k;
      e.style.opacity = on ? "" : "0";
      e.style.pointerEvents = on ? "" : "none";
    });
  }
  function reveal(s, k, extra) {
    var els = $$('[data-f="' + k + '"]', s);
    els.forEach(function (e) {
      e.style.opacity = ""; e.style.pointerEvents = "";
      if (STILL) { if (!PRINT) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease" }); return; }
      play(e, extra || 0);
      $$("[data-a]", e).forEach(function (c) { play(c, (extra || 0) + 120); });
    });
    var pk = $$("[data-pk]", s).filter(function (p) { return fragOf(p) === k; });
    startPackets(pk);
    var sc = scenes[s.id];
    if (sc && sc.step) sc.step(s, k);
  }

  /* ---------------------------------------------------------------- navigation */
  function leave(s) {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); cancelAnimationFrame(t); });
    timers = [];
    cleanups.forEach(function (f) { f(); }); cleanups = [];
    if (s.getAnimations) s.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
    drawn.forEach(function (p) { p.style.markerEnd = ""; }); drawn = [];
    clearPackets(s);
    var sc = scenes[s.id];
    if (sc && sc.final) sc.final(s);
    s.classList.remove("on");
  }
  function go(i, back) {
    i = Math.max(0, Math.min(N - 1, i));
    if (i === cur && !back) return;
    if (cur >= 0) leave(slides[cur]);
    cur = i;
    var s = slides[i];
    s.classList.add("on");
    step = back || ALL ? maxStep(s) : 0;
    setFragments(s, step);
    var sc = scenes[s.id];
    if (sc && sc.enter) sc.enter(s, step);
    if (!STILL) {
      $$("[data-a]", s).forEach(function (e) { if (!fragOf(e)) play(e, 0); });
      startPackets($$("[data-pk]", s).filter(function (p) { return !fragOf(p) || fragOf(p) <= step; }));
      if (sc && sc.play) sc.play(s);
      if (ALL && !back) for (var k = 1; k <= step; k++) { if (sc && sc.step) sc.step(s, k); }
    }
    ui();
  }
  function next() {
    var s = slides[cur];
    if (step < maxStep(s)) { step++; if (scenes[s.id] && scenes[s.id].enter) scenes[s.id].enter(s, step); reveal(s, step); ui(); }
    else if (cur < N - 1) go(cur + 1);
  }
  function prev() {
    var s = slides[cur];
    if (step > 0) {
      $$('[data-f="' + step + '"]', s).forEach(function (e) { e.getAnimations && e.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); }); });
      $$("[data-pk]", s).filter(function (p) { return fragOf(p) === step; }).forEach(function (p) {
        if (p.id) $$('.pk[data-of="' + p.id + '"]', s).forEach(function (x) { x.remove(); });
      });
      step--; setFragments(s, step);
      if (scenes[s.id] && scenes[s.id].enter) scenes[s.id].enter(s, step);
      ui();
    } else if (cur > 0) go(cur - 1, true);
  }

  var countEl = document.getElementById("count"), prog = document.getElementById("prog");
  var notes = document.getElementById("notes"), notesBody = document.getElementById("notesBody"), notesTitle = document.getElementById("notesTitle");
  function ui() {
    countEl.textContent = (cur + 1) + " / " + N;
    prog.style.transform = "scaleX(" + ((cur + 1) / N) + ")";
    var h = "#" + (cur + 1);
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
    var sn = $("aside.sn", slides[cur]);
    notesTitle.textContent = "Slide " + (cur + 1) + " · speaker notes";
    notesBody.textContent = sn ? sn.textContent : "";
    document.title = "Credora · " + (cur + 1) + "/" + N + " · ExaThon India 2026";
  }
  function fromHash() {
    var m = /^#s?(\d+)/.exec(location.hash);
    return m ? (+m[1] - 1) : 0;
  }

  /* ---------------------------------------------------------------- scale to fit */
  function fit() {
    if (PRINT) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var phone = vw < 760 && vh > vw;
    root.classList.toggle("phone", phone);
    var k = phone ? vw / 1600 : Math.min(vw / 1600, vh / 900);
    stage.style.transform = "scale(" + k + ")";
    if (phone) {
      viewport.style.height = Math.ceil(900 * k) + "px";
      stage.style.left = "0px"; stage.style.top = "0px";
      notes.hidden = false;
    } else {
      viewport.style.height = "";
      stage.style.left = ((vw - 1600 * k) / 2) + "px";
      stage.style.top = ((vh - 900 * k) / 2) + "px";
      notes.hidden = !notesOn;
    }
  }

  /* ---------------------------------------------------------------- input */
  var notesOn = false;
  function toggleNotes() { notesOn = !notesOn; notes.hidden = !notesOn && !root.classList.contains("phone"); document.getElementById("bNotes").setAttribute("aria-pressed", String(notesOn)); }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
  }
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter" && e.target === document.body) { e.preventDefault(); next(); }
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") { e.preventDefault(); prev(); }
    else if (k === "Home") go(0);
    else if (k === "End") go(N - 1);
    else if (k === "f" || k === "F") toggleFull();
    else if (k === "n" || k === "N") toggleNotes();
    else if (k === "Escape" && notesOn) toggleNotes();
  });
  document.getElementById("bNext").addEventListener("click", next);
  document.getElementById("bPrev").addEventListener("click", prev);
  document.getElementById("bNotes").addEventListener("click", toggleNotes);
  document.getElementById("bFull").addEventListener("click", toggleFull);
  var swiped = false;
  viewport.addEventListener("click", function (e) {
    if (swiped) { swiped = false; return; }
    if (e.target.closest("a, button")) return;
    if (e.clientX < window.innerWidth * 0.25) prev(); else next();
  });
  var tx = null, ty = null;
  viewport.addEventListener("touchstart", function (e) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  viewport.addEventListener("touchend", function (e) {
    if (tx === null) return;
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) { swiped = true; if (dx < 0) next(); else prev(); setTimeout(function () { swiped = false; }, 400); }
    tx = ty = null;
  }, { passive: true });
  window.addEventListener("hashchange", function () { var i = fromHash(); if (i !== cur) go(i); });
  window.addEventListener("resize", fit);

  /* the toolbar fades when the pointer rests */
  var bar = document.getElementById("bar"), idleT;
  function wake() { bar.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(function () { bar.classList.add("idle"); }, 2600); }
  document.addEventListener("mousemove", wake); wake();

  /* PDF link: served next to the page on ppt.<domain>; in the repo it sits in media/ */
  if (location.protocol === "file:") document.getElementById("bPdf").href = "../../media/presentation.pdf";

  /* print from the browser: finish everything first */
  window.addEventListener("beforeprint", function () {
    if (cur >= 0) leave(slides[cur]);
    slides.forEach(function (s) { setFragments(s, 99); });
  });
  window.addEventListener("afterprint", function () { var i = cur; cur = -1; go(i); });

  /* ---------------------------------------------------------------- start */
  $$("svg.dg").forEach(function (d) { d.setAttribute("preserveAspectRatio", "xMidYMin meet"); });
  slides.forEach(function (s) { var sc = scenes[s.id]; if (sc && sc.init) sc.init(s); });
  if (PRINT) {
    slides.forEach(function (s) { s.classList.add("on"); setFragments(s, 99); var sc = scenes[s.id]; if (sc && sc.enter) sc.enter(s, 99); });
    $$("aside.sn").forEach(function () {});
    return;
  }
  fit();
  go(fromHash());
})();
