(() => {
  "use strict";

  const QS = window.QUESTIONS || [];
  const BY_ID = Object.fromEntries(QS.map(q => [q.id, q]));
  const WEEKS = [...new Set(QS.map(q => q.week))].sort((a, b) => a - b);
  const LETTERS = "ABCDEFGHIJ";
  const AUTO_NEXT_MS = 650;

  const $app = document.getElementById("app");
  const $tabs = document.getElementById("tabs");
  const $modes = document.getElementById("modes");
  const root = document.documentElement;

  // iOS Safari only fires :active styles when a touch listener exists
  document.addEventListener("touchstart", () => {}, { passive: true });

  /* ---------- Collapsing header: hide on scroll down, reveal on scroll up ---------- */
  let lastY = window.scrollY, ticking = false;
  const showHeader = () => root.classList.remove("hdr-hidden");
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = window.scrollY;
      const max = root.scrollHeight - window.innerHeight;
      // ignore Safari's rubber-band overscroll at either end
      if (y <= 60) showHeader();
      else if (y < max - 2) {
        const dy = y - lastY;
        if (dy > 6) root.classList.add("hdr-hidden");
        else if (dy < -6) showHeader();
        else return; // small jitter: keep lastY so slow scrolls still accumulate
      }
      lastY = Math.max(0, Math.min(y, max));
    });
  }, { passive: true });

  /* ---------- Storage (guarded: Safari private mode can throw) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("plq2:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("plq2:" + k, JSON.stringify(v)); } catch {} },
  };

  const settings = Object.assign({ shuffleQ: true, shuffleO: true, mix: [] }, store.get("settings", {}));
  settings.mix = settings.mix.filter(w => WEEKS.includes(w));
  let stats = Object.assign({ correct: 0, wrong: 0 }, store.get("stats", {}));
  let sessions = store.get("sessions", {});
  for (const k in sessions) if (!sessions[k].order.every(id => BY_ID[id])) delete sessions[k];
  let key = store.get("key", "all");
  if (!validKey(key)) key = "all";

  let mode = "quiz";           // quiz | study | settings
  let studyWeek = "all";
  let studyQuery = "";
  let pending = [];            // MSQ selections (original indices)
  let advanceTimer = 0;

  const saveSettings = () => store.set("settings", settings);
  const saveStats = () => store.set("stats", stats);
  const saveSessions = () => { store.set("sessions", sessions); store.set("key", key); };

  /* ---------- Helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const range = n => Array.from({ length: n }, (_, i) => i);
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const isMulti = q => q.answer.length > 1;
  const haptic = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  const byOrder = (a, b) => BY_ID[a].week - BY_ID[b].week || BY_ID[a].n - BY_ID[b].n;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const ICON = {
    check: '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1900);
  }

  /* ---------- Sets & sessions ---------- */
  function validKey(k) {
    return k === "all" || (k === "mix" && settings.mix.length > 0) || (/^w\d+$/.test(k) && WEEKS.includes(+k.slice(1)));
  }
  function idsFor(k) {
    const weeks = k === "all" ? WEEKS : k === "mix" ? settings.mix : [+k.slice(1)];
    return QS.filter(q => weeks.includes(q.week)).map(q => q.id).sort(byOrder);
  }
  function labelFor(k) {
    return k === "all" ? "All weeks" : k === "mix" ? "Mix · weeks " + settings.mix.join(", ") : "Week " + k.slice(1);
  }
  function newSession(ids, retry = false) {
    const order = settings.shuffleQ ? shuffle(ids) : ids.slice().sort(byOrder);
    const perms = {};
    for (const id of order) {
      const opts = BY_ID[id].options;
      // keep True/False in natural order — shuffling them is just confusing
      const tf = opts.length === 2 && /^true$/i.test(opts[0]);
      perms[id] = settings.shuffleO && !tf ? shuffle(range(opts.length)) : range(opts.length);
    }
    return { order, idx: 0, perms, res: {}, finished: false, retry };
  }
  function cur() {
    if (!sessions[key]) { sessions[key] = newSession(idsFor(key)); saveSessions(); }
    return sessions[key];
  }
  function tally(s) {
    let c = 0, w = 0;
    for (const id of s.order) { const r = s.res[id]; if (r) r.ok ? c++ : w++; }
    return { c, w };
  }

  /* ---------- Shell ---------- */
  function go(m, { scroll = true } = {}) {
    clearTimeout(advanceTimer);
    mode = m;
    pending = [];
    $modes.querySelectorAll("button").forEach(b => b.setAttribute("aria-current", String(b.dataset.mode === m)));
    renderTabs();
    ({ quiz: renderQuiz, study: renderStudy, settings: renderSettings })[m]();
    if (scroll) { window.scrollTo(0, 0); showHeader(); }
  }

  function renderTabs() {
    const items = [{ id: "all", label: "All" }, ...WEEKS.map(w => ({ id: "w" + w, label: String(w) }))];
    if (mode !== "study" && settings.mix.length) items.push({ id: "mix", label: "Mix" });
    const active = mode === "study" ? (studyWeek === "all" ? "all" : "w" + studyWeek) : mode === "quiz" ? key : null;
    $tabs.innerHTML = items.map(t =>
      `<button class="tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === active}" aria-label="${t.id === "all" ? "All weeks" : t.id === "mix" ? "Custom mix" : "Week " + t.label}">${t.label}</button>`
    ).join("");
    // keep the active tab visible inside the horizontal strip without scrolling the page
    const a = $tabs.querySelector('[aria-selected="true"]');
    if (a) {
      const l = a.offsetLeft - $tabs.offsetLeft, r = l + a.offsetWidth;
      if (l < $tabs.scrollLeft + 40) $tabs.scrollLeft = l - 40;
      else if (r > $tabs.scrollLeft + $tabs.clientWidth - 40) $tabs.scrollLeft = r - $tabs.clientWidth + 40;
    }
  }

  /* ---------- Quiz ---------- */
  function renderQuiz() {
    const s = cur();
    if (s.finished) return renderResults();
    const id = s.order[s.idx];
    const q = BY_ID[id];
    const perm = s.perms[id];
    const res = s.res[id];
    const t = tally(s);
    const answered = Object.keys(s.res).length;

    $app.innerHTML = `
      <section class="view">
        <div class="meta">
          <span>${s.idx + 1} / ${s.order.length} · Week ${q.week}${s.retry ? " · retry" : ""}</span>
          <span class="score"><span class="c"><b id="nC">${t.c}</b> correct</span><span class="w"><b id="nW">${t.w}</b> wrong</span></span>
        </div>
        <div class="progress"><i id="prog" style="width:${(answered / s.order.length) * 100}%"></i></div>

        <h1 class="question">${esc(q.q)}</h1>
        ${isMulti(q) ? `<p class="qhint">Select all that apply, then check.</p>` : ""}

        <div class="options" id="opts">
          ${perm.map(orig => `
            <button class="opt" data-orig="${orig}"><span class="txt">${esc(q.options[orig])}</span></button>`).join("")}
        </div>
        <div id="after"></div>
        <nav class="qnav" id="actions" aria-label="Question navigation"></nav>
        <div class="links"><button class="textbtn" data-act="restart">Restart this set</button><button class="textbtn" data-act="end">End &amp; see results</button></div>
        <div class="kbd-hint"><kbd>1</kbd>–<kbd>${perm.length}</kbd> answer · <kbd>Enter</kbd> next · <kbd>←</kbd> back · ${esc(labelFor(key))}</div>
      </section>`;

    if (res) paintResult(q, res, false);
    renderAfter(); renderActions();
  }

  function renderAfter() {
    const s = cur();
    const id = s.order[s.idx];
    const q = BY_ID[id];
    const res = s.res[id];
    const el = document.getElementById("after");
    if (res) {
      el.innerHTML = explainHTML(q, res);
    } else if (isMulti(q)) {
      el.innerHTML = `<div class="next-wrap"><button class="btn btn-solid btn-block" data-act="check" ${pending.length ? "" : "disabled"}>Check answer</button></div>`;
    } else el.innerHTML = "";
  }

  function renderActions() {
    const s = cur();
    const res = s.res[s.order[s.idx]];
    const last = s.idx === s.order.length - 1;
    // Next is filled once the question is answered; before that it works as a skip
    document.getElementById("actions").innerHTML = `
      <button class="btn btn-line" data-act="prev" ${s.idx ? "" : "disabled"} aria-label="Previous question">${ICON.left}<span>Previous</span></button>
      <button class="btn ${res ? "btn-solid" : "btn-line"}" data-act="next" aria-label="${last ? "Finish" : "Next question"}"><span>${last ? (res ? "Results" : "Finish") : "Next"}</span>${ICON.right}</button>`;
  }

  function explainHTML(q, res) {
    const ans = q.answer.map(a => esc(q.options[a])).join(", ");
    return `
      <div class="explain">
        <div class="lbl">${res.ok ? "Correct" : "Answer"}</div>
        <div class="ans">${ans}</div>
        <p>${esc(q.explanation)}</p>
        ${q.note ? `<div class="note"><b>Answer-key note:</b> ${esc(q.note)}</div>` : ""}
      </div>`;
  }

  function paintResult(q, res, animate) {
    document.querySelectorAll("#opts .opt").forEach(b => {
      const o = +b.dataset.orig;
      const isAns = q.answer.includes(o);
      const picked = res.chosen.includes(o);
      b.disabled = true;
      b.classList.remove("sel");
      if (isAns) { b.classList.add("correct"); b.insertAdjacentHTML("beforeend", ICON.check); }
      else if (picked) { b.classList.add("wrong"); b.insertAdjacentHTML("beforeend", ICON.x); if (animate) b.classList.add("shake"); }
      else b.classList.add("dim");
    });
  }

  function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }

  function submit(chosen) {
    const s = cur();
    const id = s.order[s.idx];
    const q = BY_ID[id];
    if (s.res[id]) return;
    const ok = sameSet(chosen, q.answer);
    s.res[id] = { chosen, ok };
    ok ? stats.correct++ : stats.wrong++;
    saveSessions(); saveStats();
    pending = [];

    const t = tally(s);
    const nC = document.getElementById("nC"), nW = document.getElementById("nW");
    nC.textContent = t.c; nW.textContent = t.w;
    bump(ok ? nC : nW);
    document.getElementById("prog").style.width = (Object.keys(s.res).length / s.order.length) * 100 + "%";
    paintResult(q, { chosen, ok }, true);
    haptic(ok ? 12 : [20, 60, 20]);

    if (ok) {
      const at = s.idx, k = key;
      advanceTimer = setTimeout(() => { if (mode === "quiz" && key === k && cur().idx === at) next(); }, AUTO_NEXT_MS);
      return;
    }
    renderAfter(); renderActions();
    // bring the explanation into view above the sticky Previous/Next bar
    requestAnimationFrame(() => {
      const ex = document.querySelector("#after .explain");
      if (!ex) return;
      const limit = document.getElementById("actions").getBoundingClientRect().top;
      const r = ex.getBoundingClientRect();
      if (r.bottom > limit - 8) window.scrollBy({ top: Math.min(r.bottom - limit + 16, r.top - 80), behavior: "smooth" });
    });
  }

  function choose(orig) {
    const s = cur();
    const q = BY_ID[s.order[s.idx]];
    if (s.res[q.id]) return;
    if (isMulti(q)) {
      pending = pending.includes(orig) ? pending.filter(x => x !== orig) : [...pending, orig];
      document.querySelectorAll("#opts .opt").forEach(b => b.classList.toggle("sel", pending.includes(+b.dataset.orig)));
      renderAfter();
    } else submit([orig]);
  }

  function next() {
    clearTimeout(advanceTimer);
    const s = cur();
    if (s.idx < s.order.length - 1) { s.idx++; saveSessions(); go("quiz"); }
    else finish();
  }
  function prev() {
    clearTimeout(advanceTimer);
    const s = cur();
    if (s.idx > 0) { s.idx--; saveSessions(); go("quiz"); }
  }
  function finish() {
    cur().finished = true;
    saveSessions();
    go("quiz");
  }

  /* ---------- Results ---------- */
  function renderResults() {
    const s = cur();
    const t = tally(s);
    const answered = t.c + t.w;
    const skipped = s.order.length - answered;
    const pct = answered ? Math.round((t.c / answered) * 100) : 0;
    const wrongIds = s.order.filter(id => s.res[id] && !s.res[id].ok);
    const weeks = [...new Set(s.order.map(id => BY_ID[id].week))].sort((a, b) => a - b);
    const msg = !answered ? "Nothing answered yet" : pct >= 90 ? "Outstanding." : pct >= 75 ? "Great work." : pct >= 50 ? "Good effort." : "Keep practising.";

    $app.innerHTML = `
      <section class="view">
        <div class="meta"><span>${esc(labelFor(key))}${s.retry ? " · retry" : ""}</span><span>Finished</span></div>
        <div class="big">${pct}%</div>
        <div class="result-sub">${msg}</div>
        <p class="result-line">${t.c} correct · ${t.w} wrong${skipped ? ` · ${skipped} skipped` : ""}</p>
        <div class="stack">
          ${wrongIds.length ? `<button class="btn btn-solid btn-block" data-act="retryWrong">Retry ${plural(wrongIds.length, "mistake")}</button>` : ""}
          <button class="btn ${wrongIds.length ? "btn-line" : "btn-solid"} btn-block" data-act="restartNow">Restart ${esc(labelFor(key).split(" · ")[0].toLowerCase())}</button>
        </div>

        ${weeks.length > 1 ? `
          <h2 class="h2">By week</h2>
          ${weeks.map(w => {
            const ids = s.order.filter(id => BY_ID[id].week === w);
            const c = ids.filter(id => s.res[id] && s.res[id].ok).length;
            return `<div class="wk-row"><span>Week ${w}</span><span class="bar"><i style="width:${(c / ids.length) * 100}%"></i></span><span class="n">${c}/${ids.length}</span></div>`;
          }).join("")}` : ""}

        ${wrongIds.length ? `
          <h2 class="h2">Review mistakes</h2>
          ${wrongIds.map(id => studyCard(BY_ID[id], s.res[id].chosen)).join("")}` : ""}
      </section>`;
  }

  /* ---------- Study ---------- */
  function studyCard(q, chosen) {
    return `
      <article class="sq">
        <div class="n">Week ${q.week} · Question ${q.n}</div>
        <h3>${esc(q.q)}</h3>
        <ol>${q.options.map((o, i) => {
          const cls = q.answer.includes(i) ? "ok" : chosen && chosen.includes(i) ? "picked" : "";
          return `<li class="${cls}"><b>${LETTERS[i]}</b><span>${esc(o)}</span></li>`;
        }).join("")}</ol>
        <p class="why">${esc(q.explanation)}</p>
        ${q.note ? `<div class="note"><b>Answer-key note:</b> ${esc(q.note)}</div>` : ""}
      </article>`;
  }

  function renderStudy() {
    $app.innerHTML = `
      <section class="view">
        <input id="q" class="search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"
          placeholder="Search questions and answers" value="${esc(studyQuery)}">
        <div id="studyList"></div>
      </section>`;
    renderStudyList();
  }

  function renderStudyList() {
    const term = studyQuery.trim().toLowerCase();
    const weeks = studyWeek === "all" ? WEEKS : [studyWeek];
    const match = q => !term || (q.q + " " + q.options.join(" ") + " " + q.explanation).toLowerCase().includes(term);
    let total = 0;
    const html = weeks.map(w => {
      const qs = QS.filter(q => q.week === w && match(q));
      total += qs.length;
      if (!qs.length) return "";
      return `<h2 class="wk-head">Week ${w}</h2>${qs.map(q => studyCard(q)).join("")}`;
    }).join("");
    document.getElementById("studyList").innerHTML = total
      ? `<div class="study-count">${plural(total, "question")}${term ? " match" : ""} · correct answers in green</div>${html}`
      : `<div class="empty">No questions match “${esc(studyQuery)}”.</div>`;
  }

  /* ---------- Settings ---------- */
  function renderSettings() {
    const draft = settings.mix.length ? settings.mix : [];
    const n = QS.filter(q => draft.includes(q.week)).length;
    const total = stats.correct + stats.wrong;
    $app.innerHTML = `
      <section class="view">
        <h1 class="h2" style="margin-top:0">Mix weeks</h1>
        <p class="lead">Pick any weeks to practise together. It shows up as the “Mix” tab.</p>
        <div class="wgrid">
          ${WEEKS.map(w => `<button class="wbox" data-week="${w}" aria-pressed="${draft.includes(w)}">Week ${w}<small>10 Qs</small></button>`).join("")}
        </div>
        <div class="row-btns">
          <button class="textbtn" data-act="mixAll">Select all</button>
          <button class="textbtn" data-act="mixNone">Clear</button>
        </div>
        <button class="btn btn-solid btn-block" data-act="startMix" ${n ? "" : "disabled"}>${n ? `Start mix · ${plural(n, "question")}` : "Pick at least one week"}</button>

        <h2 class="h2">Order</h2>
        ${toggleHTML("shuffleQ", "Shuffle questions", "Off = week-wise, in the original order")}
        ${toggleHTML("shuffleO", "Shuffle options", "Randomise the answer order")}

        <h2 class="h2">Your score</h2>
        <div class="stats">
          <div class="stat c"><b>${stats.correct}</b><span>Correct</span></div>
          <div class="stat"><b>${stats.wrong}</b><span>Wrong</span></div>
          <div class="stat"><b>${total ? Math.round((stats.correct / total) * 100) + "%" : "–"}</b><span>Accuracy</span></div>
        </div>
        <div class="row-btns">
          <button class="textbtn" data-act="resetStats">Reset score</button>
          <button class="textbtn" data-act="resetAll">Reset all progress</button>
        </div>
      </section>`;
  }

  function toggleHTML(k, label, desc) {
    return `<button class="toggle" role="switch" data-toggle="${k}" aria-checked="${!!settings[k]}">
      <span><span class="t">${label}</span><span class="d">${desc}</span></span><span class="switch" aria-hidden="true"></span>
    </button>`;
  }

  /* ---------- Theme ---------- */
  document.getElementById("themeBtn").addEventListener("click", () => {
    const dark = root.dataset.theme !== "dark";
    if (dark) root.dataset.theme = "dark"; else delete root.dataset.theme;
    document.getElementById("themeColor").content = dark ? "#8E0D19" : "#B3101F";
    store.set("theme", dark ? "dark" : "light");
    haptic(5);
  });

  /* ---------- Events ---------- */
  $tabs.addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    haptic(5);
    if (mode === "study") {
      studyWeek = b.dataset.tab === "all" ? "all" : +b.dataset.tab.slice(1);
      return go("study");
    }
    key = b.dataset.tab;
    store.set("key", key);
    go("quiz");
  });

  document.addEventListener("click", e => {
    const m = e.target.closest("[data-mode]");
    if (m) return go(m.dataset.mode);

    const opt = e.target.closest("#opts .opt");
    if (opt && !opt.disabled) return choose(+opt.dataset.orig);

    const wb = e.target.closest(".wbox[data-week]");
    if (wb) {
      const w = +wb.dataset.week;
      settings.mix = settings.mix.includes(w) ? settings.mix.filter(x => x !== w) : [...settings.mix, w].sort((a, b) => a - b);
      delete sessions.mix;
      if (key === "mix" && !settings.mix.length) key = "all";
      saveSettings(); saveSessions(); haptic(5);
      return go("settings", { scroll: false });
    }

    const tg = e.target.closest("[data-toggle]");
    if (tg) {
      settings[tg.dataset.toggle] = !settings[tg.dataset.toggle];
      tg.setAttribute("aria-checked", String(settings[tg.dataset.toggle]));
      // rebuild sets you haven't started yet so the change applies right away
      for (const k in sessions) if (!Object.keys(sessions[k].res).length) delete sessions[k];
      saveSettings(); saveSessions(); haptic(5);
      return;
    }

    const a = e.target.closest("[data-act]");
    if (!a || a.disabled) return;
    const s = sessions[key];
    switch (a.dataset.act) {
      case "next": next(); break;
      case "prev": prev(); break;
      case "check": if (pending.length) submit(pending.slice()); break;
      case "end":
        if (!Object.keys(s.res).length || confirm("End this round and see your results?")) finish();
        break;
      case "restart":
        if (!Object.keys(s.res).length || confirm(`Restart ${labelFor(key)}? Progress in this set will be cleared.`)) {
          sessions[key] = newSession(idsFor(key)); saveSessions(); go("quiz");
        }
        break;
      case "restartNow": sessions[key] = newSession(idsFor(key)); saveSessions(); go("quiz"); break;
      case "retryWrong":
        sessions[key] = newSession(s.order.filter(id => s.res[id] && !s.res[id].ok), true); saveSessions(); go("quiz"); break;
      case "mixAll": settings.mix = WEEKS.slice(); delete sessions.mix; saveSettings(); go("settings", { scroll: false }); break;
      case "mixNone": settings.mix = []; delete sessions.mix; if (key === "mix") key = "all"; saveSettings(); saveSessions(); go("settings", { scroll: false }); break;
      case "startMix": key = "mix"; sessions.mix = newSession(idsFor("mix")); saveSessions(); go("quiz"); break;
      case "resetStats":
        if (confirm("Reset your all-time correct/wrong counts?")) { stats = { correct: 0, wrong: 0 }; saveStats(); go("settings", { scroll: false }); }
        break;
      case "resetAll":
        if (confirm("Clear progress in every week and reset your score?")) {
          sessions = {}; stats = { correct: 0, wrong: 0 }; saveSessions(); saveStats(); toast("All progress cleared"); go("settings", { scroll: false });
        }
        break;
    }
  });

  document.addEventListener("input", e => {
    if (e.target.id === "q") { studyQuery = e.target.value; renderStudyList(); }
  });

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches && e.target.matches("input, textarea")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (mode !== "quiz") return;
    const s = cur();
    if (s.finished) return;
    const id = s.order[s.idx];
    const perm = s.perms[id];
    const k = e.key.toLowerCase();
    let pos = -1;
    if (/^[1-9]$/.test(k)) pos = +k - 1;
    else if (/^[a-j]$/.test(k)) pos = LETTERS.toLowerCase().indexOf(k);
    if (pos >= 0 && pos < perm.length) { e.preventDefault(); return choose(perm[pos]); }
    if (k === "enter" || k === "arrowright") {
      e.preventDefault();
      if (!s.res[id] && pending.length) submit(pending.slice());
      else next();
    } else if (k === "arrowleft") { e.preventDefault(); prev(); }
  });

  /* ---------- Boot ---------- */
  go("quiz");
})();
