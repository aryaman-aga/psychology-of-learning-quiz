(() => {
  "use strict";

  const QS = window.QUESTIONS || [];
  const BY_ID = Object.fromEntries(QS.map(q => [q.id, q]));
  const WEEKS = [...new Set(QS.map(q => q.week))].sort((a, b) => a - b);
  const LETTERS = "ABCDEFGHIJ";
  const AUTO_NEXT_MS = 650;

  const $app = document.getElementById("app");
  const $bar = document.getElementById("bottombar");
  const $tabs = document.getElementById("tabs");

  // iOS Safari only fires :active styles when a touch listener exists
  document.addEventListener("touchstart", () => {}, { passive: true });

  /* ---------- Storage (guarded: Safari private mode can throw) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("plq:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("plq:" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("plq:" + k); } catch {} },
  };

  let settings = Object.assign({ weeks: WEEKS.slice(), shuffleQ: true, shuffleO: true }, store.get("settings", {}));
  settings.weeks = settings.weeks.filter(w => WEEKS.includes(w));
  let stats = Object.assign({ correct: 0, wrong: 0 }, store.get("stats", {}));
  let session = store.get("session", null);
  if (session && !session.order.every(id => BY_ID[id])) session = null;

  let view = "home";          // home | quiz | results | study
  let practiceView = "home";
  let pending = [];           // MSQ selections (original indices)
  let advanceTimer = 0;
  let studyQuery = "";

  const saveSettings = () => store.set("settings", settings);
  const saveStats = () => store.set("stats", stats);
  const saveSession = () => session ? store.set("session", session) : store.del("session");

  /* ---------- Helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const range = n => Array.from({ length: n }, (_, i) => i);
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const isMulti = q => q.answer.length > 1;
  const weekLabel = w => `Week ${w}`;
  const haptic = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    search: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>',
  };

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast glass";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1900);
  }

  function setBar(html) {
    if (!html) { $bar.hidden = true; $bar.innerHTML = ""; return; }
    $bar.innerHTML = html;
    $bar.hidden = false;
  }

  function go(v, { scroll = true } = {}) {
    clearTimeout(advanceTimer);
    view = v;
    if (v !== "study") practiceView = v;
    $tabs.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === (v === "study" ? "study" : "practice"))));
    render();
    if (scroll) window.scrollTo(0, 0);
  }

  function render() {
    ({ home: renderHome, quiz: renderQuiz, results: renderResults, study: renderStudy })[view]();
  }

  /* ---------- Session ---------- */
  function poolForWeeks(weeks) {
    return QS.filter(q => weeks.includes(q.week)).sort((a, b) => a.week - b.week || a.n - b.n).map(q => q.id);
  }

  function startSession(ids) {
    const order = settings.shuffleQ ? shuffle(ids) : ids.slice();
    const perms = {};
    for (const id of order) {
      const n = BY_ID[id].options.length;
      // keep True/False in natural order — shuffling them is just confusing
      const tf = n === 2 && /^true$/i.test(BY_ID[id].options[0]);
      perms[id] = settings.shuffleO && !tf ? shuffle(range(n)) : range(n);
    }
    session = { order, idx: 0, perms, res: {}, finished: false };
    saveSession();
    pending = [];
    go("quiz");
  }

  const tally = () => {
    let c = 0, w = 0;
    for (const id of session.order) { const r = session.res[id]; if (r) r.ok ? c++ : w++; }
    return { c, w };
  };

  /* ---------- Home ---------- */
  function renderHome() {
    const pool = poolForWeeks(settings.weeks);
    const total = stats.correct + stats.wrong;
    const acc = total ? Math.round((stats.correct / total) * 100) + "%" : "—";
    const canResume = session && !session.finished;
    const t = canResume ? tally() : null;

    $app.innerHTML = `
      <section class="view">
        <div class="hero">
          <h1>Psychology of Learning</h1>
          <p>NPTEL weekly assignments · Weeks ${WEEKS[0]}–${WEEKS[WEEKS.length - 1]} · ${QS.length} questions</p>
        </div>

        ${canResume ? `
        <div class="card glass resume">
          <div class="grow">
            <b>Continue where you left off</b>
            <p>Question ${Math.min(session.idx + 1, session.order.length)} of ${session.order.length} · ${t.c} right · ${t.w} wrong</p>
          </div>
          <button class="btn btn-ghost" data-act="resume">Resume</button>
        </div>` : ""}

        <div class="card glass">
          <div class="card-head">
            <div><h2>Weeks</h2><div class="sub">${settings.weeks.length} of ${WEEKS.length} selected</div></div>
            <div class="link-btns">
              <button class="link-btn" data-act="all">All</button>
              <button class="link-btn" data-act="none">None</button>
            </div>
          </div>
          <div class="weeks">
            ${WEEKS.map(w => `
              <button class="chip" data-week="${w}" aria-pressed="${settings.weeks.includes(w)}">
                <b>${weekLabel(w)}</b><small>${QS.filter(q => q.week === w).length} Qs</small>
              </button>`).join("")}
          </div>
        </div>

        <div class="card glass">
          <div class="toggles">
            ${toggleHTML("shuffleQ", "Shuffle questions", "Off = week-wise in original order")}
            ${toggleHTML("shuffleO", "Shuffle options", "Randomise A/B/C/D each time")}
          </div>
        </div>

        <div class="card glass">
          <div class="card-head">
            <div><h2>Your score</h2><div class="sub">All attempts so far</div></div>
            ${total ? `<button class="link-btn" data-act="reset">Reset</button>` : ""}
          </div>
          <div class="stats">
            <div class="stat good"><b>${stats.correct}</b><span>Correct</span></div>
            <div class="stat bad"><b>${stats.wrong}</b><span>Wrong</span></div>
            <div class="stat"><b>${acc}</b><span>Accuracy</span></div>
          </div>
        </div>
      </section>`;

    setBar(`<button class="btn btn-primary" data-act="start" ${pool.length ? "" : "disabled"}>
      ${ICON.play}<span>${pool.length ? `Start · ${pool.length} question${pool.length === 1 ? "" : "s"}` : "Select at least one week"}</span>
    </button>`);
  }

  function toggleHTML(key, label, desc) {
    return `<button class="toggle" role="switch" data-toggle="${key}" aria-checked="${!!settings[key]}">
      <span><span class="t-label">${label}</span><span class="t-desc">${desc}</span></span>
      <span class="switch" aria-hidden="true"></span>
    </button>`;
  }

  /* ---------- Quiz ---------- */
  function renderQuiz() {
    if (!session) return go("home");
    const id = session.order[session.idx];
    const q = BY_ID[id];
    const perm = session.perms[id];
    const res = session.res[id];
    const t = tally();
    const answered = Object.keys(session.res).length;
    const pct = (answered / session.order.length) * 100;
    const multi = isMulti(q);
    if (res) pending = [];

    $app.innerHTML = `
      <section class="view quiz">
        <div class="qmeta">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span class="pill week">${weekLabel(q.week)} · Q${q.n}</span>
            <span class="qcount">${session.idx + 1}/${session.order.length}</span>
          </div>
          <div class="score">
            <span class="pill good" id="pGood">${ICON.check}${t.c}</span>
            <span class="pill bad" id="pBad">${ICON.x}${t.w}</span>
          </div>
        </div>
        <div class="progress"><i style="width:${pct}%"></i></div>

        <h2 class="question">${esc(q.q)}</h2>
        <div class="qhint">${multi ? "Select all that apply, then check." : "&nbsp;"}</div>

        <div class="options" id="opts">
          ${perm.map((orig, k) => `
            <button class="opt glass" data-orig="${orig}">
              <span class="key">${LETTERS[k]}</span>
              <span class="txt">${esc(q.options[orig])}</span>
              <span class="mark">${ICON.check}</span>
            </button>`).join("")}
        </div>
        <div id="explainSlot"></div>
        <div class="kbd-hint"><kbd>1</kbd>–<kbd>${perm.length}</kbd> or <kbd>A</kbd>–<kbd>${LETTERS[perm.length - 1]}</kbd> to answer · <kbd>Enter</kbd> next · <kbd>←</kbd> back</div>
      </section>`;

    if (res) paintResult(q, res, false);
    else if (multi) paintPending();
    quizBar();
  }

  function quizBar() {
    const id = session.order[session.idx];
    const q = BY_ID[id];
    const res = session.res[id];
    const last = session.idx === session.order.length - 1;
    let primary;
    if (res) primary = `<button class="btn btn-primary" data-act="next"><span>${last ? "See results" : "Next"}</span>${ICON.right}</button>`;
    else if (isMulti(q)) primary = `<button class="btn btn-primary" data-act="check" ${pending.length ? "" : "disabled"}>Check answer</button>`;
    else primary = `<button class="btn btn-ghost" style="flex:1" data-act="next"><span>${last ? "Finish" : "Skip"}</span>${ICON.right}</button>`;

    setBar(`
      <button class="btn btn-ghost btn-icon" data-act="prev" aria-label="Previous" ${session.idx ? "" : "disabled style='opacity:.4'"}>${ICON.left}</button>
      <button class="btn btn-ghost" data-act="end">End</button>
      ${primary}`);
  }

  function paintPending() {
    document.querySelectorAll("#opts .opt").forEach(b => b.classList.toggle("sel", pending.includes(+b.dataset.orig)));
  }

  function paintResult(q, res, animate) {
    const opts = document.querySelectorAll("#opts .opt");
    opts.forEach(b => {
      const o = +b.dataset.orig;
      const isAns = q.answer.includes(o);
      const picked = res.chosen.includes(o);
      b.disabled = true;
      b.classList.remove("sel");
      if (isAns && picked) b.classList.add("correct");
      else if (isAns) b.classList.add("correct");
      else if (picked) { b.classList.add("wrong"); b.querySelector(".mark").innerHTML = ICON.x; }
      else b.classList.add("dim");
      if (animate && picked) b.classList.add(res.ok ? "pop" : "shake");
    });

    const slot = document.getElementById("explainSlot");
    // Explanation shows on wrong answers (and when revisiting a past question)
    if (!res.ok || !animate) {
      const ansText = q.answer.map(a => esc(q.options[a])).join(", ");
      slot.innerHTML = `
        <div class="explain glass ${res.ok ? "ok" : ""}">
          <h4>${res.ok ? "Correct" : "Correct answer"}</h4>
          <p class="ans">${ansText}</p>
          <p>${esc(q.explanation)}</p>
          ${q.note ? `<div class="note">${ICON.info}<span>Answer-key note: ${esc(q.note)}</span></div>` : ""}
        </div>`;
      if (animate) {
        const el = slot.firstElementChild;
        requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          const barTop = $bar.getBoundingClientRect().top || window.innerHeight;
          if (r.bottom > barTop - 8) window.scrollBy({ top: r.bottom - barTop + 24, behavior: "smooth" });
        });
      }
    }
  }

  function bump(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  }

  function submit(chosen) {
    const id = session.order[session.idx];
    const q = BY_ID[id];
    if (session.res[id]) return;
    const ok = sameSet(chosen, q.answer);
    session.res[id] = { chosen, ok };
    ok ? stats.correct++ : stats.wrong++;
    saveSession(); saveStats();
    pending = [];

    const t = tally();
    document.getElementById("pGood").innerHTML = ICON.check + t.c;
    document.getElementById("pBad").innerHTML = ICON.x + t.w;
    bump(ok ? "pGood" : "pBad");
    const bar = document.querySelector(".progress i");
    if (bar) bar.style.width = (Object.keys(session.res).length / session.order.length) * 100 + "%";

    paintResult(q, { chosen, ok }, true);
    quizBar();
    haptic(ok ? 12 : [20, 60, 20]);

    if (ok) {
      const at = session.idx;
      advanceTimer = setTimeout(() => { if (view === "quiz" && session.idx === at) next(); }, AUTO_NEXT_MS);
    }
  }

  function choose(orig) {
    const id = session.order[session.idx];
    const q = BY_ID[id];
    if (session.res[id]) return;
    if (isMulti(q)) {
      pending = pending.includes(orig) ? pending.filter(x => x !== orig) : [...pending, orig];
      paintPending(); quizBar();
    } else submit([orig]);
  }

  function next() {
    clearTimeout(advanceTimer);
    pending = [];
    if (session.idx < session.order.length - 1) { session.idx++; saveSession(); go("quiz"); }
    else finish();
  }
  function prev() {
    clearTimeout(advanceTimer);
    if (session.idx > 0) { session.idx--; pending = []; saveSession(); go("quiz"); }
  }
  function finish() {
    session.finished = true;
    saveSession();
    go("results");
  }

  /* ---------- Results ---------- */
  function renderResults() {
    if (!session) return go("home");
    const t = tally();
    const answered = t.c + t.w;
    const skipped = session.order.length - answered;
    const pct = answered ? Math.round((t.c / answered) * 100) : 0;
    const C = 2 * Math.PI * 64;
    const wrongIds = session.order.filter(id => session.res[id] && !session.res[id].ok);
    const weeks = [...new Set(session.order.map(id => BY_ID[id].week))].sort((a, b) => a - b);
    const msg = pct >= 90 ? "Outstanding!" : pct >= 75 ? "Great work" : pct >= 50 ? "Good effort" : "Keep practising";

    $app.innerHTML = `
      <section class="view">
        <div class="card glass result-top">
          <div class="ring">
            <svg viewBox="0 0 148 148"><circle class="track" cx="74" cy="74" r="64"/><circle class="val" id="ringVal" cx="74" cy="74" r="64" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
            <div class="pct">${pct}%</div>
          </div>
          <h2>${msg}</h2>
          <p>${t.c} correct · ${t.w} wrong${skipped ? ` · ${skipped} skipped` : ""}</p>
        </div>

        <div class="result-actions">
          ${wrongIds.length ? `<button class="btn btn-primary" data-act="retryWrong">Retry ${wrongIds.length} wrong</button>` : ""}
          <button class="btn btn-ghost" data-act="again">Restart same set</button>
          <button class="btn btn-ghost" data-act="home">New quiz</button>
        </div>

        ${weeks.length > 1 ? `
        <div class="card glass">
          <div class="card-head"><h2>By week</h2></div>
          <div class="wk-break">
            ${weeks.map(w => {
              const ids = session.order.filter(id => BY_ID[id].week === w);
              const c = ids.filter(id => session.res[id] && session.res[id].ok).length;
              return `<div class="wk-row"><span>${weekLabel(w)}</span><span class="bar"><i style="width:${(c / ids.length) * 100}%"></i></span><span class="n">${c}/${ids.length}</span></div>`;
            }).join("")}
          </div>
        </div>` : ""}

        ${wrongIds.length ? `
        <div class="wk-title"><h2>Review mistakes</h2><span>${wrongIds.length}</span></div>
        ${wrongIds.map(id => studyCard(BY_ID[id], session.res[id].chosen)).join("")}` : ""}
      </section>`;
    setBar("");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = document.getElementById("ringVal");
      if (r) r.style.strokeDashoffset = C * (1 - pct / 100);
    }));
  }

  /* ---------- Study ---------- */
  function studyCard(q, chosen) {
    return `
      <article class="sq glass">
        <div class="n">${weekLabel(q.week)} · Question ${q.n}</div>
        <h3>${esc(q.q)}</h3>
        <ol>${q.options.map((o, i) => `<li class="${q.answer.includes(i) ? "ok" : ""}" ${chosen && chosen.includes(i) && !q.answer.includes(i) ? 'style="background:var(--bad-soft)"' : ""}><b>${LETTERS[i]}</b><span>${esc(o)}</span></li>`).join("")}</ol>
        <div class="answer">
          <strong>Answer: ${q.answer.map(a => LETTERS[a]).join(", ")}</strong> — ${q.answer.map(a => esc(q.options[a])).join(", ")}
          <p>${esc(q.explanation)}</p>
          ${q.note ? `<div class="note">${ICON.info}<span>Answer-key note: ${esc(q.note)}</span></div>` : ""}
        </div>
      </article>`;
  }

  function renderStudy() {
    $app.innerHTML = `
      <section class="view">
        <div class="search glass" style="border-width:0 0 1px;border-radius:0;box-shadow:none">
          <div class="search-wrap">
            ${ICON.search}
            <input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Search ${QS.length} questions & answers" value="${esc(studyQuery)}">
          </div>
          <div class="jump">${WEEKS.map(w => `<button data-jump="${w}">${weekLabel(w)}</button>`).join("")}</div>
        </div>
        <div id="studyList"></div>
      </section>`;
    setBar("");
    renderStudyList();
  }

  function renderStudyList() {
    const term = studyQuery.trim().toLowerCase();
    const match = q => !term || (q.q + " " + q.options.join(" ") + " " + q.explanation).toLowerCase().includes(term);
    const html = WEEKS.map(w => {
      const qs = QS.filter(q => q.week === w && match(q));
      if (!qs.length) return "";
      return `<section class="wk-section" id="wk-${w}">
        <div class="wk-title"><h2>${weekLabel(w)}</h2><span>${qs.length} question${qs.length === 1 ? "" : "s"}</span></div>
        ${qs.map(q => studyCard(q)).join("")}
      </section>`;
    }).join("");
    document.getElementById("studyList").innerHTML = html || `<div class="empty">No questions match “${esc(studyQuery)}”.</div>`;
  }

  /* ---------- Events ---------- */
  $tabs.addEventListener("click", e => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    if (b.dataset.tab === "study") go("study");
    else go(practiceView === "quiz" && session && !session.finished ? "quiz" : practiceView === "results" && session ? "results" : "home");
  });
  document.getElementById("homeBtn").addEventListener("click", () => go("home"));

  document.addEventListener("click", e => {
    const opt = e.target.closest("#opts .opt");
    if (opt && !opt.disabled) {
      // don't treat a text-selection drag as an answer
      if (String(window.getSelection && window.getSelection()).length) return;
      return choose(+opt.dataset.orig);
    }

    const chip = e.target.closest(".chip[data-week]");
    if (chip) {
      const w = +chip.dataset.week;
      settings.weeks = settings.weeks.includes(w) ? settings.weeks.filter(x => x !== w) : [...settings.weeks, w].sort((a, b) => a - b);
      saveSettings(); haptic(5);
      return go("home", { scroll: false });
    }

    const tg = e.target.closest("[data-toggle]");
    if (tg) {
      settings[tg.dataset.toggle] = !settings[tg.dataset.toggle];
      saveSettings(); haptic(5);
      tg.setAttribute("aria-checked", String(settings[tg.dataset.toggle]));
      return;
    }

    const jb = e.target.closest("[data-jump]");
    if (jb) {
      const el = document.getElementById("wk-" + jb.dataset.jump);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      else toast("No matches in " + weekLabel(+jb.dataset.jump));
      return;
    }

    const a = e.target.closest("[data-act]");
    if (!a || a.disabled) return;
    switch (a.dataset.act) {
      case "all": settings.weeks = WEEKS.slice(); saveSettings(); go("home", { scroll: false }); break;
      case "none": settings.weeks = []; saveSettings(); go("home", { scroll: false }); break;
      case "start": {
        const pool = poolForWeeks(settings.weeks);
        if (!pool.length) return;
        if (session && !session.finished && Object.keys(session.res).length && !confirm("Start a new quiz? Your current progress will be replaced.")) return;
        startSession(pool); break;
      }
      case "resume": go("quiz"); break;
      case "reset":
        if (confirm("Reset your all-time correct/wrong counts?")) { stats = { correct: 0, wrong: 0 }; saveStats(); go("home", { scroll: false }); }
        break;
      case "next": next(); break;
      case "prev": prev(); break;
      case "check": if (pending.length) submit(pending.slice()); break;
      case "end":
        if (!Object.keys(session.res).length || confirm("End this quiz and see your results?")) finish();
        break;
      case "retryWrong": startSession(session.order.filter(id => session.res[id] && !session.res[id].ok)); break;
      case "again": startSession(session.order.slice().sort((x, y) => BY_ID[x].week - BY_ID[y].week || BY_ID[x].n - BY_ID[y].n)); break;
      case "home": go("home"); break;
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
    if (view !== "quiz" || !session) return;
    const id = session.order[session.idx];
    const q = BY_ID[id];
    const perm = session.perms[id];
    const k = e.key.toLowerCase();
    let pos = -1;
    if (/^[1-9]$/.test(k)) pos = +k - 1;
    else if (/^[a-j]$/.test(k)) pos = LETTERS.toLowerCase().indexOf(k);
    if (pos >= 0 && pos < perm.length) { e.preventDefault(); return choose(perm[pos]); }
    if (k === "enter" || k === "arrowright") {
      e.preventDefault();
      if (!session.res[id] && isMulti(q) && pending.length) submit(pending.slice());
      else next();
    } else if (k === "arrowleft") { e.preventDefault(); prev(); }
    else if (k === "escape") go("home");
  });

  /* ---------- Boot ---------- */
  go("home");
})();
