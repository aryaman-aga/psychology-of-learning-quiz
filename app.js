(() => {
  "use strict";

  const QS = window.QUESTIONS || [];
  const RUNS = window.RUNS || [];
  const BY_ID = Object.fromEntries(QS.map(q => [q.id, q]));
  const QIDX = Object.fromEntries(QS.map((q, i) => [q.id, i]));
  const RUN_IDS = RUNS.map(r => r.id);
  // week labels per run, in course order ("0" … "7A", "7B" … "12")
  const RUN_WEEKS = Object.fromEntries(RUNS.map(r => [r.id, [...new Set(QS.filter(q => q.run === r.id).map(q => q.week))]]));
  const WEEK_NUMS = [...new Set(QS.map(q => q.wn))].sort((a, b) => a - b);
  // one question per repeated group (newest run first, since QS is ordered newest → oldest)
  const REPEAT_IDS = (() => { const seen = new Set(), out = []; for (const q of QS) if (q.rep && !seen.has(q.grp)) { seen.add(q.grp); out.push(q.id); } return out; })();
  const LETTERS = "ABCDEFGHIJ";
  const AUTO_NEXT_MS = 650;

  const $app = document.getElementById("app");
  const $tabs = document.getElementById("tabs");
  const $modes = document.querySelectorAll("header [data-mode]");
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

  const settings = Object.assign({ shuffleQ: true, shuffleO: true, mixRuns: RUN_IDS.slice(), mixWeeks: [] }, store.get("settings", {}));
  settings.mixRuns = (settings.mixRuns || []).filter(r => RUN_IDS.includes(r));
  settings.mixWeeks = (settings.mixWeeks || []).map(Number).filter(w => WEEK_NUMS.includes(w));
  delete settings.mix; // older single-run mix setting
  let stats = Object.assign({ correct: 0, wrong: 0 }, store.get("stats", {}));
  let seen = store.get("seen", {});          // id → 1 (last answer right) | 0 (wrong)
  let sessions = store.get("sessions", {});
  // migrate keys from the single-run version ("all", "w3", "mix") and drop anything stale
  for (const k of Object.keys(sessions)) {
    const nk = k === "all" || k[0] === "w" ? RUN_IDS[0] + "|" + k : k;
    if (nk !== k) { sessions[nk] = sessions[nk] || sessions[k]; delete sessions[k]; }
  }
  for (const k in sessions) if (!validKey(k) || !sessions[k].order.every(id => BY_ID[id])) delete sessions[k];

  let run = store.get("run", RUN_IDS[0]);
  if (!RUN_IDS.includes(run)) run = RUN_IDS[0];
  let key = store.get("key", run + "|all");
  if (key === "all" || /^w/.test(key)) key = RUN_IDS[0] + "|" + key;
  if (!validKey(key)) key = run + "|all";

  let mode = "home";           // home | quiz | study | settings
  let studyWeek = "all";
  let studyQuery = "";
  let pending = [];            // MSQ selections (original indices)
  let advanceTimer = 0;

  const saveSettings = () => store.set("settings", settings);
  const saveStats = () => { store.set("stats", stats); store.set("seen", seen); };
  const saveSessions = () => { store.set("sessions", sessions); store.set("key", key); store.set("run", run); };

  /* ---------- Helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const range = n => Array.from({ length: n }, (_, i) => i);
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const isMulti = q => q.answer.length > 1;
  const haptic = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
  const byOrder = (a, b) => QIDX[a] - QIDX[b];
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const runOf = k => k.split("|")[0];
  const tabOf = k => k.split("|")[1];
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  const ICON = {
    check: '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  };

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1900);
  }

  /* ---------- Sets & sessions ---------- */
  // keys: "<run>|all", "<run>|w<label>", "mix", "repeats"
  function validKey(k) {
    if (k === "repeats") return REPEAT_IDS.length > 0;
    if (k === "mix") return idsFor("mix").length > 0;
    const [r, t] = k.split("|");
    return RUN_IDS.includes(r) && (t === "all" || (!!t && t[0] === "w" && RUN_WEEKS[r].includes(t.slice(1))));
  }
  function idsFor(k) {
    if (k === "repeats") return REPEAT_IDS.slice();
    if (k === "mix") return QS.filter(q => settings.mixRuns.includes(q.run) && settings.mixWeeks.includes(q.wn)).map(q => q.id);
    const r = runOf(k), t = tabOf(k);
    return QS.filter(q => q.run === r && (t === "all" || q.week === t.slice(1))).map(q => q.id);
  }
  function labelFor(k) {
    if (k === "repeats") return "Repeated questions";
    if (k === "mix") return `Mix · ${plural(settings.mixRuns.length, "year")} · ${plural(settings.mixWeeks.length, "week")}`;
    const t = tabOf(k);
    return `${runOf(k)} · ${t === "all" ? "All weeks" : "Week " + t.slice(1)}`;
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
  function openSet(k) {
    key = k;
    if (k.includes("|")) run = runOf(k);
    saveSessions();
    go("quiz");
  }

  /* ---------- Shell ---------- */
  function go(m, { scroll = true } = {}) {
    clearTimeout(advanceTimer);
    mode = m;
    pending = [];
    $modes.forEach(b => b.setAttribute("aria-current", String(b.dataset.mode === m)));
    root.dataset.page = m;
    renderTabs();
    ({ home: renderHome, quiz: renderQuiz, study: renderStudy, settings: renderSettings })[m]();
    if (scroll) { window.scrollTo(0, 0); showHeader(); }
  }

  function renderTabs() {
    if (mode === "home" || mode === "settings") { $tabs.innerHTML = ""; $tabs.hidden = true; return; }
    $tabs.hidden = false;
    const items = [{ id: "all", label: "All" }, ...RUN_WEEKS[run].map(w => ({ id: "w" + w, label: w }))];
    let active = mode === "study" ? (studyWeek === "all" ? "all" : "w" + studyWeek) : null;
    if (mode === "quiz") {
      if (key === "mix" || key === "repeats") items.push({ id: key, label: key === "mix" ? "Mix" : "Repeats" });
      active = key.includes("|") ? (runOf(key) === run ? tabOf(key) : null) : key;
    }
    $tabs.innerHTML = `
      <label class="tab tab-run" title="Choose year">
        <select id="runSel" aria-label="Year">${RUNS.map(r => `<option value="${r.id}" ${r.id === run ? "selected" : ""}>${r.id}</option>`).join("")}</select>
        <span>${run}</span>${ICON.down}
      </label>` +
      items.map(t => `<button class="tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === active}" aria-label="${t.id === "all" ? "All weeks" : t.id === "mix" ? "Custom mix" : t.id === "repeats" ? "Repeated questions" : "Week " + t.label}">${t.label}</button>`).join("");
    // keep the active tab visible inside the horizontal strip without scrolling the page
    const a = $tabs.querySelector('[aria-selected="true"]');
    if (a) {
      const l = a.offsetLeft - $tabs.offsetLeft, r = l + a.offsetWidth;
      if (l < $tabs.scrollLeft + 40) $tabs.scrollLeft = l - 40;
      else if (r > $tabs.scrollLeft + $tabs.clientWidth - 40) $tabs.scrollLeft = r - $tabs.clientWidth + 40;
    }
  }

  /* ---------- Home ---------- */
  function runProgress(r) {
    const ids = QS.filter(q => q.run === r).map(q => q.id);
    let done = 0, right = 0;
    for (const id of ids) if (id in seen) { done++; right += seen[id]; }
    return { total: ids.length, done, right };
  }

  function renderHome() {
    const total = stats.correct + stats.wrong;
    const last = sessions[key];
    const lastT = last && tally(last);
    const canContinue = last && !last.finished && (lastT.c + lastT.w > 0 || last.idx > 0);
    const repDone = REPEAT_IDS.filter(id => id in seen).length;

    $app.innerHTML = `
      <section class="view home">
        <div class="kicker">NPTEL · IIT Kharagpur · Prof. Atasi Mohanty</div>
        <h1 class="hero">Psychology of Learning</h1>
        <p class="lead">Every weekly assignment from ${RUNS.length} runs of the course: ${QS.length} questions with answers and explanations.</p>

        <div class="stats">
          <div class="stat c"><b>${stats.correct}</b><span>Correct</span></div>
          <div class="stat"><b>${stats.wrong}</b><span>Wrong</span></div>
          <div class="stat"><b>${total ? pct(stats.correct, total) + "%" : "–"}</b><span>Accuracy</span></div>
        </div>

        ${canContinue ? `
          <button class="continue" data-open="${esc(key)}">
            <span><small>Continue</small><b>${esc(labelFor(key))}</b><em>Question ${last.idx + 1} of ${last.order.length} · ${lastT.c} right · ${lastT.w} wrong</em></span>
            ${ICON.right}
          </button>` : ""}

        <h2 class="h2">By year</h2>
        <div class="runs">
          ${RUNS.map(r => {
            const p = runProgress(r.id);
            return `
              <button class="run" data-open="${r.id}|all">
                <span class="run-top"><b>${r.id}</b>${ICON.right}</span>
                <span class="run-sub">${esc(r.label)}</span>
                <span class="run-sub">${plural(RUN_WEEKS[r.id].length, "set")} · ${r.count} questions</span>
                <span class="bar"><i style="width:${pct(p.done, p.total)}%"></i></span>
                <span class="run-sub">${p.done ? `${p.done}/${p.total} tried · ${pct(p.right, p.done)}% right` : "Not started"}</span>
              </button>`;
          }).join("")}
        </div>

        ${REPEAT_IDS.length ? `
          <h2 class="h2">Asked more than once</h2>
          <p class="lead">${plural(REPEAT_IDS.length, "question")} came up in two or more years. The examiners keep coming back to these, so learn them first.</p>
          <button class="btn btn-solid btn-block" data-open="repeats">Practise repeats · ${REPEAT_IDS.length}${repDone ? ` (${repDone} tried)` : ""}</button>` : ""}

        <h2 class="h2">Mixed drill</h2>
        <p class="lead">Pick any years and weeks and practise them together.</p>
        <button class="btn btn-line btn-block" data-mode="settings">Build a mix</button>

        <p class="credit">Past-year questions (2023–2025) sourced from <a href="https://mynptel.vercel.app/psychology-of-learning.html" target="_blank" rel="noopener">mynptel.vercel.app</a>. The explanations here are written separately and checked against the answer keys.</p>
      </section>`;
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
    const where = key.includes("|") ? `Week ${q.week}` : `${q.run} · Week ${q.week}`;

    $app.innerHTML = `
      <section class="view">
        <div class="meta">
          <span>${s.idx + 1} / ${s.order.length} · ${where}${s.retry ? " · retry" : ""}</span>
          <span class="score"><span class="c"><b id="nC">${t.c}</b> correct</span><span class="w"><b id="nW">${t.w}</b> wrong</span></span>
        </div>
        <div class="progress"><i id="prog" style="width:${(answered / s.order.length) * 100}%"></i></div>
        ${q.rep ? `<div class="rep">Asked in ${q.rep.join(", ")}</div>` : ""}

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
    const q = BY_ID[s.order[s.idx]];
    const res = s.res[q.id];
    const el = document.getElementById("after");
    if (res) el.innerHTML = explainHTML(q, res);
    else if (isMulti(q)) el.innerHTML = `<div class="next-wrap"><button class="btn btn-solid btn-block" data-act="check" ${pending.length ? "" : "disabled"}>Check answer</button></div>`;
    else el.innerHTML = "";
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
    seen[id] = ok ? 1 : 0;
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
    const p = pct(t.c, answered);
    const wrongIds = s.order.filter(id => s.res[id] && !s.res[id].ok);
    // group by year+week when the set spans several years
    const groupOf = id => (key.includes("|") ? "" : BY_ID[id].run + " · ") + "Week " + BY_ID[id].week;
    const groups = [...new Set(s.order.slice().sort(byOrder).map(groupOf))];
    const msg = !answered ? "Nothing answered yet" : p >= 90 ? "Outstanding." : p >= 75 ? "Great work." : p >= 50 ? "Good effort." : "Keep practising.";

    $app.innerHTML = `
      <section class="view">
        <div class="meta"><span>${esc(labelFor(key))}${s.retry ? " · retry" : ""}</span><span>Finished</span></div>
        <div class="big">${p}%</div>
        <div class="result-sub">${msg}</div>
        <p class="result-line">${t.c} correct · ${t.w} wrong${skipped ? ` · ${skipped} skipped` : ""}</p>
        <div class="stack">
          ${wrongIds.length ? `<button class="btn btn-solid btn-block" data-act="retryWrong">Retry ${plural(wrongIds.length, "mistake")}</button>` : ""}
          <button class="btn ${wrongIds.length ? "btn-line" : "btn-solid"} btn-block" data-act="restartNow">Restart this set</button>
          <button class="btn btn-line btn-block" data-mode="home">Home</button>
        </div>

        ${groups.length > 1 ? `
          <h2 class="h2">By week</h2>
          ${groups.map(g => {
            const ids = s.order.filter(id => groupOf(id) === g);
            const c = ids.filter(id => s.res[id] && s.res[id].ok).length;
            return `<div class="wk-row"><span>${esc(g)}</span><span class="bar"><i style="width:${(c / ids.length) * 100}%"></i></span><span class="n">${c}/${ids.length}</span></div>`;
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
        <div class="n">${q.run} · Week ${q.week} · Question ${q.n}${q.rep ? ` · <span class="rep-inline">asked in ${q.rep.join(", ")}</span>` : ""}</div>
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
    if (studyWeek !== "all" && !RUN_WEEKS[run].includes(studyWeek)) studyWeek = "all";
    $app.innerHTML = `
      <section class="view">
        <input id="q" class="search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"
          placeholder="Search ${run} questions and answers" value="${esc(studyQuery)}">
        <div id="studyList"></div>
      </section>`;
    renderStudyList();
  }

  function renderStudyList() {
    const term = studyQuery.trim().toLowerCase();
    const weeks = studyWeek === "all" ? RUN_WEEKS[run] : [studyWeek];
    const match = q => !term || (q.q + " " + q.options.join(" ") + " " + q.explanation).toLowerCase().includes(term);
    let total = 0;
    const html = weeks.map(w => {
      const qs = QS.filter(q => q.run === run && q.week === w && match(q));
      total += qs.length;
      if (!qs.length) return "";
      return `<h2 class="wk-head">Week ${w}</h2>${qs.map(q => studyCard(q)).join("")}`;
    }).join("");
    document.getElementById("studyList").innerHTML = total
      ? `<div class="study-count">${run} · ${plural(total, "question")}${term ? " match" : ""} · correct answers in green</div>${html}`
      : `<div class="empty">No questions match “${esc(studyQuery)}”.</div>`;
  }

  /* ---------- Settings ---------- */
  function renderSettings() {
    const n = idsFor("mix").length;
    $app.innerHTML = `
      <section class="view">
        <h1 class="h2" style="margin-top:0">Mixed drill</h1>
        <p class="lead">Pick years and weeks to practise together. It opens as a “Mix” tab.</p>
        <div class="sub-h">Years</div>
        <div class="wgrid">
          ${RUNS.map(r => `<button class="wbox" data-mixrun="${r.id}" aria-pressed="${settings.mixRuns.includes(r.id)}">${r.id}<small>${r.count} Qs</small></button>`).join("")}
        </div>
        <div class="sub-h">Weeks</div>
        <div class="wgrid">
          ${WEEK_NUMS.map(w => `<button class="wbox" data-mixweek="${w}" aria-pressed="${settings.mixWeeks.includes(w)}">Week ${w}<small>${QS.filter(q => q.wn === w && settings.mixRuns.includes(q.run)).length} Qs</small></button>`).join("")}
        </div>
        <div class="row-btns">
          <button class="textbtn" data-act="mixAll">Select all</button>
          <button class="textbtn" data-act="mixNone">Clear weeks</button>
        </div>
        <button class="btn btn-solid btn-block" data-act="startMix" ${n ? "" : "disabled"}>${n ? `Start mix · ${plural(n, "question")}` : "Pick at least one year and week"}</button>

        <h2 class="h2">Order</h2>
        ${toggleHTML("shuffleQ", "Shuffle questions", "Off = week-wise, in the original order")}
        ${toggleHTML("shuffleO", "Shuffle options", "Randomise the answer order")}

        <h2 class="h2">Reset</h2>
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
  $tabs.addEventListener("change", e => {
    if (e.target.id !== "runSel") return;
    run = e.target.value;
    if (mode === "study") { studyWeek = "all"; saveSessions(); return go("study"); }
    // stay on the same week if the new year has it
    const t = key.includes("|") ? tabOf(key) : "all";
    openSet(validKey(run + "|" + t) ? run + "|" + t : run + "|all");
  });

  $tabs.addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    haptic(5);
    if (mode === "study") {
      studyWeek = b.dataset.tab === "all" ? "all" : b.dataset.tab.slice(1);
      return go("study");
    }
    const t = b.dataset.tab;
    openSet(t === "mix" || t === "repeats" ? t : run + "|" + t);
  });

  document.addEventListener("click", e => {
    const m = e.target.closest("[data-mode]");
    if (m) return go(m.dataset.mode);

    const o = e.target.closest("[data-open]");
    if (o) return openSet(o.dataset.open);

    const opt = e.target.closest("#opts .opt");
    if (opt && !opt.disabled) return choose(+opt.dataset.orig);

    const mr = e.target.closest("[data-mixrun]");
    if (mr) {
      const r = mr.dataset.mixrun;
      settings.mixRuns = settings.mixRuns.includes(r) ? settings.mixRuns.filter(x => x !== r) : RUN_IDS.filter(x => x === r || settings.mixRuns.includes(x));
      delete sessions.mix; saveSettings(); saveSessions(); haptic(5);
      return go("settings", { scroll: false });
    }
    const mw = e.target.closest("[data-mixweek]");
    if (mw) {
      const w = +mw.dataset.mixweek;
      settings.mixWeeks = settings.mixWeeks.includes(w) ? settings.mixWeeks.filter(x => x !== w) : [...settings.mixWeeks, w].sort((a, b) => a - b);
      delete sessions.mix; saveSettings(); saveSessions(); haptic(5);
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
      case "mixAll": settings.mixRuns = RUN_IDS.slice(); settings.mixWeeks = WEEK_NUMS.slice(); delete sessions.mix; saveSettings(); go("settings", { scroll: false }); break;
      case "mixNone": settings.mixWeeks = []; delete sessions.mix; saveSettings(); saveSessions(); go("settings", { scroll: false }); break;
      case "startMix": sessions.mix = newSession(idsFor("mix")); openSet("mix"); break;
      case "resetStats":
        if (confirm("Reset your all-time correct/wrong counts?")) { stats = { correct: 0, wrong: 0 }; saveStats(); toast("Score reset"); }
        break;
      case "resetAll":
        if (confirm("Clear progress in every set and reset your score?")) {
          sessions = {}; seen = {}; stats = { correct: 0, wrong: 0 }; saveSessions(); saveStats(); toast("All progress cleared");
        }
        break;
    }
  });

  document.addEventListener("input", e => {
    if (e.target.id === "q") { studyQuery = e.target.value; renderStudyList(); }
  });

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches && e.target.matches("input, textarea, select")) {
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
  go("home");
})();
