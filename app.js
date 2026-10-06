/* Guess the Colleague — one page, three roles:
 *   (default)  captain's phone: create a team, answer each round
 *   #screen    the projector: QR code, photo, timer, reveal, podium
 *   #host      the host console: start, reveal, next, overrides
 *   #watch     read-only follow-along for anyone who scanned but isn't a captain
 */
(function () {
  "use strict";

  const CFG = window.GAME_CONFIG || {};
  const ROUND_MS = (CFG.roundSeconds || 20) * 1000;
  const AUTO_REVEAL_SEC = CFG.revealSeconds || 3;
  const GRACE_MS = CFG.graceMs ?? 1500;
  const POINTS = CFG.pointsPerRound || 10;
  const TITLE = CFG.title || "Guess the Colleague";
  const TEAM_COLORS = ["#F2B544", "#5DC48A", "#E2644F", "#7FA7F2", "#C98BE0", "#F08AB0", "#6ED3D0", "#B9C85A", "#F0A06A", "#9AA5F0"];

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const App = {
    backend: null, uid: null, role: "captain",
    roster: [], rounds: [], byId: {},
    s: { game: null, teams: null, answers: null, results: null, hostUid: null },
    ui: { search: "", createName: "", createMembers: new Set(), editing: false, confirmReset: false, confirmTeams: false, revealedFor: null },
    unsubAnswers: null, answersRound: null, timerRaf: 0,
  };

  // ---------- boot ----------
  async function boot() {
    const h = location.hash.replace("#", "").split("=")[0];
    App.role = ["screen", "host", "watch"].includes(h) ? h : "captain";
    document.body.dataset.role = App.role;
    const [roster, rounds] = await Promise.all([fetch("roster.json", { cache: "no-cache" }).then((r) => r.json()), fetch("rounds.json", { cache: "no-cache" }).then((r) => r.json())]);
    App.roster = roster.sort((a, b) => a.name.localeCompare(b.name));
    App.rounds = rounds;
    for (const p of roster) App.byId[p.id] = p;

    App.backend = window.createBackend();
    try { App.uid = await App.backend.init(); }
    catch (e) { console.error(e); $("#app").innerHTML = `<div class="boot error">Can't connect to the game server.<br><small>${esc(e.message || e)}</small></div>`; return; }

    const b = App.backend;
    b.on("game", (v) => { App.s.game = v; syncAnswerSub(); render(); });
    b.on("teams", (v) => { App.s.teams = v || {}; render(); });
    b.on("results", (v) => { App.s.results = v || {}; render(); });
    b.on("config/hostUid", (v) => { App.s.hostUid = v; if (App.role === "host" || App.role === "screen") claimHostIfFree(v); render(); });
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("submit", (e) => { e.preventDefault(); const f = e.target.dataset.action; if (f) act(f, e.target); });
    window.addEventListener("hashchange", () => location.reload());
    document.addEventListener("keydown", onKey);
    startTimerLoop();
    setInterval(() => { const g = game(); autoPlayTick(g, g.phase + ":" + g.roundIdx + ":" + g.startedAt); }, 500);
  }

  function syncAnswerSub() {
    const rid = currentRound()?.id || null;
    if (rid === App.answersRound) return;
    if (App.unsubAnswers) App.unsubAnswers();
    App.answersRound = rid; App.s.answers = null;
    if (rid) App.unsubAnswers = App.backend.on("answers/" + rid, (v) => { App.s.answers = v || {}; render(); });
  }

  async function claimHostIfFree(v) {
    if (v === null || v === undefined) { try { await App.backend.set("config/hostUid", App.uid); } catch (e) { console.warn("host claim failed", e); } }
  }

  // ---------- derived state ----------
  const game = () => App.s.game || { phase: "lobby" };
  const phase = () => game().phase || "lobby";
  const teams = () => App.s.teams || {};
  const results = () => App.s.results || {};
  const myTeam = () => teams()[App.uid] || null;
  const isHost = () => App.s.hostUid === App.uid;
  function currentRound() { const g = game(); if (g.phase !== "round" && g.phase !== "reveal") return null; return App.rounds[g.roundIdx] || null; }
  function teamList() {
    return Object.entries(teams()).map(([uid, t], i) => ({ uid, ...t })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((t, i) => ({ ...t, color: t.color || TEAM_COLORS[i % TEAM_COLORS.length] }));
  }
  const memberIds = (t) => Object.keys(t?.members || {});
  const picturedIds = () => new Set(App.rounds.flatMap((r) => r.people));
  const takenBy = () => { const m = {}; for (const t of teamList()) for (const id of memberIds(t)) m[id] = t; return m; };
  function sitsOut(team, round) { return round.people.some((p) => team.members && team.members[p]); }
  function remainingMs() { const g = game(); if (g.phase !== "round" || !g.startedAt) return 0; return Math.max(0, (g.duration || ROUND_MS) - (App.backend.now() - g.startedAt)); }
  const timeUp = () => phase() === "round" && remainingMs() <= 0;

  function scoreRound(round, g, answers) {
    const out = {};
    for (const t of teamList()) {
      const a = answers?.[t.uid];
      const r = { points: 0, correct: false, sitOut: sitsOut(t, round), time: null, picks: a?.picks || [] };
      if (!r.sitOut && a && a.at && a.at <= (g.startedAt || 0) + (g.duration || ROUND_MS) + GRACE_MS) {
        const hits = (a.picks || []).filter((p) => round.people.includes(p)).length;
        r.points = Math.round((POINTS * hits) / round.people.length);
        r.correct = hits === round.people.length;
        r.time = Math.max(0, a.at - (g.startedAt || 0));
      }
      out[t.uid] = r;
    }
    return out;
  }
  function standings() {
    const res = results();
    const rows = teamList().map((t) => {
      let points = 0, time = 0, correct = 0, played = 0;
      for (const rid in res) { const r = res[rid]?.[t.uid]; if (!r) continue; played++; points += r.points || 0; if (r.points > 0) { time += r.time || 0; if (r.correct) correct++; } }
      return { ...t, points, time, correct, played };
    });
    rows.sort((a, b) => b.points - a.points || (a.points ? a.time - b.time : 0) || a.name.localeCompare(b.name));
    let rank = 0; rows.forEach((r, i) => { r.rank = i > 0 && r.points === rows[i - 1].points && r.time === rows[i - 1].time ? rows[i - 1].rank : i + 1; });
    return rows;
  }
  function answeredCount(round) { const a = App.s.answers || {}; const ts = teamList().filter((t) => !sitsOut(t, round)); return { answered: ts.filter((t) => a[t.uid]).length, total: ts.length }; }

  // ---------- actions ----------
  async function act(name, el) {
    const b = App.backend, g = game();
    const d = el?.dataset || {};
    switch (name) {
      // captain
      case "create-team": {
        const n = App.ui.createName.trim(); if (!n) return toast("Give your team a name");
        if (!App.ui.createMembers.size) return toast("Pick at least one team member");
        const members = {}; for (const id of App.ui.createMembers) members[id] = true;
        const t = myTeam();
        await b.set("teams/" + App.uid, { name: n.slice(0, 32), members, createdAt: t?.createdAt || b.TS, color: t?.color || TEAM_COLORS[teamList().length % TEAM_COLORS.length] });
        App.ui.editing = false; App.ui.search = "";
        return;
      }
      case "edit-team": { const t = myTeam(); App.ui.createName = t.name; App.ui.createMembers = new Set(memberIds(t)); App.ui.editing = true; App.ui.search = ""; return render(); }
      case "cancel-edit": App.ui.editing = false; App.ui.search = ""; return render();
      case "toggle-member": { const id = d.id; const s = App.ui.createMembers; if (s.has(id)) s.delete(id); else s.add(id); return render(); }
      case "pick": {
        const round = currentRound(); if (!round || phase() !== "round" || timeUp()) return;
        const t = myTeam(); if (!t || sitsOut(t, round)) return;
        const prev = (App.s.answers?.[App.uid]?.picks) || [];
        let picks;
        if (round.people.length === 1) picks = [d.id];
        else { picks = prev.includes(d.id) ? prev.filter((x) => x !== d.id) : [...prev, d.id].slice(-round.people.length); }
        App.ui.search = "";
        await b.set(`answers/${round.id}/${App.uid}`, { picks, at: b.TS });
        return;
      }
      case "clear-search": App.ui.search = ""; return render();
      // host
      case "start": {
        if (!App.rounds.length) return;
        await b.set("game", { phase: "round", roundIdx: 0, startedAt: b.TS, duration: ROUND_MS, startedGameAt: b.TS });
        return;
      }
      case "reveal": return reveal();
      case "next": {
        const i = (g.roundIdx ?? -1) + 1;
        if (i >= App.rounds.length) return b.update("game", { phase: "final" });
        await b.update("game", { phase: "round", roundIdx: i, startedAt: b.TS, duration: ROUND_MS });
        return;
      }
      case "replay": { await b.remove(`answers/${currentRound().id}`); await b.remove(`results/${currentRound().id}`); await b.update("game", { phase: "round", startedAt: b.TS, duration: ROUND_MS }); return; }
      case "finish": return b.update("game", { phase: "final" });
      case "to-lobby": return b.update("game", { phase: "lobby" });
      case "reset-ask": App.ui.confirmReset = true; return render();
      case "reset-cancel": App.ui.confirmReset = false; return render();
      case "reset": { App.ui.confirmReset = false; await b.remove("answers"); await b.remove("results"); await b.set("game", { phase: "lobby" }); return; }
      case "teams-ask": App.ui.confirmTeams = true; return render();
      case "teams-cancel": App.ui.confirmTeams = false; return render();
      case "teams-clear": { App.ui.confirmTeams = false; await b.remove("teams"); await b.remove("answers"); await b.remove("results"); await b.set("game", { phase: "lobby" }); return; }
      case "remove-team": return b.remove("teams/" + d.uid);
      case "override": {
        const round = currentRound(); if (!round) return;
        const cur = results()[round.id]?.[d.uid] || { points: 0, correct: false, sitOut: false, time: null };
        let next = { ...cur, override: true };
        if (d.field === "correct") { next.correct = !cur.correct; next.sitOut = false; next.points = next.correct ? POINTS : 0; if (next.correct && next.time == null) next.time = 0; }
        if (d.field === "sitOut") { next.sitOut = !cur.sitOut; next.correct = false; next.points = 0; }
        await b.set(`results/${round.id}/${d.uid}`, next);
        return;
      }
      case "release-host": { if (isHost()) await b.remove("config/hostUid"); return; }
      case "take-host": { await b.set("config/hostUid", App.uid); return; }
      case "auto-toggle": return b.update("game/auto", { on: !auto().on });
      case "auto-early": return b.update("game/auto", { early: !auto().early });
      case "auto-sec": { const v = Math.max(1, Math.min(60, parseInt(el.value, 10) || AUTO_REVEAL_SEC)); return b.update("game/auto", { revealSec: v }); }
      case "fullscreen": { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); return; }
    }
  }
  async function reveal() {
    const round = currentRound(); if (!round || phase() !== "round") return;
    const res = scoreRound(round, game(), App.s.answers || {});
    await App.backend.set("results/" + round.id, res);
    await App.backend.update("game", { phase: "reveal", revealedAt: App.backend.TS });
  }

  function onClick(e) {
    const el = e.target.closest("[data-action]"); if (!el) return;
    if (el.tagName === "FORM" || el.dataset.on === "change") return;
    if (el.type !== "checkbox") e.preventDefault();
    act(el.dataset.action, el);
  }
  document.addEventListener("change", (e) => { const el = e.target; if (el.dataset.on === "change" && el.dataset.action) act(el.dataset.action, el); });
  function onKey(e) {
    if (App.role !== "screen" || !isHost()) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); const ph = phase(); if (ph === "lobby") act("start"); else if (ph === "round") act("reveal"); else if (ph === "reveal") act("next"); }
    if (e.key === "f" || e.key === "F") act("fullscreen");
  }
  function onInput(e) {
    const el = e.target; const k = el.dataset.bind; if (!k) return;
    if (k === "search") { App.ui.search = el.value; renderListOnly(); }
    else if (k === "createName") App.ui.createName = el.value;
  }
  let toastT = 0;
  function toast(msg) { let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); } t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2200); }

  // ---------- timer loop (no re-render, just DOM updates) ----------
  // Auto-play settings live in game.auto so they survive a reload: {on, revealSec, early}
  const auto = () => Object.assign({ on: true, revealSec: AUTO_REVEAL_SEC, early: true }, game().auto || {});
  let autoRevealKey = "", autoNextKey = "";
  function autoPlayTick(g, key) {
    if ((App.role !== "host" && App.role !== "screen") || !isHost()) return;
    const a = auto(); if (!a.on) return;
    if (g.phase === "round" && g.startedAt) {
      const c = currentRound() ? answeredCount(currentRound()) : null;
      const allIn = a.early && c && c.total > 0 && c.answered >= c.total && App.s.answers !== null;
      if ((remainingMs() <= 0 || allIn) && autoRevealKey !== key) { autoRevealKey = key; reveal(); }
    } else if (g.phase === "reveal" && g.revealedAt) {
      const left = a.revealSec * 1000 - (App.backend.now() - g.revealedAt);
      document.querySelectorAll("[data-nextin]").forEach((el) => { el.textContent = Math.max(0, Math.ceil(left / 1000)); });
      const nk = "next:" + g.roundIdx + ":" + g.revealedAt;
      if (left <= 0 && autoNextKey !== nk) { autoNextKey = nk; act("next"); }
    }
  }
  function startTimerLoop() {
    let lastSec = -1, lastPhaseKey = "";
    const tick = () => {
      const g = game();
      const key = g.phase + ":" + g.roundIdx + ":" + g.startedAt;
      if (g.phase === "round") {
        const ms = remainingMs(), total = g.duration || ROUND_MS;
        const sec = Math.ceil(ms / 1000);
        document.querySelectorAll("[data-timer]").forEach((el) => { el.textContent = sec; });
        document.querySelectorAll("[data-timer-bar]").forEach((el) => { el.style.transform = `scaleX(${ms / total})`; });
        document.querySelectorAll("[data-timer-ring]").forEach((el) => { el.style.strokeDashoffset = String(283 * (1 - ms / total)); el.classList.toggle("urgent", sec <= 5); });
        if (sec !== lastSec || key !== lastPhaseKey) {
          lastSec = sec;
          if (ms <= 0 && !document.body.classList.contains("timeup")) { document.body.classList.add("timeup"); render(); }
          if (ms > 0) document.body.classList.remove("timeup");
        }
      } else if (g.phase === "reveal") {
        document.body.classList.remove("timeup");
        const a = auto(); const left = g.revealedAt ? a.revealSec * 1000 - (App.backend.now() - g.revealedAt) : 0;
        document.querySelectorAll("[data-reveal-bar]").forEach((el) => { el.style.transform = `scaleX(${a.on && g.revealedAt ? Math.max(0, left) / (a.revealSec * 1000) : 0})`; });
      } else document.body.classList.remove("timeup");
      autoPlayTick(g, key);
      lastPhaseKey = key;
      App.timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- rendering ----------
  function render() {
    const app = $("#app");
    if (!App.s.teams) return; // wait for first snapshot
    const fn = { captain: renderCaptain, watch: renderWatch, screen: renderScreen, host: renderHost }[App.role];
    const focusEl = document.activeElement, focusBind = focusEl?.dataset?.bind, selStart = focusEl?.selectionStart;
    app.innerHTML = fn();
    afterRender();
    if (focusBind) { const el = app.querySelector(`[data-bind="${focusBind}"]`); if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} } }
  }
  function afterRender() {
    const qr = $("#qr"); if (qr && typeof qrcode === "function") { const url = joinUrl(); const q = qrcode(0, "M"); q.addData(url); q.make(); qr.innerHTML = q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }); }
    if (App.role === "screen" && phase() === "final" && App.ui.revealedFor !== "final" && typeof confetti === "function") { App.ui.revealedFor = "final"; burst(); }
    if (App.role === "captain" && phase() === "reveal") { const rid = currentRound()?.id; const r = results()[rid]?.[App.uid]; if (r?.correct && App.ui.revealedFor !== rid && typeof confetti === "function") { App.ui.revealedFor = rid; confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 } }); } }
  }
  function burst() { const end = Date.now() + 2500; (function frame() { confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0 }, colors: TEAM_COLORS }); confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1 }, colors: TEAM_COLORS }); if (Date.now() < end) requestAnimationFrame(frame); })(); }
  function joinUrl() { return location.origin + location.pathname + (location.search.includes("local") ? "?local" : ""); }
  function renderListOnly() { const list = $("#rosterlist"); if (list) list.outerHTML = rosterListHtml(); const c = $("#clearsearch"); if (c) c.hidden = !App.ui.search; }

  const photo = (file, cls = "") => `<img class="photo ${cls}" src="photos/${esc(file)}" alt="">`;
  const names = (ids) => ids.map((id) => App.byId[id]?.name || id).join(" & ");
  const avatar = (t, size = "") => `<span class="dot ${size}" style="background:${esc(t.color)}"></span>`;

  // roster list used by captain (picking members or answering)
  function rosterListHtml() {
    const q = fold(App.ui.search).trim();
    const mode = App.ui.editing || !myTeam() ? "members" : "answer";
    const round = currentRound();
    const myPicks = App.s.answers?.[App.uid]?.picks || [];
    const taken = takenBy();
    let items = App.roster;
    if (q) items = items.filter((p) => fold(p.name).includes(q) || fold(p.dept).includes(q));
    if (mode === "members" && !q) items = [...items].sort((a, b) => (App.ui.createMembers.has(b.id) ? 1 : 0) - (App.ui.createMembers.has(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
    const shown = items.slice(0, q ? 60 : 400);
    const rows = shown.map((p) => {
      if (mode === "members") {
        const sel = App.ui.createMembers.has(p.id); const other = taken[p.id] && taken[p.id].uid !== App.uid;
        return `<li><button type="button" class="row ${sel ? "sel" : ""} ${other ? "taken" : ""}" data-action="toggle-member" data-id="${p.id}" ${other ? "disabled" : ""}>
          <span class="check" aria-hidden="true"></span><span class="who"><b>${esc(p.name)}</b><small>${esc(p.dept || "")}${other ? ` · in ${esc(taken[p.id].name)}` : ""}</small></span></button></li>`;
      }
      const sel = myPicks.includes(p.id);
      return `<li><button type="button" class="row ${sel ? "sel" : ""}" data-action="pick" data-id="${p.id}"><span class="check" aria-hidden="true"></span><span class="who"><b>${esc(p.name)}</b><small>${esc(p.dept || "")}</small></span></button></li>`;
    });
    return `<ul id="rosterlist" class="roster">${rows.join("") || `<li class="empty">No one matches “${esc(App.ui.search)}”</li>`}</ul>`;
  }
  const searchBox = (ph) => `<div class="search"><input data-bind="search" type="search" placeholder="${esc(ph)}" value="${esc(App.ui.search)}" autocomplete="off" autocorrect="off" spellcheck="false"><button id="clearsearch" type="button" class="x" data-action="clear-search" ${App.ui.search ? "" : "hidden"} aria-label="Clear">×</button></div>`;

  // ---------- captain ----------
  function renderCaptain() {
    const t = myTeam();
    if (!t || App.ui.editing) return teamForm(t);
    const ph = phase();
    return `<div class="phone">${captainHeader(t)}${{ lobby: capLobby, round: capRound, reveal: capReveal, final: capFinal }[ph]?.(t) || capLobby(t)}</div>`;
  }
  function captainHeader(t) { return `<header class="cap-head">${avatar(t)}<b>${esc(t.name)}</b><span class="muted">${memberIds(t).length} people</span></header>`; }
  function teamForm(t) {
    const n = App.ui.createMembers.size;
    return `<div class="phone"><form class="teamform" data-action="create-team">
      <h1 class="display">${t ? "Edit your team" : "Make your team"}</h1>
      <p class="lead">${t ? "Change the name or who's on the team." : "You're the captain. Name your team and pick who's on it, then wait for the host to start."}</p>
      <label class="field"><span>Team name</span><input data-bind="createName" type="text" maxlength="32" placeholder="e.g. The Diaper Detectives" value="${esc(App.ui.createName)}" required></label>
      <label class="field"><span>Who's on the team? <em>${n ? n + " picked" : ""}</em></span>${searchBox("Search names")}</label>
      ${rosterListHtml()}
      <div class="sticky"><button class="btn primary big" type="submit">${t ? "Save team" : "Create team"}</button>${t ? `<button class="btn ghost" type="button" data-action="cancel-edit">Cancel</button>` : ""}</div>
    </form></div>`;
  }
  function capLobby(t) {
    return `<section class="card center">
      <div class="big-emoji">👶</div>
      <h1 class="display">You're in!</h1>
      <p class="lead">Waiting for the host to show the first photo. Keep this page open.</p>
      <ul class="members">${memberIds(t).map((id) => `<li>${esc(App.byId[id]?.name || id)}</li>`).join("")}</ul>
      <button class="btn ghost" data-action="edit-team">Edit team</button>
    </section>`;
  }
  function capRound(t) {
    const g = game(), round = currentRound(); if (!round) return capLobby(t);
    const picks = App.s.answers?.[App.uid]?.picks || [];
    const out = sitsOut(t, round), up = timeUp();
    const n = round.people.length;
    let status;
    if (out) status = `<div class="status sitout">This one's yours 😉<br><small>Your team sits this round out. No points, no penalty.</small></div>`;
    else if (up) status = picks.length ? `<div class="status locked">Time's up — locked in: <b>${esc(names(picks))}</b></div>` : `<div class="status locked">Time's up — no answer this round.</div>`;
    else if (picks.length) status = `<div class="status picked">Locked in: <b>${esc(names(picks))}</b><br><small>${n > 1 && picks.length < n ? `Pick ${n - picks.length} more. ` : ""}Tap another name to change.</small></div>`;
    else status = `<div class="status">${n > 1 ? `Who are these two? Pick ${n} names.` : "Who is this? Tap a name."}</div>`;
    return `<section class="round">
      <div class="roundbar"><span>Photo ${g.roundIdx + 1} of ${App.rounds.length}</span><span class="t"><b data-timer>${Math.ceil(remainingMs() / 1000)}</b>s</span></div>
      <div class="bar"><i data-timer-bar></i></div>
      <div class="print small">${photo(round.baby)}</div>
      ${round.hint ? `<p class="hint">${esc(round.hint)}</p>` : ""}
      ${status}
      ${!out && !up ? `${searchBox("Type a name…")}${rosterListHtml()}` : ""}
    </section>`;
  }
  function capReveal(t) {
    const g = game(), round = currentRound(); if (!round) return capLobby(t);
    const r = results()[round.id]?.[App.uid];
    const st = standings(); const me = st.find((x) => x.uid === App.uid);
    let verdict;
    if (!r) verdict = `<div class="verdict">Revealed!</div>`;
    else if (r.sitOut) verdict = `<div class="verdict sitout">Sat out — it was ${esc(names(round.people))}</div>`;
    else if (r.correct) verdict = `<div class="verdict yes">Correct! +${r.points}</div>`;
    else if (r.points > 0) verdict = `<div class="verdict half">Half right! +${r.points}<br><small>It was ${esc(names(round.people))}</small></div>`;
    else verdict = `<div class="verdict no">Not this time<br><small>It was ${esc(names(round.people))}${r.picks?.length ? ` — you said ${esc(names(r.picks))}` : ""}</small></div>`;
    return `<section class="round">
      <div class="roundbar"><span>Photo ${g.roundIdx + 1} of ${App.rounds.length}</span><span>Revealed</span></div>
      <div class="pair">${pairHtml(round)}</div>
      <h2 class="display name">${esc(names(round.people))}</h2>
      ${verdict}
      <p class="muted center">Your team: <b>${me?.points ?? 0} points</b> · ${me ? ordinal(me.rank) + " place" : ""}</p>
    </section>`;
  }
  function capFinal(t) {
    const st = standings();
    return `<section class="card">
      <h1 class="display center">Final standings</h1>
      <ol class="standings">${st.map((s) => `<li class="${s.uid === App.uid ? "me" : ""}"><span class="rank">${s.rank}</span>${avatar(s)}<span class="n">${esc(s.name)}</span><span class="pts">${s.points}</span></li>`).join("")}</ol>
      <p class="muted center">Thanks for playing 🎉</p>
    </section>`;
  }
  function renderWatch() {
    const g = game(), round = currentRound();
    const body = phase() === "round" ? `<div class="roundbar"><span>Photo ${g.roundIdx + 1} of ${App.rounds.length}</span><span class="t"><b data-timer>${Math.ceil(remainingMs() / 1000)}</b>s</span></div><div class="bar"><i data-timer-bar></i></div><div class="print small">${photo(round.baby)}</div><div class="status">Who is this?</div>`
      : phase() === "reveal" ? `<div class="pair">${pairHtml(round)}</div><h2 class="display name">${esc(names(round.people))}</h2>`
      : phase() === "final" ? capFinal({}) : `<section class="card center"><h1 class="display">${esc(TITLE)}</h1><p class="lead">Following along. The game starts soon.</p></section>`;
    return `<div class="phone"><section class="round">${body}</section></div>`;
  }
  function pairHtml(round) {
    const nowFiles = (round.now || []).filter(Boolean);
    return `<div class="print tilt-l">${photo(round.baby)}</div>${nowFiles.length ? nowFiles.map((f) => `<div class="print tilt-r now">${photo(f)}</div>`).join("") : `<div class="print tilt-r now namecard"><span>${esc(names(round.people))}</span></div>`}`;
  }
  const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");

  // ---------- big screen ----------
  function renderScreen() {
    const ph = phase();
    return `<div class="screen">${{ lobby: scrLobby, round: scrRound, reveal: scrReveal, final: scrFinal }[ph]?.() || scrLobby()}</div>`;
  }
  function teamChips(round, revealed) {
    const res = revealed ? results()[round?.id] || {} : {};
    const a = App.s.answers || {};
    return `<ul class="chips">${teamList().map((t) => {
      let cls = "", mark = "";
      if (round && sitsOut(t, round)) { cls = "sit"; mark = "sits out"; }
      else if (revealed) { const r = res[t.uid]; cls = r?.correct ? "yes" : r?.points ? "half" : "no"; mark = r?.correct ? "+" + r.points : r?.points ? "+" + r.points : "0"; }
      else if (a[t.uid]) { cls = "in"; mark = "locked in"; }
      else mark = "thinking…";
      return `<li class="${cls}">${avatar(t)}<b>${esc(t.name)}</b><small>${mark}</small></li>`;
    }).join("")}</ul>`;
  }
  function scrLobby() {
    const ts = teamList(), pic = picturedIds();
    return `<div class="lobby">
      <div class="lobby-l"><h1 class="display title">${esc(TITLE)}</h1><p class="lead">Captains: scan to make your team</p><div id="qr" class="qr"></div><p class="url">${esc(joinUrl().replace(/^https?:\/\//, ""))}</p></div>
      <div class="lobby-r"><h2>Teams <span class="count">${ts.length}</span></h2>
        ${ts.length ? `<ul class="teamlist">${ts.map((t) => { const n = memberIds(t).length, p = memberIds(t).filter((id) => pic.has(id)).length; return `<li>${avatar(t, "lg")}<b>${esc(t.name)}</b><small>${n} ${n === 1 ? "person" : "people"}${p ? ` · ${p} in the photos` : ""}</small></li>`; }).join("")}</ul>` : `<p class="muted">No teams yet. Scan the code to be the first.</p>`}
      </div></div>
      ${isHost() ? `<div class="scr-host"><button class="btn primary big" data-action="start" ${ts.length ? "" : "disabled"}>Start the game</button><small>Then it runs by itself: ${CFG.roundSeconds || 20} s per photo, reveal, next. Space = start / reveal / next · F = full screen</small></div>` : ""}`;
  }
  function scrRound() {
    const g = game(), round = currentRound(); const c = answeredCount(round);
    const sec = Math.ceil(remainingMs() / 1000), total = g.duration || ROUND_MS;
    return `<div class="stage">
      <header class="stagebar"><span class="rnd">Photo ${g.roundIdx + 1} <small>of ${App.rounds.length}</small></span>
        <span class="answered">${c.answered} of ${c.total} teams locked in</span>
        <span class="ring"><svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="45"/><circle class="arc ${sec <= 5 ? "urgent" : ""}" data-timer-ring cx="50" cy="50" r="45" style="stroke-dashoffset:${283 * (1 - remainingMs() / total)}"/></svg><b data-timer>${sec}</b></span></header>
      <div class="hero"><div class="print big">${photo(round.baby)}</div><div class="ask"><h1 class="display">Who is this?</h1>${round.hint ? `<p class="hint">${esc(round.hint)}</p>` : ""}<p class="timeup-msg">Time's up!</p></div></div>
      ${teamChips(round, false)}
    </div>`;
  }
  function scrReveal() {
    const g = game(), round = currentRound(); const st = standings().slice(0, 8);
    return `<div class="stage reveal">
      <header class="stagebar"><span class="rnd">Photo ${g.roundIdx + 1} <small>of ${App.rounds.length}</small></span><span class="answered">${auto().on ? `${(g.roundIdx + 1) < App.rounds.length ? "Next photo" : "Podium"} in <b data-nextin>${auto().revealSec}</b>` : "It was…"}</span></header>
      <div class="hero"><div class="pair">${pairHtml(round)}</div>
        <div class="ask"><h1 class="display name">${esc(names(round.people))}</h1><p class="role">${round.people.map((id) => esc(App.byId[id]?.dept || "")).filter(Boolean).join(" · ")}</p>
          <ol class="mini-standings">${st.map((s) => `<li>${avatar(s)}<span class="n">${esc(s.name)}</span><b>${s.points}</b></li>`).join("")}</ol></div></div>
      ${teamChips(round, true)}
      <div class="revealbar"><i data-reveal-bar></i></div>
    </div>`;
  }
  function scrFinal() {
    const st = standings(); const top = st.slice(0, 3), rest = st.slice(3);
    const slot = (s, cls) => s ? `<div class="slot ${cls}"><div class="medal">${{ 1: "🥇", 2: "🥈", 3: "🥉" }[s.rank] || s.rank}</div>${avatar(s, "lg")}<b>${esc(s.name)}</b><span>${s.points} pts</span><small>${memberIds(s).map((id) => esc(App.byId[id]?.name?.split(" ")[0] || id)).join(", ")}</small></div>` : `<div class="slot ${cls} empty"></div>`;
    return `<div class="final"><h1 class="display title">And the winners are…</h1>
      <div class="podium">${slot(top[1], "second")}${slot(top[0], "first")}${slot(top[2], "third")}</div>
      ${rest.length ? `<ol class="standings wide">${rest.map((s) => `<li><span class="rank">${s.rank}</span>${avatar(s)}<span class="n">${esc(s.name)}</span><span class="pts">${s.points}</span></li>`).join("")}</ol>` : ""}
      ${isHost() ? `<div class="scr-host quiet"><button class="btn ghost" data-action="to-lobby">Back to lobby</button></div>` : ""}
    </div>`;
  }

  // ---------- host ----------
  function renderHost() {
    const g = game(), ph = phase(), round = currentRound(), host = isHost();
    const hostNote = App.s.hostUid == null ? `<p class="note">Claiming host…</p>` : host ? "" : `<div class="note warn">Another device is the host. Controls are disabled here. <button class="btn small" data-action="take-host">Take over on this device</button></div>`;
    const dis = host ? "" : "disabled";
    const st = standings();
    const controls = {
      lobby: `<button class="btn primary big" data-action="start" ${dis} ${teamList().length ? "" : "disabled"}>Start game →</button><p class="muted">${teamList().length} team${teamList().length === 1 ? "" : "s"} ready. Photo 1 shows the moment you press start.</p>`,
      round: `<button class="btn primary big ${timeUp() ? "pulse" : ""}" data-action="reveal" ${dis}>Reveal now</button> <button class="btn" data-action="next" ${dis}>Skip photo</button>`,
      reveal: `<button class="btn primary big" data-action="next" ${dis}>${(g.roundIdx + 1) < App.rounds.length ? "Next photo now →" : "Finish: show podium 🏆"}</button> <button class="btn" data-action="replay" ${dis}>Replay this photo</button>${auto().on ? ` <span class="muted inline">Next photo in <b data-nextin>${Math.max(0, Math.ceil((auto().revealSec * 1000 - (App.backend.now() - (g.revealedAt || 0))) / 1000))}</b>s</span>` : ""}`,
      final: `<button class="btn" data-action="to-lobby" ${dis}>Back to lobby screen</button>`,
    }[ph];
    const roundPanel = round ? `<div class="hround"><div class="print small">${photo(round.baby)}</div><div><b>Photo ${g.roundIdx + 1} of ${App.rounds.length}</b> — ${esc(names(round.people))}${round.hint ? ` <i>(${esc(round.hint)})</i>` : ""}<br>${ph === "round" ? `<span class="t"><b data-timer>${Math.ceil(remainingMs() / 1000)}</b>s left</span> · ${answeredCount(round).answered}/${answeredCount(round).total} answered` : "Revealed"}</div></div>` : "";
    const a = App.s.answers || {}, res = results()[round?.id] || {};
    const teamRows = teamList().map((t) => {
      const r = res[t.uid], ans = a[t.uid];
      const sit = round && sitsOut(t, round);
      let cell = "—";
      if (round && ph === "round") cell = sit ? "sits out" : ans ? `${esc(names(ans.picks || []))}` : "…";
      if (round && ph === "reveal") cell = r?.sitOut ? "sits out" : `${esc(names(r?.picks || ans?.picks || []))} <b class="${r?.correct ? "ok" : r?.points ? "half" : "bad"}">${r?.points ?? 0}</b>${r?.time != null ? ` <small>${(r.time / 1000).toFixed(1)}s</small>` : ""}${r?.override ? " <small>(edited)</small>" : ""}`;
      const ov = round && ph === "reveal" && host ? `<button class="btn tiny" data-action="override" data-uid="${t.uid}" data-field="correct">${r?.correct ? "Mark wrong" : "Mark correct"}</button> <button class="btn tiny" data-action="override" data-uid="${t.uid}" data-field="sitOut">${r?.sitOut ? "Let them play" : "Sit out"}</button>` : "";
      const del = ph === "lobby" && host ? `<button class="btn tiny danger" data-action="remove-team" data-uid="${t.uid}">Remove</button>` : "";
      const s = st.find((x) => x.uid === t.uid);
      return `<tr><td>${avatar(t)} <b>${esc(t.name)}</b><br><small>${memberIds(t).map((id) => esc(App.byId[id]?.name || id)).join(", ")}</small></td><td>${cell}</td><td class="num">${s?.points ?? 0}<br><small>#${s?.rank ?? "-"}</small></td><td>${ov}${del}</td></tr>`;
    }).join("");
    const confirmReset = App.ui.confirmReset ? `<span class="confirm">Clear all answers and scores and go back to the lobby? <button class="btn small danger" data-action="reset">Yes, restart</button> <button class="btn small" data-action="reset-cancel">No</button></span>` : `<button class="btn small" data-action="reset-ask" ${dis}>Restart game (keep teams)</button>`;
    const confirmTeams = App.ui.confirmTeams ? `<span class="confirm">Delete every team too? Captains will have to scan again. <button class="btn small danger" data-action="teams-clear">Yes, delete teams</button> <button class="btn small" data-action="teams-cancel">No</button></span>` : `<button class="btn small" data-action="teams-ask" ${dis}>Delete all teams</button>`;
    return `<div class="host">
      <header class="hhead"><h1>${esc(TITLE)} — host</h1><span class="phase ${ph}">${ph}</span>${hostNote}</header>
      <section class="hcontrols">${controls}</section>
      <section class="hauto"><label class="chk"><input type="checkbox" data-action="auto-toggle" ${auto().on ? "checked" : ""} ${dis}> <b>Auto-play</b>: reveal when time's up, then show the next photo after</label> <input class="num" type="number" min="1" max="60" value="${auto().revealSec}" data-action="auto-sec" data-on="change" ${dis}> s <label class="chk"><input type="checkbox" data-action="auto-early" ${auto().early ? "checked" : ""} ${dis}> reveal early once every team has locked in</label></section>
      ${roundPanel}
      <section><h2>Teams</h2><table class="hteams"><thead><tr><th>Team</th><th>${ph === "lobby" ? "" : "Answer"}</th><th>Score</th><th></th></tr></thead><tbody>${teamRows || `<tr><td colspan="4" class="muted">No teams yet. The screen page shows the QR code: <a href="#screen" target="_blank">open the screen ↗</a></td></tr>`}</tbody></table></section>
      <section><h2>Photos</h2><ol class="hrounds">${App.rounds.map((r, i) => `<li class="${i === g.roundIdx && round ? "cur" : ""} ${results()[r.id] ? "done" : ""}">${photo(r.baby, "thumb")}<span>${esc(names(r.people))}</span></li>`).join("")}</ol></section>
      <section class="hfoot"><a class="btn small" href="#screen" target="_blank">Open the big screen ↗</a> <a class="btn small" href="${esc(joinUrl())}" target="_blank">Open captain page ↗</a> ${confirmReset} ${confirmTeams} ${host ? `<button class="btn small" data-action="release-host">Release host</button>` : ""}<p class="muted">Host device id: ${esc(App.uid)}</p></section>
    </div>`;
  }

  boot();
})();
