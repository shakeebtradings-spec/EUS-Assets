"use strict";
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.EUS_CONFIG;
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const emailFor = u => `${u.toLowerCase()}@eus-assets.app`; // same accounts as the EUS Assets app; no email is ever sent
const pad = n => String(n).padStart(2, "0");
const hm = d => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = d => { d = new Date(d); const t = new Date(); return ymd(d) === ymd(t) ? "Today" : ymd(d) === ymd(new Date(+t + 864e5)) ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); };
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const short = st => st ? st.name.replace(/^Workstation\s*/i, "WS ") : "?";

const ROLES = { none: "No access", viewer: "Viewer", user: "User", admin: "Admin" };
const ROLE_HELP = { none: "No access", viewer: "Viewer – can only watch the board", user: "User – can start work & reserve", admin: "Admin – full control" };

const S = {
  me: null, role: "none", anon: false, stations: [], sessions: [], res: [], settings: { public_display: false },
  history: [], profiles: [], members: [], hq: "", tab: "board", live: false, rf: null,
  tv: new URLSearchParams(location.search).has("tv"),
};
const canUse = () => S.role === "user" || S.role === "admin";
const isAdmin = () => S.role === "admin";
const byId = id => S.stations.find(s => s.id === id);
const peersOf = st => st.kvm_group ? S.stations.filter(x => x.kvm_group === st.kvm_group && x.id !== st.id) : [];
const groupIds = st => [st.id, ...peersOf(st).map(p => p.id)];

function toast(msg, err) {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), err ? 4500 : 2600);
}

// ---------- auth ----------
function renderAuth(mode = "in") {
  teardown();
  document.body.classList.remove("tv");
  $("#app").innerHTML = `<form class="panel auth" id="af">
    <h1>EUS Workstations</h1><p class="mut">${mode === "in" ? "Sign in with your username" : "Create an account – an admin will then give you access"}</p>
    <label>Username</label><input name="u" required minlength="3" maxlength="30" pattern="[A-Za-z0-9._\\-]+" autocomplete="username" autocapitalize="none">
    ${mode === "up" ? `<label>Full name (shown on the board)</label><input name="n" required autocomplete="name">` : ""}
    <label>Password</label><input name="p" type="password" required minlength="6" autocomplete="${mode === "in" ? "current-password" : "new-password"}">
    <p><button style="width:100%">${mode === "in" ? "Sign in" : "Create account"}</button></p>
    <p class="mut center sm"><a href="#" id="sw">${mode === "in" ? "Create an account" : "I already have an account"}</a></p></form>`;
  $("#sw").onclick = e => { e.preventDefault(); renderAuth(mode === "in" ? "up" : "in"); };
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), u = f.get("u").trim(), p = f.get("p"), btn = $("#af button");
    btn.disabled = true;
    let r;
    if (mode === "in") r = await sb.auth.signInWithPassword({ email: emailFor(u), password: p });
    else {
      r = await sb.auth.signUp({ email: emailFor(u), password: p, options: { data: { username: u.toLowerCase(), full_name: f.get("n").trim() } } });
      if (!r.error && !r.data.session) r = { error: { message: "Email confirmation is still enabled in Supabase (Auth > Providers > Email)." } };
    }
    btn.disabled = false;
    if (r.error) return toast(/invalid login/i.test(r.error.message) ? "Wrong username or password" : /already/i.test(r.error.message) ? "Username already taken" : r.error.message, true);
    boot();
  };
}

async function signOut() { await sb.auth.signOut(); S.me = null; S.anon = false; S.role = "none"; boot(); }

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data: cfg } = await sb.from("ws_settings").select("public_display").eq("id", 1).maybeSingle();
    if (cfg?.public_display) { S.anon = true; S.role = "viewer"; S.me = null; S.tv = true; return startApp(); }
    return renderAuth();
  }
  S.anon = false;
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !me) { toast("Profile not found", true); await sb.auth.signOut(); return renderAuth(); }
  if (!me.active) { toast("This account has been disabled", true); await sb.auth.signOut(); return renderAuth(); }
  S.me = me;
  await fetchRole();
  if (S.role === "none") return renderPending();
  startApp();
}

async function fetchRole() {
  if (S.anon) return S.role;
  const { data } = await sb.rpc("ws_role");
  S.role = data || "none";
  return S.role;
}

function renderPending() {
  document.body.classList.remove("tv");
  $("#app").innerHTML = `<div class="panel auth center"><h1>Waiting for access</h1>
    <p>Hi <b>${esc(S.me.full_name || S.me.username)}</b> – your account exists, but an admin still has to give you access to the workstation dashboard.</p>
    <p class="mut sm">This page updates by itself the moment access is granted.</p>
    <p><button class="sec" data-act="signout">Sign out</button></p></div>`;
  startLive();
}

// ---------- data ----------
async function loadCore() {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const [st, se, rs, cf] = await Promise.all([
    sb.from("ws_stations").select("*").order("id"),
    sb.from("ws_sessions").select("*").is("ended_at", null).order("started_at"),
    sb.from("ws_reservations").select("*").eq("status", "booked").gt("ends_at", startOfToday.toISOString()).order("starts_at"),
    sb.from("ws_settings").select("*").eq("id", 1).maybeSingle(),
  ]);
  if (st.error || se.error || rs.error) { S.live = false; paintLive(); return false; }
  S.stations = st.data; S.sessions = se.data; S.res = rs.data;
  if (cf.data) S.settings = cf.data;
  if (S.anon && !S.settings.public_display) { S.anon = false; renderAuth(); return false; }
  return true;
}
async function loadHistory() {
  const { data } = await sb.from("ws_sessions").select("*").order("started_at", { ascending: false }).limit(300);
  S.history = data || [];
}
async function loadAdmin() {
  const [p, m] = await Promise.all([
    sb.from("profiles").select("id,username,full_name,role,active,created_at").order("created_at"),
    sb.from("ws_members").select("*"),
  ]);
  S.profiles = p.data || []; S.members = m.data || [];
}

let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    if (!(await loadCore())) return;
    if (S.tab === "board") drawBoard();
    else if (S.tab === "reserve") drawReserveDyn();
    else if (S.tab === "timeline") { await loadTL(); drawTL(); }
    else if (S.tab === "history") { await loadHistory(); drawHistDyn(); }
    else if (S.tab === "admin" && !$("#view input:focus, #view textarea:focus")) { await loadAdmin(); drawAdmin(); }
  } finally { refreshing = false; if (again) { again = false; refresh(); } }
}

async function act(fn, args, okMsg) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) { toast(error.message, true); return null; }
  if (okMsg) toast(okMsg);
  await refresh();
  return data ?? true;
}

// ---------- live ----------
let channel, timers = [];
function startLive() {
  if (channel) sb.removeChannel(channel);
  const bump = debounce(async () => {
    if (!S.anon) {
      const before = S.role; await fetchRole();
      if (S.role !== before) { if (S.role === "none") return renderPending(); if (before === "none") return startApp(); drawChrome(); }
    }
    if (S.role !== "none") refresh();
  }, 200);
  channel = sb.channel("ws-live");
  ["ws_stations", "ws_sessions", "ws_reservations", "ws_members", "ws_settings"].forEach(t =>
    channel.on("postgres_changes", { event: "*", schema: "public", table: t }, bump));
  channel.subscribe(st => { S.live = st === "SUBSCRIBED"; paintLive(); });
  timers.forEach(clearInterval);
  timers = [
    setInterval(bump, S.anon ? 10000 : 30000), // safety net if a realtime event is ever missed
    setInterval(tick, 1000),
  ];
}
function teardown() { timers.forEach(clearInterval); timers = []; if (channel) { sb.removeChannel(channel); channel = null; } }
const paintLive = () => document.querySelectorAll(".dot.live").forEach(d => d.classList.toggle("on", S.live));
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.role !== "none") refresh(); });
window.addEventListener("online", () => { if (S.role !== "none") refresh(); });

let lastMinute = -1;
function tick() {
  const now = new Date();
  const c = $("#clock"); if (c) c.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  document.querySelectorAll("[data-since]").forEach(el => { el.textContent = dur(Date.now() - new Date(el.dataset.since)); });
  const m = now.getMinutes();
  if (m !== lastMinute) { lastMinute = m; if (S.tab === "board" && S.stations.length) drawBoard(); else if (S.tab === "reserve" && S.stations.length) drawReserveDyn(); else if (S.tab === "timeline" && S.tl?.data) drawTL(); }
}

// ---------- shell ----------
async function startApp() {
  S.tab = S.anon ? "board" : (S.tab || "board");
  if (!(await loadCore())) return;
  drawChrome();
  startLive();
  openTab(S.tab);
}

function tabsFor() {
  const t = [["board", "Live board"]];
  if (!S.anon) { t.push(["reserve", canUse() ? "Reserve" : "Schedule"], ["timeline", "Timeline"], ["history", "History"]); if (isAdmin()) t.push(["admin", "Admin"]); }
  return t;
}
function drawChrome() {
  document.body.classList.toggle("tv", S.tv);
  if (!tabsFor().some(t => t[0] === S.tab)) S.tab = "board";
  $("#app").innerHTML = `<header>
    <h1><span class="dot live ${S.live ? "on" : ""}" title="Live connection"></span>EUS Workstations</h1>
    <span id="clock" class="mut"></span>
    ${S.anon ? "" : `<span class="me hide-sm"><b>${esc(S.me.full_name || S.me.username)}</b> <span class="badge ${S.role}">${S.role}</span></span>`}
    <button class="sec sm" data-act="tv">${S.tv ? "Exit display mode" : "Display mode"}</button>
    ${S.anon ? `<button class="sm" data-act="login">Sign in</button>` : `<button class="sec sm" data-act="signout">Sign out</button>`}
  </header>
  <nav>${tabsFor().map(([k, l]) => `<button data-act="tab" data-t="${k}" class="${S.tab === k ? "on" : ""}">${l}</button>`).join("")}</nav>
  <main class="wrap" id="view"></main>`;
  tick();
}

function openTab(t) {
  S.tab = t;
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  if (t === "board") drawBoard();
  else if (t === "reserve") renderReserve();
  else if (t === "timeline") renderTimeline();
  else if (t === "history") renderHistory();
  else if (t === "admin") renderAdmin();
}

// ---------- live board ----------
function stationState(st) {
  if (!st.enabled) return { k: "off" };
  const sess = S.sessions.find(x => x.station_id === st.id);
  if (sess) return { k: "busy", sess };
  const ids = groupIds(st);
  const ps = S.sessions.find(x => ids.includes(x.station_id));
  if (ps) return { k: "kvm", sess: ps, by: byId(ps.station_id) };
  const now = Date.now();
  const cur = S.res.find(r => ids.includes(r.station_id) && +new Date(r.starts_at) <= now && +new Date(r.ends_at) > now);
  if (cur) return { k: "reserved", res: cur };
  return { k: "free" };
}
const upcoming = ids => S.res.filter(r => (!ids || ids.includes(r.station_id)) && +new Date(r.starts_at) > Date.now());

function resLine(r, st, soon) {
  const mins = Math.round((+new Date(r.starts_at) - Date.now()) / 60000);
  const where = st && r.station_id !== st.id ? ` <span class="tag">${esc(short(byId(r.station_id)))}</span>` : "";
  return `<div class="${soon && mins <= 60 ? "soon" : ""}">${dayLabel(r.starts_at)} ${hm(r.starts_at)}–${hm(r.ends_at)} · ${esc(r.user_name)}${r.case_number ? ` · ${esc(r.case_number)}` : ""}${where}${soon && mins <= 60 ? ` · starts in ${mins} min` : ""}</div>`;
}

function cardHTML(st) {
  const sx = stationState(st), k = sx.k, peers = peersOf(st), now = Date.now();
  const me = S.me?.id;
  const pill = { free: "Available", busy: "In use", reserved: "Reserved", kvm: "KVM in use", off: "Disabled" }[k];
  const tags = st.kvm_group
    ? `<span class="tag kvm">KVM switch${st.hdmi_ports ? ` · ${st.hdmi_ports}× HDMI` : ""} · shared with ${peers.map(short).map(esc).join(", ")}</span>`
    : st.hdmi_ports ? `<span class="tag kvm">Own KVM switch · ${st.hdmi_ports}× HDMI</span>` : `<span class="tag">Single device</span>`;
  let body = "";
  if (k === "busy") {
    const s = sx.sess;
    body = `<div class="who"><div class="av">${esc((s.user_name || "?").trim()[0]?.toUpperCase() || "?")}</div><div class="n">${esc(s.user_name)}</div></div>
      <div class="case"><small>Case</small>${esc(s.case_number)}</div>
      ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ""}
      <div class="since">Since ${hm(s.started_at)} · <span data-since="${esc(s.started_at)}">${dur(now - new Date(s.started_at))}</span></div>`;
  } else if (k === "kvm") {
    const s = sx.sess;
    body = `<div class="big">Shared KVM busy</div>
      <div class="desc">${esc(short(sx.by))} is using the shared KVM / monitors – ${esc(s.user_name)}, case ${esc(s.case_number)}.</div>
      <div class="since">Since ${hm(s.started_at)} · <span data-since="${esc(s.started_at)}">${dur(now - new Date(s.started_at))}</span></div>`;
  } else if (k === "reserved") {
    const r = sx.res;
    body = `<div class="big">Reserved</div>
      <div class="who"><div class="av">${esc((r.user_name || "?").trim()[0]?.toUpperCase() || "?")}</div><div class="n">${esc(r.user_name)}</div></div>
      <div class="since">${hm(r.starts_at)}–${hm(r.ends_at)}${r.station_id !== st.id ? ` on ${esc(short(byId(r.station_id)))} (shared KVM)` : ""}</div>
      ${r.case_number ? `<div class="case"><small>Case</small>${esc(r.case_number)}</div>` : ""}
      ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}`;
  } else if (k === "free") body = `<div class="big">Free to use</div>`;
  else body = `<div class="big">Disabled</div><div class="desc">Switched off by an admin.</div>`;

  const nx = upcoming(groupIds(st)).slice(0, 3);
  const next = nx.length ? `<div class="next"><b>Next bookings</b>${nx.map((r, i) => resLine(r, st, i === 0)).join("")}</div>` : "";

  let actions = "";
  if (!S.anon && canUse() && st.enabled) {
    const a = [];
    if (k === "free") a.push(`<button data-act="start" data-st="${st.id}">Start working</button>`);
    if (k === "reserved" && sx.res.user_id === me && sx.res.station_id === st.id) a.push(`<button class="ok" data-act="start" data-st="${st.id}" data-res="${sx.res.id}">Start my booking</button>`);
    if (k === "busy" && sx.sess.user_id === me) a.push(`<button class="sec" data-act="edit" data-id="${sx.sess.id}">Edit details</button><button class="bad" data-act="end" data-id="${sx.sess.id}">Finish</button>`);
    if (k === "busy" && sx.sess.user_id !== me && isAdmin()) a.push(`<button class="bad sm" data-act="release" data-id="${sx.sess.id}">Release (admin)</button>`);
    if (k === "kvm" && isAdmin()) a.push(`<button class="bad sm" data-act="release" data-id="${sx.sess.id}">Release ${esc(short(sx.by))} (admin)</button>`);
    a.push(`<button class="sec" data-act="reserve" data-st="${st.id}">Reserve</button>`);
    actions = `<div class="actions">${a.join("")}</div>`;
  }
  return `<article class="st ${k}"><div class="top"><h3>${esc(st.name)}</h3><span class="pill">${pill}</span></div>
    <div class="tags">${tags}${st.notes ? `<span class="tag">${esc(st.notes)}</span>` : ""}</div>
    <div class="body">${body}</div>${next}${actions}</article>`;
}

function drawBoard() {
  const soon = upcoming().slice(0, 8);
  $("#view").innerHTML = `<div class="grid">${S.stations.map(cardHTML).join("") || `<p class="empty">No workstations configured.</p>`}</div>
    ${!S.anon && soon.length ? `<section class="panel" id="soonlist" style="margin-top:14px"><h2>Coming up</h2><div class="list">${soon.map(r =>
      `<div><div class="grow"><div class="t">${dayLabel(r.starts_at)} ${hm(r.starts_at)}–${hm(r.ends_at)} · ${esc(short(byId(r.station_id)))}</div><div class="s">${esc(r.user_name)}${r.case_number ? ` · case ${esc(r.case_number)}` : ""}</div></div></div>`).join("")}</div></section>` : ""}`;
}

// ---------- start / edit dialog ----------
function openSessionDialog({ st, sess, res }) {
  const dlg = $("#dlg"), station = st || byId(sess.station_id);
  const r = res ? S.res.find(x => x.id === res) : null;
  const peers = peersOf(station);
  dlg.innerHTML = `<form id="sf"><h2>${sess ? "Edit details" : "Start working"} · ${esc(station.name)}</h2>
    ${!sess && peers.length ? `<p class="mut sm">${esc(station.name)} shares a KVM switch with ${peers.map(short).map(esc).join(", ")} – while you work here, ${peers.length > 1 ? "they are" : "it is"} unavailable.</p>` : ""}
    <label>Case number *</label><input name="c" required maxlength="60" value="${esc(sess?.case_number ?? r?.case_number ?? "")}" autocomplete="off">
    <label>Description (optional)</label><textarea name="d" maxlength="500" placeholder="What are you working on?">${esc(sess?.description ?? r?.description ?? "")}</textarea>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button type="button" class="sec" data-act="closedlg">Cancel</button><button>${sess ? "Save" : "Start"}</button></div></form>`;
  dlg.showModal();
  $("#sf [name=c]").focus();
  $("#sf").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = $("#sf .row button:last-child"); btn.disabled = true;
    const ok = sess
      ? await act("ws_update_session", { p_id: sess.id, p_case: f.get("c"), p_desc: f.get("d") }, "Saved")
      : await act("ws_start_session", { p_station: station.id, p_case: f.get("c"), p_desc: f.get("d"), p_reservation: res || null }, `You are now on ${station.name}`);
    btn.disabled = false;
    if (ok) dlg.close();
  };
}

// ---------- reserve / schedule ----------
function newRF(stationId) {
  const n = new Date(); n.setMinutes(Math.ceil(n.getMinutes() / 15) * 15, 0, 0);
  if (n.getHours() < DAY_START) n.setHours(DAY_START, 0, 0, 0);
  const e = new Date(+n + 36e5);
  return { station: stationId || S.stations.find(s => s.enabled)?.id || 1, date: ymd(n), start: hm(n), end: hm(e), case: "", desc: "" };
}
function rfRange() {
  const f = S.rf; if (!f.date || !f.start || !f.end) return null;
  const s = new Date(`${f.date}T${f.start}`); let e = new Date(`${f.date}T${f.end}`);
  if (isNaN(s) || isNaN(e)) return null;
  if (e <= s) e = new Date(+e + 864e5);
  return [s, e];
}
function renderReserve(stationId) {
  if (!S.rf || stationId) S.rf = { ...(S.rf || newRF(stationId)), ...(stationId ? { station: stationId } : {}) };
  const f = S.rf;
  $("#view").innerHTML = `
    ${canUse() ? `<section class="panel"><h2>Reserve a workstation</h2><form id="rf">
      <div class="row">
        <div><label>Workstation</label><select data-f="station">${S.stations.filter(s => s.enabled).map(s => `<option value="${s.id}">${esc(s.name)}${s.kvm_group ? " (KVM)" : ""}</option>`).join("")}</select></div>
        <div><label>Date</label><input type="date" data-f="date" required></div>
        <div><label>From</label><input type="time" data-f="start" step="900" required></div>
        <div><label>Until</label><input type="time" data-f="end" step="900" required></div>
      </div>
      <div class="chips"><span class="mut sm" style="align-self:center">Length:</span>${[30, 60, 120, 240, 480].map(m => `<button type="button" data-act="dur" data-m="${m}">${m < 60 ? m + " min" : m / 60 + " h"}</button>`).join("")}</div>
      <div class="row" style="margin-top:6px">
        <div><label>Case number *</label><input data-f="case" maxlength="60" autocomplete="off" required></div>
        <div style="flex:2 1 260px"><label>Description (optional)</label><input data-f="desc" maxlength="500" autocomplete="off"></div>
      </div>
      <p class="mut sm" id="rsum"></p>
      <button>Reserve</button></form></section>`
      : `<p class="mut">You have view-only access. Ask an admin for the <b>User</b> role to reserve workstations.</p>`}
    <section class="panel"><h2>Schedule</h2><div id="rtl"></div></section>
    <section class="panel"><h2>Upcoming reservations</h2><div id="rlist" class="list"></div></section>`;
  const form = $("#rf");
  if (form) {
    form.querySelectorAll("[data-f]").forEach(el => {
      el.value = f[el.dataset.f];
      el.addEventListener("input", () => { f[el.dataset.f] = el.value; drawReserveDyn(); });
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const r = rfRange(); if (!r) return toast("Pick a date and time", true);
      const btn = form.querySelector("button:last-child"); btn.disabled = true;
      const ok = await act("ws_reserve", { p_station: +f.station, p_start: r[0].toISOString(), p_end: r[1].toISOString(), p_case: f.case, p_desc: f.desc },
        `Reserved ${short(byId(+f.station))} · ${dayLabel(r[0])} ${hm(r[0])}–${hm(r[1])}`);
      btn.disabled = false;
      if (ok) { f.case = ""; f.desc = ""; form.querySelectorAll('[data-f="case"],[data-f="desc"]').forEach(x => x.value = ""); }
    };
  }
  drawReserveDyn();
}

function drawReserveDyn() {
  const tl = $("#rtl"); if (!tl) return;
  const f = S.rf, d0 = new Date(`${f.date || ymd(new Date())}T00:00`), a = +d0 + DAY_START * 36e5, now = Date.now(), dayEnd = +d0 + 864e5;
  const pv = canUse() ? rfRange() : null;
  const endH = winEnd(+d0, [...S.res.filter(r => +new Date(r.starts_at) < dayEnd && +new Date(r.ends_at) > +d0).map(r => Math.min(+new Date(r.ends_at), dayEnd)),
    ...(now >= +d0 && now < dayEnd && S.sessions.length ? [now] : []), ...(pv && +pv[0] < dayEnd && +pv[1] > +d0 ? [Math.min(+pv[1], dayEnd)] : [])]);
  S.winEnd = endH;
  const b = +d0 + endH * 36e5;
  const pos = (s, e) => { const l = Math.max(0, (s - a) / (b - a) * 100), r = Math.min(100, (e - a) / (b - a) * 100); return `left:${l}%;width:${Math.max(r - l, .5)}%`; };
  const me = S.me?.id;
  const rows = S.stations.map(st => {
    const ids = groupIds(st), bars = [];
    S.res.filter(r => ids.includes(r.station_id) && +new Date(r.ends_at) > a && +new Date(r.starts_at) < b).forEach(r => {
      const own = r.station_id === st.id;
      bars.push(`<div class="bar ${own ? (r.user_id === me ? "mine" : "") : "via"}" style="${pos(+new Date(r.starts_at), +new Date(r.ends_at))}" title="${esc(short(byId(r.station_id)))} · ${esc(r.user_name)} ${hm(r.starts_at)}–${hm(r.ends_at)}${r.case_number ? " · " + esc(r.case_number) : ""}">${esc(r.user_name)}</div>`);
    });
    S.sessions.filter(x => ids.includes(x.station_id)).forEach(x => {
      if (now < a || +new Date(x.started_at) > b) return;
      bars.push(`<div class="bar use" style="${pos(Math.max(+new Date(x.started_at), a), Math.min(now, b))}" title="In use now · ${esc(x.user_name)}">${esc(x.user_name)}</div>`);
    });
    if (pv && (+f.station === st.id || (+f.station !== st.id && ids.includes(+f.station) && st.kvm_group)))
      bars.push(`<div class="bar pv" style="${pos(+pv[0], +pv[1])}">${+f.station === st.id ? "your slot" : "blocked"}</div>`);
    return `<div class="line"><div class="lab" title="${esc(st.name)}">${esc(short(st))}</div><div class="trk" data-st="${st.id}">${afterHTML(endH)}${bars.join("")}${now >= a && now < b ? `<div class="nowline" style="left:${(now - a) / (b - a) * 100}%"></div>` : ""}</div></div>`;
  }).join("");
  tl.innerHTML = `<div class="mut sm" style="margin-bottom:6px">${canUse() ? "Tap a row to pick a start time. " : ""}${dayLabel(d0)}</div>
    <div class="tl" style="--n:${endH - DAY_START}">${axisHTML(endH)}${rows}</div>
    <div class="legend"><span><i style="background:var(--acc)"></i>Booked</span><span><i style="background:#7dd3fc"></i>Yours</span><span><i style="background:var(--busy)"></i>In use</span><span><i style="background:#a78bfa55;border:1px dashed var(--kvm)"></i>Blocked by shared KVM</span></div>`;
  const sum = $("#rsum");
  if (sum) { const r = rfRange(); sum.textContent = r ? `${dayLabel(r[0])} ${hm(r[0])} → ${+new Date(r[1].toDateString()) !== +new Date(r[0].toDateString()) ? dayLabel(r[1]) + " " : ""}${hm(r[1])} · ${dur(r[1] - r[0])}` : ""; }

  const list = S.res.filter(r => +new Date(r.ends_at) > now);
  $("#rlist").innerHTML = list.length ? list.map(r => `<div class="${r.user_id === me ? "mine" : ""}"><div class="grow"><div class="t">${dayLabel(r.starts_at)} ${hm(r.starts_at)}–${hm(r.ends_at)} · ${esc(short(byId(r.station_id)))}</div>
      <div class="s">${esc(r.user_name)}${r.case_number ? ` · case ${esc(r.case_number)}` : ""}${r.description ? ` · ${esc(r.description)}` : ""}</div></div>
      ${r.user_id === me || isAdmin() ? `<button class="sec sm" data-act="cancelres" data-id="${r.id}">Cancel</button>` : ""}</div>`).join("")
    : `<div class="empty">No upcoming reservations.</div>`;
}

// ---------- busy timeline ----------
const DAY_START = 7, WORK_END = 16; // normal day 07:00–16:00; never blocked after 16:00, timelines just stretch to fit late work
const winEnd = (d0, ends) => ends.reduce((h, t) => { const x = (t - d0) / 36e5; return x > h ? Math.min(24, Math.ceil(x)) : h; }, WORK_END);
const axisHTML = end => { const step = end - DAY_START <= 10 ? 1 : 2, hs = []; for (let h = DAY_START; h < end; h += step) hs.push(h);
  return `<div class="axis">${hs.map(h => `<span style="left:${(h - DAY_START) / (end - DAY_START) * 100}%">${pad(h)}</span>`).join("")}</div>`; };
const afterHTML = end => end > WORK_END ? `<div class="after" style="left:${(WORK_END - DAY_START) / (end - DAY_START) * 100}%" title="After 4 PM"></div>` : "";
const isOff = d => d.getDay() === 5 || d.getDay() === 6; // work week is Sunday–Thursday; Friday & Saturday are days off
const MODES = { day: ["Day", 1], week: ["Week", 7], month: ["Month", 30] };
function tlBounds() {
  const t = S.tl, [y, m, d] = t.date.split("-").map(Number), n = MODES[t.mode][1];
  // week = the Sunday–Saturday week containing the chosen day; month = the 30 days ending on it
  const first = t.mode === "week" ? d - new Date(y, m - 1, d).getDay() : d - (n - 1);
  return Array.from({ length: n + 1 }, (_, i) => new Date(y, m - 1, first + i));
}
async function loadTL() {
  const bd = tlBounds(), a = bd[0].toISOString(), b = bd[bd.length - 1].toISOString();
  const { data } = await sb.from("ws_sessions").select("*").lt("started_at", b).or(`ended_at.is.null,ended_at.gt.${a}`).order("started_at").limit(3000);
  S.tl.data = data || [];
}
function renderTimeline() {
  if (!S.tl) S.tl = { mode: "day", date: ymd(new Date()), data: [] };
  const t = S.tl;
  $("#view").innerHTML = `<section class="panel"><div class="row" style="align-items:center">
    <div class="chips" style="margin:0">${Object.entries(MODES).map(([k, v]) => `<button data-act="tlmode" data-m="${k}" class="${t.mode === k ? "on" : ""}">${v[0]}</button>`).join("")}</div>
    <div class="row" style="flex:0 1 auto;flex-wrap:nowrap;align-items:center"><button class="sec sm" data-act="tlstep" data-n="-1" aria-label="Earlier">‹</button>
      <input type="date" id="tld" value="${esc(t.date)}" style="min-width:150px"><button class="sec sm" data-act="tlstep" data-n="1" aria-label="Later">›</button>
      <button class="sec sm" data-act="tltoday">Today</button></div></div>
    <div id="tldyn" style="margin-top:12px"></div></section>`;
  loadTL().then(drawTL);
}
const sessHours = (x, a, b) => Math.max(0, Math.min(x.ended_at ? +new Date(x.ended_at) : Date.now(), b) - Math.max(+new Date(x.started_at), a)) / 36e5;
function drawTL() {
  const host = $("#tldyn"); if (!host || !S.tl) return;
  const t = S.tl, bd = tlBounds(), a = +bd[0], b = +bd[bd.length - 1], days = bd.length - 1, now = Date.now(), me = S.me?.id;
  const workdays = Math.max(1, bd.slice(0, -1).filter(d => !isOff(d)).length);
  const hrs = id => S.tl.data.filter(x => x.station_id === id).reduce((n, x) => n + sessHours(x, a, b), 0);
  let main;
  if (t.mode === "day") {
    const la = a + DAY_START * 36e5; // visible window starts at 07:00 and stretches past 16:00 only if someone worked later
    const endH = winEnd(a, [...t.data.map(x => Math.min(x.ended_at ? +new Date(x.ended_at) : now, b)), ...S.res.filter(r => +new Date(r.starts_at) < b && +new Date(r.ends_at) > a).map(r => Math.min(+new Date(r.ends_at), b))]);
    const wb = a + endH * 36e5;
    const pos = (s, e) => { const l = Math.max(0, (s - la) / (wb - la) * 100), r = Math.min(100, (e - la) / (wb - la) * 100); return `left:${l}%;width:${Math.max(r - l, .5)}%`; };
    const rows = S.stations.map(st => {
      const bars = [];
      S.res.filter(r => r.station_id === st.id && +new Date(r.ends_at) > la && +new Date(r.starts_at) < wb).forEach(r =>
        bars.push(`<div class="bar ${r.user_id === me ? "mine" : ""}" style="${pos(+new Date(r.starts_at), +new Date(r.ends_at))}" title="Booked · ${esc(r.user_name)} ${hm(r.starts_at)}–${hm(r.ends_at)}${r.case_number ? " · " + esc(r.case_number) : ""}">${esc(r.user_name)}</div>`));
      t.data.filter(x => x.station_id === st.id && sessHours(x, la, wb) > 0).forEach(x => {
        const e = x.ended_at ? +new Date(x.ended_at) : now;
        bars.push(`<div class="bar use" style="${pos(+new Date(x.started_at), e)}" title="${esc(x.user_name)} · case ${esc(x.case_number)} · ${hm(x.started_at)}–${x.ended_at ? hm(x.ended_at) : "now"}${x.description ? " · " + esc(x.description) : ""}">${esc(x.user_name)} · ${esc(x.case_number)}</div>`);
      });
      return `<div class="line"><div class="lab" title="${esc(st.name)}">${esc(short(st))}</div><div class="trk" style="cursor:default">${afterHTML(endH)}${bars.join("")}${now >= la && now < wb ? `<div class="nowline" style="left:${(now - la) / (wb - la) * 100}%"></div>` : ""}</div></div>`;
    }).join("");
    main = `<div class="mut sm" style="margin-bottom:6px">${dayLabel(bd[0])} · hover or tap a bar for details</div>
      <div class="tl" style="--n:${endH - DAY_START}">${axisHTML(endH)}${rows}</div>
      <div class="legend"><span><i style="background:var(--busy)"></i>Actually used</span><span><i style="background:var(--acc)"></i>Booked</span><span><i style="background:#7dd3fc"></i>Your booking</span></div>`;
  } else {
    const cols = bd.slice(0, -1).map((d, i) => ({ d, a: +d, b: +bd[i + 1] }));
    const head = cols.map(c => `<div class="hd ${isOff(c.d) ? "off" : ""}">${c.d.toLocaleDateString([], { weekday: days <= 7 ? "short" : "narrow" })}<br>${c.d.getDate()}</div>`).join("");
    const rows = S.stations.map(st => `<div class="hl">${esc(short(st))}</div>` + cols.map(c => {
      const h = t.data.filter(x => x.station_id === st.id).reduce((n, x) => n + sessHours(x, c.a, c.b), 0);
      return `<button class="hc ${isOff(c.d) ? "off" : ""}" data-act="tlday" data-d="${ymd(c.d)}" style="--v:${Math.min(1, h / 9).toFixed(2)}" title="${esc(st.name)} · ${c.d.toLocaleDateString()} · ${h.toFixed(1)} h used">${h >= .05 ? h.toFixed(h >= 10 ? 0 : 1) : ""}</button>`;
    }).join("")).join("");
    main = `<div class="mut sm" style="margin-bottom:6px">Hours used per day (darker = busier, 9 h+ is darkest). Fri &amp; Sat are days off (shaded). Tap a day to open it.</div>
      <div class="heatwrap"><div class="heat" style="grid-template-columns:48px repeat(${days},minmax(${days > 7 ? 30 : 48}px,1fr))"><div></div>${head}${rows}</div></div>`;
  }
  const dayWin = d => [+new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START), +new Date(d.getFullYear(), d.getMonth(), d.getDate(), WORK_END)];
  const winH = x => bd.slice(0, -1).reduce((n, d) => n + sessHours(x, ...dayWin(d)), 0);
  const capacity = workdays * (WORK_END - DAY_START);
  const sum = S.stations.map(st => {
    const w = t.data.filter(x => x.station_id === st.id).reduce((n, x) => n + winH(x), 0);
    const h = hrs(st.id), extra = h - w, n = t.data.filter(x => x.station_id === st.id && sessHours(x, a, b) > 0).length, pct = Math.min(100, w / capacity * 100);
    return `<div><div class="grow"><div class="t">${esc(st.name)}</div><div class="s">${n} session${n === 1 ? "" : "s"} · ${h.toFixed(1)} h used · ${(h / workdays).toFixed(1)} h per working day${extra >= .05 ? ` · <b>${extra.toFixed(1)} h outside 7 AM–4 PM</b>` : ""}</div>
      <div class="meter" title="${pct.toFixed(0)}% of working hours (7 AM–4 PM, Sun–Thu) in this period"><i style="width:${pct}%"></i></div></div><div class="big" style="font-size:20px;color:var(--txt)">${pct.toFixed(0)}%</div></div>`;
  }).join("");
  host.innerHTML = `${main}<h2 style="margin:18px 0 4px;font-size:16px">How busy · ${days === 1 ? dayLabel(bd[0]) : `${bd[0].toLocaleDateString([], { day: "numeric", month: "short" })} – ${new Date(b - 1).toLocaleDateString([], { day: "numeric", month: "short" })}`}</h2><div class="list">${sum}</div>`;
}

// ---------- history ----------
function renderHistory() {
  $("#view").innerHTML = `<section class="panel"><div class="row"><div><label>Search (name, case, workstation, description)</label><input id="hq" value="${esc(S.hq)}" autocomplete="off"></div>
    ${isAdmin() ? `<button class="sec" data-act="csv">Export CSV</button>` : ""}</div><div id="hdyn" class="list" style="margin-top:10px"></div></section>`;
  $("#hq").oninput = e => { S.hq = e.target.value; drawHistDyn(); };
  loadHistory().then(drawHistDyn);
}
function histFiltered() {
  const q = S.hq.trim().toLowerCase();
  return !q ? S.history : S.history.filter(h => [h.user_name, h.case_number, h.description, short(byId(h.station_id))].some(v => String(v ?? "").toLowerCase().includes(q)));
}
function drawHistDyn() {
  const el = $("#hdyn"); if (!el) return;
  const rows = histFiltered();
  el.innerHTML = rows.length ? rows.map(h => `<div><div class="grow"><div class="t">${esc(short(byId(h.station_id)))} · ${esc(h.user_name)} · case ${esc(h.case_number)}</div>
    ${h.description ? `<div class="s">${esc(h.description)}</div>` : ""}
    <div class="s">${dayLabel(h.started_at)} ${hm(h.started_at)}${h.ended_at ? `–${hm(h.ended_at)} · ${dur(new Date(h.ended_at) - new Date(h.started_at))}${h.ended_by ? ` · released by ${esc(h.ended_by)}` : ""}` : " · in progress"}</div></div></div>`).join("")
    : `<div class="empty">Nothing found.</div>`;
}
function exportCsv() {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["workstation", "user", "case", "description", "started", "ended", "minutes", "released_by"].join(",")].concat(histFiltered().map(h => [
    q(byId(h.station_id)?.name), q(h.user_name), q(h.case_number), q(h.description), q(h.started_at), q(h.ended_at),
    h.ended_at ? Math.round((new Date(h.ended_at) - new Date(h.started_at)) / 60000) : "", q(h.ended_by)].join(",")));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `workstation-history-${ymd(new Date())}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- admin ----------
function renderAdmin() { $("#view").innerHTML = `<p class="empty">Loading…</p>`; loadAdmin().then(drawAdmin); }
function drawAdmin() {
  if (S.tab !== "admin") return;
  const mem = Object.fromEntries(S.members.map(m => [m.user_id, m.role]));
  const people = S.profiles.map(p => ({ ...p, ws: p.role === "admin" ? "admin" : (mem[p.id] || "none"), pending: p.role !== "admin" && !mem[p.id] }))
    .sort((a, b) => b.pending - a.pending || a.username.localeCompare(b.username));
  const pendingN = people.filter(p => p.pending && p.active).length;
  $("#view").innerHTML = `
  <section class="panel"><h2>People & privileges ${pendingN ? `<span class="badge none">${pendingN} waiting</span>` : ""}</h2>
    <p class="mut sm">New accounts start with <b>No access</b>. Viewer = watch the board · User = start work and reserve · Admin = everything below.</p>
    <div class="list">${people.map(p => `<div class="${p.pending && p.active ? "mine" : ""}"><div class="grow"><div class="t">${esc(p.full_name || p.username)} <span class="mut sm">@${esc(p.username)}</span>
      ${p.pending && p.active ? `<span class="badge none">new</span>` : ""}${p.active ? "" : `<span class="badge">disabled</span>`}</div>
      <div class="s">${p.role === "admin" ? "App owner – always has full access" : ROLE_HELP[p.ws]}</div></div>
      ${p.role === "admin" || p.id === S.me.id ? `<span class="badge admin">${p.role === "admin" ? "owner" : p.ws}</span>`
        : `<select data-act="setrole" data-id="${p.id}" style="width:auto;min-width:150px">${Object.keys(ROLES).map(k => `<option value="${k}" ${p.ws === k ? "selected" : ""}>${ROLES[k]}</option>`).join("")}</select>`}</div>`).join("")}</div></section>

  <section class="panel"><h2>Wall display</h2>
    <label class="chk"><input type="checkbox" data-act="setpublic" ${S.settings.public_display ? "checked" : ""}> Allow a read-only public display (no login)</label>
    <p class="mut sm">When on, anyone with the link can see who is on each workstation (name, case, description) and upcoming bookings – handy for a TV. Nothing can be changed from it.
    Link: <a href="${esc(location.origin + location.pathname)}?tv">${esc(location.origin + location.pathname)}?tv</a></p></section>

  <h2 style="margin:18px 2px 10px;font-size:17px">Workstations</h2>
  <div class="sgrid">${S.stations.map(st => `<section class="panel" data-sid="${st.id}"><b>#${st.id}</b>
    <label>Name</label><input data-k="name" value="${esc(st.name)}" maxlength="40">
    <label>Shared-KVM group (only if stations share ONE switch, so they can't run together; blank = independent)</label><input data-k="kvm_group" value="${esc(st.kvm_group || "")}" maxlength="20">
    <label>HDMI ports on its KVM switch (blank = no KVM)</label><input data-k="hdmi_ports" type="number" min="0" max="16" value="${st.hdmi_ports ?? ""}">
    <label>Notes (optional)</label><input data-k="notes" value="${esc(st.notes || "")}" maxlength="120">
    <label class="chk"><input type="checkbox" data-k="enabled" ${st.enabled ? "checked" : ""}> Enabled</label>
    <p><button class="sm" data-act="savest" data-id="${st.id}">Save</button></p></section>`).join("")}</div>`;
}
async function adminWrite(q, okMsg) {
  const { error } = await q;
  if (error) { toast(error.message, true); return false; }
  toast(okMsg); await loadCore(); await loadAdmin(); drawAdmin(); return true;
}

// ---------- events ----------
const actions = {
  tab: el => openTab(el.dataset.t),
  signout: () => signOut(),
  login: () => { S.anon = false; S.tv = false; teardown(); renderAuth(); },
  tv: async () => {
    S.tv = !S.tv; document.body.classList.toggle("tv", S.tv); drawChrome(); openTab(S.tab);
    try { if (S.tv) { await document.documentElement.requestFullscreen?.(); S.wake = await navigator.wakeLock?.request("screen"); } else { if (document.fullscreenElement) await document.exitFullscreen(); S.wake?.release(); } } catch { /* not supported / denied */ }
  },
  start: el => openSessionDialog({ st: byId(+el.dataset.st), res: el.dataset.res }),
  edit: el => openSessionDialog({ sess: S.sessions.find(s => s.id === el.dataset.id) }),
  end: el => act("ws_end_session", { p_id: el.dataset.id }, "Workstation released"),
  release: el => { const s = S.sessions.find(x => x.id === el.dataset.id); if (s && confirm(`Release ${short(byId(s.station_id))}? ${s.user_name} is marked as finished.`)) act("ws_end_session", { p_id: s.id }, "Released"); },
  reserve: el => { S.tab = "reserve"; S.rf = { ...(S.rf || newRF()), station: +el.dataset.st }; openTab("reserve"); window.scrollTo({ top: 0 }); },
  cancelres: el => { if (confirm("Cancel this reservation?")) act("ws_cancel_reservation", { p_id: el.dataset.id }, "Reservation cancelled"); },
  closedlg: () => $("#dlg").close(),
  csv: exportCsv,
  tlmode: el => { S.tl.mode = el.dataset.m; renderTimeline(); },
  tlstep: el => { const [y, m, d] = S.tl.date.split("-").map(Number); S.tl.date = ymd(new Date(y, m - 1, d + MODES[S.tl.mode][1] * +el.dataset.n)); renderTimeline(); },
  tltoday: () => { S.tl.date = ymd(new Date()); renderTimeline(); },
  tlday: el => { S.tl.mode = "day"; S.tl.date = el.dataset.d; renderTimeline(); },
  dur: el => { const r = rfRange(); if (!r) return; const e = new Date(+r[0] + +el.dataset.m * 6e4); S.rf.end = hm(e); $('#rf [data-f="end"]').value = S.rf.end; drawReserveDyn(); },
  savest: el => {
    const p = el.closest("[data-sid]"), g = k => p.querySelector(`[data-k="${k}"]`);
    adminWrite(sb.from("ws_stations").update({
      name: g("name").value.trim() || `Workstation ${el.dataset.id}`, kvm_group: g("kvm_group").value.trim() || null,
      hdmi_ports: g("hdmi_ports").value === "" ? null : +g("hdmi_ports").value, notes: g("notes").value.trim() || null, enabled: g("enabled").checked,
    }).eq("id", +el.dataset.id), "Workstation saved");
  },
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (el && el.tagName !== "SELECT" && !(el.tagName === "INPUT")) actions[el.dataset.act]?.(el);
  // click on a timeline row picks station + start time
  const trk = e.target.closest(".trk");
  if (trk && S.rf && $("#rf")) {
    const r = trk.getBoundingClientRect(), mins = Math.round((DAY_START * 60 + (e.clientX - r.left) / r.width * ((S.winEnd || WORK_END) - DAY_START) * 60) / 15) * 15;
    const keep = rfRange(), len = keep ? keep[1] - keep[0] : 36e5; // keep the chosen length
    S.rf.station = +trk.dataset.st; S.rf.start = `${pad(Math.min(23, Math.floor(mins / 60)))}:${pad(mins % 60)}`;
    S.rf.end = hm(new Date(+new Date(`${S.rf.date}T${S.rf.start}`) + len));
    $("#rf").querySelectorAll("[data-f]").forEach(x => x.value = S.rf[x.dataset.f]);
    drawReserveDyn();
  }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.act === "setrole") adminWrite(sb.from("ws_members").upsert({ user_id: el.dataset.id, role: el.value, updated_at: new Date().toISOString() }), `Access set to “${ROLES[el.value]}”`);
  if (el.id === "tld" && el.value) { S.tl.date = el.value; renderTimeline(); }
  if (el.dataset.act === "setpublic") adminWrite(sb.from("ws_settings").update({ public_display: el.checked }).eq("id", 1), el.checked ? "Public display is ON" : "Public display is OFF");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
