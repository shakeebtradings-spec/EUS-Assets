"use strict";
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.EUS_CONFIG;
// Every request gets a timeout so a dead connection fails fast (and the app falls back to local data).
const timedFetch = (u, o = {}) => { const c = new AbortController(), t = setTimeout(() => c.abort(), 15000); return fetch(u, { ...o, signal: o.signal || c.signal }).finally(() => clearTimeout(t)); };
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  global: { fetch: timedFetch },
});
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PAGE = 50;
const STATUS = { in_store: "In store", checked_out: "Checked out", maintenance: "Maintenance", retired: "Retired" };
const emailFor = u => `${u.toLowerCase()}@eus-assets.app`; // usernames map to a placeholder email; no email is ever sent
const uuid = () => crypto.randomUUID?.() || "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };
const isNetErr = e => !!e && (/fetch|network|load failed|abort|timeout|offline/i.test(`${e.name} ${e.message}`) && !/^P\d|^2|^4/.test(e.code || ""));

const S = { me: null, stores: [], storeId: localStorage.getItem("store") || "", tab: "scan", mode: "check_out",
  assets: { q: "", status: "", all: false, page: 0 }, scanner: null, lastScan: { code: "", at: 0 }, live: false,
  online: navigator.onLine, syncing: false, flushing: false, dl: 0 };

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2800); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const storeName = id => S.stores.find(s => s.id === id)?.name ?? "—";
const fmt = d => new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const isAdmin = () => S.me?.role === "admin";
const personName = id => { const p = C.profiles.get(id); return p ? p.full_name || p.username : "someone"; };
const needOnline = () => S.online || (toast("This needs an internet connection"), false);

// ---------- offline data: a local copy of every asset (IndexedDB) + a queue of changes made offline ----------
const DB = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open("eus-assets", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("assets", { keyPath: "id" }); d.createObjectStore("outbox", { keyPath: "op_id" }); d.createObjectStore("meta"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = (store, mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined); t.onerror = t.onabort = () => rej(t.error);
  })).catch(() => undefined); // IndexedDB unavailable (private mode): the app still works from memory
  return {
    all: st => tx(st, "readonly", o => o.getAll()).then(r => r || []),
    get: (st, k) => tx(st, "readonly", o => o.get(k)),
    put: (st, v, k) => tx(st, "readwrite", o => o.put(v, k)),
    putMany: (st, vs) => vs.length ? tx(st, "readwrite", o => { vs.forEach(v => o.put(v)); }) : Promise.resolve(),
    del: (st, k) => tx(st, "readwrite", o => o.delete(k)),
  };
})();
const C = { byId: new Map(), byTag: new Map(), profiles: new Map(), outbox: [], lastSync: null, lastFull: 0 };
const dirty = new Map();
const persist = debounce(() => { const v = [...dirty.values()]; dirty.clear(); DB.putMany("assets", v); }, 300);
function putAsset(a, save = true) {
  const old = C.byId.get(a.id); if (old && old.tag !== a.tag) C.byTag.delete(old.tag);
  C.byId.set(a.id, a); C.byTag.set(a.tag, a);
  if (save) { dirty.set(a.id, a); persist(); }
}
function removeAsset(id) { const a = C.byId.get(id); if (a) C.byTag.delete(a.tag); C.byId.delete(id); dirty.delete(id); DB.del("assets", id); }
const pendingTags = () => new Set(C.outbox.filter(o => !o.err).map(o => o.tag));
async function loadCache() {
  for (const a of await DB.all("assets")) putAsset(a, false);
  C.outbox = (await DB.all("outbox")).sort((x, y) => x.at.localeCompare(y.at));
  C.lastSync = (await DB.get("meta", "lastSync")) || null;
  C.lastFull = (await DB.get("meta", "lastFull")) || 0;
  for (const p of jget("profiles", [])) C.profiles.set(p.id, p);
  S.stores = jget("stores", []);
}

// Download assets: everything on first run (and every 12h), otherwise only what changed since the last sync.
async function syncAssets(forceFull) {
  if (!navigator.onLine || S.syncing) return;
  S.syncing = true; renderBanner();
  try {
    const full = forceFull || !C.lastSync || Date.now() - C.lastFull > 12 * 3600e3;
    let from = 0, max = C.lastSync, n = 0; const ids = new Set();
    for (;;) {
      let q = sb.from("assets").select("*").range(from, from + 999);
      q = full ? q.order("id") : q.gte("updated_at", C.lastSync).order("updated_at").order("id");
      const { data, error } = await q; if (error) throw error;
      const skip = pendingTags(), fresh = data.filter(a => !skip.has(a.tag));
      data.forEach(a => { ids.add(a.id); if (!max || a.updated_at > max) max = a.updated_at; });
      fresh.forEach(a => putAsset(a, false)); await DB.putMany("assets", fresh);
      n += data.length; if (full) { S.dl = n; renderBanner(); }
      if (data.length < 1000) break; from += 1000;
    }
    if (full) { [...C.byId.keys()].forEach(id => ids.has(id) || removeAsset(id)); C.lastFull = Date.now(); await DB.put("meta", C.lastFull, "lastFull"); }
    C.lastSync = max; await DB.put("meta", max, "lastSync"); S.online = true;
  } catch (e) { if (isNetErr(e)) S.online = false; else console.warn(e); }
  finally { S.syncing = false; S.dl = 0; renderBanner(); }
}
async function syncMeta() {
  try {
    const { data, error } = await sb.from("profiles").select("*"); if (error) throw error;
    C.profiles = new Map(data.map(p => [p.id, p])); jset("profiles", data);
    await loadStores();
  } catch (e) { if (isNetErr(e)) S.online = false; }
}
async function syncAll() {
  if (!S.me) return;
  S.online = navigator.onLine; if (!S.online) return renderBanner();
  await flushOutbox(); await syncMeta(); await syncAssets();
  renderBanner(); if (S.tab === "scan") { loadMine(); renderSync(); } else renderTab(true);
}

// Changes confirmed while offline wait here; each carries a unique id so a retry can never apply twice.
async function flushOutbox() {
  if (S.flushing || !C.outbox.some(o => !o.err)) return;
  S.flushing = true; renderBanner();
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // not signed in / token not refreshable yet: keep waiting
    for (const op of [...C.outbox]) {
      if (op.err || op.user_id !== session.user.id) continue;
      const { data, error } = await sb.rpc("scan_asset", { p_tag: op.tag, p_action: op.action, p_store: op.store_id, p_note: op.note,
        p_condition: op.condition, p_op_id: op.op_id, p_at: op.at });
      if (error) {
        if (isNetErr(error) || /jwt/i.test(error.message)) { if (isNetErr(error)) S.online = false; break; }
        op.err = error.message.replace(/^NOT_FOUND: /, ""); await DB.put("outbox", op);
        const { data: fresh } = await sb.from("assets").select("*").eq("tag", op.tag).maybeSingle(); // undo the optimistic change
        if (fresh) putAsset(fresh); else { const a = C.byTag.get(op.tag); a && removeAsset(a.id); }
        continue;
      }
      C.outbox.splice(C.outbox.indexOf(op), 1); await DB.del("outbox", op.op_id); putAsset(data);
    }
  } finally { S.flushing = false; renderBanner(); renderSync(); }
}

function renderBanner() {
  const el = $("#banner"); if (!el) return;
  const wait = C.outbox.filter(o => !o.err).length, bad = C.outbox.length - wait, w = `${wait} change${wait === 1 ? "" : "s"}`;
  let msg = "", cls = "";
  if (!S.online) { msg = `Offline – working from saved data${C.lastSync ? ` (last synced ${fmt(C.lastSync)})` : ""}.${wait ? ` ${w} will sync when you are back online.` : ""}`; cls = "off"; }
  else if (S.dl) { msg = `Downloading assets… ${S.dl}`; cls = "busy"; }
  else if (S.flushing || S.syncing) { msg = wait ? `Syncing ${w}…` : "Syncing…"; cls = "busy"; }
  else if (wait) { msg = `${w} waiting to sync.`; cls = "busy"; }
  else if (bad) { msg = `${bad} change${bad === 1 ? "" : "s"} could not be saved – see Sync issues on the Scan tab.`; cls = "off"; }
  el.className = "banner " + cls; el.textContent = msg; el.style.display = msg ? "" : "none";
  const d = $(".live"); if (d) d.classList.toggle("on", S.live && S.online);
}
window.addEventListener("online", () => { S.online = true; syncAll(); });
window.addEventListener("offline", () => { S.online = false; renderBanner(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncAll(); });
setInterval(() => { if (S.me && navigator.onLine && (!S.online || C.outbox.some(o => !o.err))) syncAll(); }, 20000);

// ---------- auth ----------
function renderAuth(mode = "in") {
  stopScanner();
  $("#app").innerHTML = `<form class="card auth" id="af">
    <h1>EUS Assets</h1><p class="mut">${mode === "in" ? "Sign in with your username" : "Create an account (no email needed)"}</p>
    <label>Username</label><input name="u" required minlength="3" maxlength="30" pattern="[A-Za-z0-9._-]+" autocomplete="username" autocapitalize="none">
    ${mode === "up" ? `<label>Full name</label><input name="n" required autocomplete="name">` : ""}
    <label>Password</label><input name="p" type="password" required minlength="6" autocomplete="${mode === "in" ? "current-password" : "new-password"}">
    <p><button style="width:100%">${mode === "in" ? "Sign in" : "Create account"}</button></p>
    <p class="mut" style="text-align:center"><a href="#" id="sw" style="color:var(--acc)">${mode === "in" ? "Create an account" : "I already have an account"}</a></p></form>`;
  $("#sw").onclick = e => { e.preventDefault(); renderAuth(mode === "in" ? "up" : "in"); };
  $("#af").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), u = f.get("u").trim(), p = f.get("p"), btn = $("#af button");
    btn.disabled = true;
    let r;
    if (mode === "in") r = await sb.auth.signInWithPassword({ email: emailFor(u), password: p });
    else {
      r = await sb.auth.signUp({ email: emailFor(u), password: p, options: { data: { username: u.toLowerCase(), full_name: f.get("n").trim() } } });
      if (!r.error && !r.data.session) r = { error: { message: "Supabase still requires email confirmation. Turn off Auth > Providers > Email > 'Confirm email'." } };
    }
    btn.disabled = false;
    if (r.error && isNetErr(r.error)) return toast("No connection. The first sign-in on a device needs internet.");
    if (r.error) return toast(/invalid login/i.test(r.error.message) ? "Wrong username or password" : /already/i.test(r.error.message) ? "Username already taken" : r.error.message);
    boot();
  };
}

async function boot() {
  await loadCache();
  let session = null, err = null;
  try { ({ data: { session }, error: err } = await sb.auth.getSession()); } catch (e) { err = e; }
  const cachedMe = jget("me", null);
  const offlineStart = () => { S.me = cachedMe; S.online = false; start(); };
  if (!session) return cachedMe && (!navigator.onLine || isNetErr(err)) ? offlineStart() : renderAuth();
  let me, error;
  try { ({ data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single()); } catch (e) { error = e; }
  if (error && isNetErr(error)) return cachedMe?.id === session.user.id ? offlineStart() : (toast("No connection"), renderAuth());
  if (error || !me) { toast("Profile not found"); await sb.auth.signOut(); return renderAuth(); }
  if (!me.active) { toast("This account has been disabled"); await sb.auth.signOut(); return renderAuth(); }
  jset("me", me); S.me = me; S.online = true; start();
}
async function start() { if (!S.stores.length) await loadStores(); else pickStore(); renderShell(); subscribe(); syncAll(); }

function pickStore() {
  if (!S.stores.find(s => s.id === S.storeId)) S.storeId = S.stores[0]?.id || "";
  localStorage.setItem("store", S.storeId);
}
async function loadStores() {
  try {
    const { data, error } = await sb.from("stores").select("*").order("name"); if (error) throw error;
    S.stores = data; jset("stores", data);
  } catch (e) { if (isNetErr(e)) S.online = false; S.stores = jget("stores", S.stores); }
  pickStore();
}

// ---------- live updates ----------
let channel;
function subscribe() {
  if (channel) sb.removeChannel(channel);
  const bump = debounce(() => { if (S.tab === "scan") { loadMine(); renderCart(); } else renderTab(true); }, 400);
  const meta = debounce(async () => { await syncMeta(); renderShell(true); }, 600);
  channel = sb.channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "assets" }, p => {
      if (p.eventType === "DELETE") removeAsset(p.old.id); else if (!pendingTags().has(p.new.tag)) putAsset(p.new);
      bump(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, meta)
    .on("postgres_changes", { event: "*", schema: "public", table: "stores" }, meta)
    .subscribe(st => { S.live = st === "SUBSCRIBED"; renderBanner(); });
}

// ---------- shell ----------
function renderShell() {
  const tabs = [["scan", "Scan"], ["assets", "Assets"], ["activity", "Activity"], ["people", "People"], ...(isAdmin() ? [["admin", "Admin"]] : [])];
  stopScanner();
  $("#app").innerHTML = `<header><span class="live ${S.live && S.online ? "on" : ""}" title="Live connection"></span><h1>EUS Assets</h1>
    <select id="store" aria-label="Store">${S.stores.map(s => `<option value="${s.id}" ${s.id === S.storeId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
    <button class="sec sm" id="out" title="${esc(S.me.username)}">Sign out</button></header><div id="banner" class="banner" style="display:none"></div>
    <nav>${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === S.tab ? "on" : ""}">${l}</button>`).join("")}</nav>
    <div class="wrap" id="main"></div>`;
  $("#store").onchange = e => { stopScanner(); S.storeId = e.target.value; localStorage.setItem("store", S.storeId); S.assets.page = 0; renderTab(); };
  $("#out").onclick = async () => {
    const n = C.outbox.filter(o => !o.err).length;
    if (n && !confirm(`${n} change${n === 1 ? " is" : "s are"} not synced yet. They stay on this device and sync when ${S.me.username} signs in again with a connection. Sign out anyway?`)) return;
    await sb.auth.signOut(); S.me = null; localStorage.removeItem("me"); renderAuth();
  };
  document.querySelectorAll("nav button").forEach(b => b.onclick = () => { stopScanner(); S.tab = b.dataset.t; document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b)); renderTab(); });
  renderBanner(); renderTab();
}
function renderTab() { ({ scan: viewScan, assets: viewAssets, activity: viewActivity, people: viewPeople, admin: viewAdmin }[S.tab])(arguments[0]); }

// ---------- scan (collect first, save only on Confirm) ----------
const CONDITIONS = { good: "Good", damaged: "Damaged", needs_repair: "Needs repair", missing_parts: "Missing parts" };
const loadCart = () => { try { return { check_out: [], check_in: [], ...JSON.parse(localStorage.getItem("cart") || "{}") }; } catch { return { check_out: [], check_in: [] }; } };
S.cart = loadCart();
const saveCart = () => { try { localStorage.setItem("cart", JSON.stringify(S.cart)); } catch { } };

function viewScan(refresh) {
  if (refresh && S.scanner) { renderCart(); return; } // don't disturb a running camera
  $("#main").innerHTML = `<div class="card"><div class="seg">
      <button data-m="check_out" class="out">Check OUT</button><button data-m="check_in" class="in">Check IN</button></div>
      <p class="mut" id="hint"></p>
      <div id="reader"></div>
      <p class="row"><button id="cam">Start camera</button></p>
      <form class="row" id="mf"><input name="c" placeholder="…or type / use a USB scanner" autocomplete="off"><button class="sec">Add</button></form></div>
      <div id="res"></div><div class="card" id="cart"></div><div id="sync"></div>
      <div class="card"><b>My items</b><div class="list" id="mine"></div></div>`;
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { S.mode = b.dataset.m; $("#res").innerHTML = ""; renderMode(); });
  $("#cam").onclick = () => S.scanner ? stopScanner() : startScanner();
  $("#mf").onsubmit = e => { e.preventDefault(); const c = e.target.c.value.trim(); e.target.c.value = ""; if (c) handleCode(c, true); };
  renderMode(); renderSync(); loadMine();
}
function renderMode() {
  document.querySelectorAll("[data-m]").forEach(b => b.classList.toggle("on", b.dataset.m === S.mode));
  $("#hint").innerHTML = S.mode === "check_in"
    ? `Scan items to add them to the list. Nothing is saved until you press <b>Confirm</b>. They will be checked into <b>${esc(storeName(S.storeId))}</b>.`
    : `Scan items to add them to the list. Nothing is saved until you press <b>Confirm</b>. They will be checked out to <b>you</b>.`;
  renderCart();
}
function renderCart() {
  const el = $("#cart"); if (!el) return;
  const items = S.cart[S.mode], inn = S.mode === "check_in";
  if (!items.length) { el.innerHTML = `<b>${inn ? "Check-in" : "Check-out"} list</b><p class="mut">Empty. Scan a barcode to add items.</p>`; return; }
  el.innerHTML = `<b>${inn ? "Check-in to " + esc(storeName(S.storeId)) : "Check-out"} list (${items.length})</b>
    <div class="list">${items.map((it, i) => `<div style="align-items:flex-start"><span style="flex:1"><b>${esc(it.name)}</b><br><span class="mut">${esc(it.tag)} · ${esc(it.from)}</span>
      ${it.err ? `<br><span style="color:var(--bad)">${esc(it.err)}</span>` : ""}
      ${inn ? `<select data-c="${i}" style="margin-top:6px">${Object.entries(CONDITIONS).map(([k, v]) => `<option value="${k}" ${it.condition === k ? "selected" : ""}>${v}</option>`).join("")}</select>` : ""}</span>
      <button class="sec sm" data-x="${i}" aria-label="Remove">✕</button></div>`).join("")}</div>
    <label>Note (optional)</label><input id="cnote" value="${esc(S.cartNote || "")}" placeholder="e.g. job / reason">
    <p class="row"><button id="ok" class="${inn ? "" : "bad"}" style="${inn ? "background:var(--ok)" : "background:var(--warn);color:#000"}">Confirm ${inn ? "check-in" : "check-out"} (${items.length})</button>
    <button class="sec" id="clr">Clear list</button></p>`;
  el.querySelectorAll("[data-c]").forEach(sel => sel.onchange = () => { items[+sel.dataset.c].condition = sel.value; saveCart(); });
  el.querySelectorAll("[data-x]").forEach(b => b.onclick = () => { items.splice(+b.dataset.x, 1); saveCart(); renderCart(); });
  $("#cnote").oninput = e => S.cartNote = e.target.value;
  $("#clr").onclick = () => { if (confirm("Clear the whole list?")) { S.cart[S.mode] = []; saveCart(); renderCart(); } };
  $("#ok").onclick = confirmCart;
}
// Confirm: the changes are saved on this device first (so nothing is lost without signal), then sent to the server.
async function confirmCart() {
  const mode = S.mode, items = S.cart[mode].splice(0), note = (S.cartNote || "").trim() || null, inn = mode === "check_in";
  if (!items.length) return;
  S.cartNote = ""; saveCart(); renderCart();
  const ops = items.map(it => ({ op_id: uuid(), tag: it.tag, name: it.name, action: mode, store_id: inn ? S.storeId || null : null, note,
    condition: inn ? it.condition : null, at: new Date().toISOString(), user_id: S.me.id }));
  for (const op of ops) {
    const a = C.byTag.get(op.tag); // optimistic local update so the list is right straight away, even offline
    if (a) putAsset({ ...a, status: inn ? "in_store" : "checked_out", holder_id: inn ? null : S.me.id, store_id: inn ? op.store_id || a.store_id : a.store_id, condition: inn ? op.condition : a.condition });
    C.outbox.push(op); await DB.put("outbox", op);
  }
  const res = $("#res"); if (res) res.innerHTML = `<div class="card result"><b>Saving ${ops.length} item${ops.length === 1 ? "" : "s"}…</b></div>`;
  S.online = navigator.onLine; renderBanner();
  await flushOutbox();
  const left = ops.filter(o => C.outbox.includes(o)), failed = left.filter(o => o.err).length, waiting = left.length - failed, done = ops.length - left.length;
  const where = inn ? "checked in to " + esc(storeName(S.storeId)) : "checked out";
  const r = $("#res"); if (r) r.innerHTML = `<div class="card result ${failed ? "err" : ""}">${done ? `<b>${done} item${done === 1 ? "" : "s"} ${where}.</b><br>` : ""}
    ${waiting ? `<b>${waiting} item${waiting === 1 ? "" : "s"} saved on this device</b> – will sync automatically when online.<br>` : ""}
    ${failed ? `${failed} could not be saved – see Sync issues below.` : ""}</div>`;
  if (done || waiting) { navigator.vibrate?.(80); beep(); }
  renderCart(); renderSync(); loadMine();
}
function renderSync() {
  const el = $("#sync"); if (!el) return;
  const wait = C.outbox.filter(o => !o.err), bad = C.outbox.filter(o => o.err);
  if (!C.outbox.length) { el.innerHTML = ""; return; }
  const row = o => `<div><span><b>${esc(o.name)}</b> <span class="mut">${esc(o.tag)} · ${o.action === "check_in" ? "check-in" : "check-out"} · ${fmt(o.at)}</span>${o.err ? `<br><span style="color:var(--bad)">${esc(o.err)}</span>` : ""}</span>
    ${o.err ? `<span class="row" style="flex:0 0 auto"><button class="sec sm" data-retry="${o.op_id}">Retry</button><button class="sec sm" data-drop="${o.op_id}">Dismiss</button></span>` : ""}</div>`;
  el.innerHTML = `<div class="card">${wait.length ? `<b>Waiting to sync (${wait.length})</b><div class="list">${wait.map(row).join("")}</div>` : ""}
    ${bad.length ? `<b style="color:var(--bad)">Sync issues (${bad.length})</b><div class="list">${bad.map(row).join("")}</div>` : ""}
    ${wait.length ? `<p><button class="sec sm" id="syncnow">Sync now</button></p>` : ""}</div>`;
  el.querySelectorAll("[data-retry]").forEach(b => b.onclick = async () => { const o = C.outbox.find(x => x.op_id === b.dataset.retry); delete o.err; await DB.put("outbox", o); syncAll(); renderSync(); });
  el.querySelectorAll("[data-drop]").forEach(b => b.onclick = async () => { C.outbox = C.outbox.filter(x => x.op_id !== b.dataset.drop); await DB.del("outbox", b.dataset.drop); renderSync(); renderBanner(); });
  $("#syncnow") && ($("#syncnow").onclick = () => syncAll());
}
function loadMine() {
  const el = $("#mine"); if (!el) return;
  const mine = [...C.byId.values()].filter(a => a.holder_id === S.me.id).sort((x, y) => (y.updated_at || "").localeCompare(x.updated_at || ""));
  el.innerHTML = mine.map(a => `<div><span><b>${esc(a.name)}</b><br><span class="mut">${esc(a.tag)} · from ${esc(storeName(a.store_id))}</span></span></div>`).join("") || `<p class="mut">Nothing checked out.</p>`;
}
async function startScanner() {
  if (typeof Html5Qrcode === "undefined") return toast("Scanner library failed to load");
  const sc = new Html5Qrcode("reader", { verbose: false, useBarCodeDetectorIfSupported: true });
  try {
    // facingMode "environment" = back camera only; no camera picker is shown.
    await sc.start({ facingMode: { exact: "environment" } }, { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * .85), height: Math.floor(Math.min(h, w) * .5) }), aspectRatio: 1.5 },
      code => handleCode(code), () => {});
  } catch (e1) {
    try { await sc.start({ facingMode: "environment" }, { fps: 12, qrbox: { width: 280, height: 160 } }, code => handleCode(code), () => {}); }
    catch (e2) { return toast("Camera unavailable: allow camera access (site must be HTTPS)"); }
  }
  S.scanner = sc; $("#cam").textContent = "Stop camera";
}
function stopScanner() {
  const sc = S.scanner; S.scanner = null;
  if (sc) sc.stop().then(() => sc.clear()).catch(() => {});
  const b = $("#cam"); if (b) b.textContent = "Start camera";
}
// A scan only looks the asset up (in the local copy, so it works offline) and adds it to the pending list.
async function handleCode(code, manual) {
  const now = Date.now();
  if (!manual && code === S.lastScan.code && now - S.lastScan.at < 3000) return; // debounce repeat reads
  S.lastScan = { code, at: now };
  const res = $("#res"); if (!res) return;
  const mode = S.mode, list = S.cart[mode];
  const bad = html => { navigator.vibrate?.([200, 80, 200]); res.innerHTML = `<div class="card result err">${html}</div>`; };
  if (list.some(i => i.tag === code)) return bad(`<b>${esc(code)}</b><br>Already in the list.`);
  let a = C.byTag.get(code);
  if (!a && navigator.onLine) { // not downloaded yet (e.g. just added by an admin): ask the server
    try { const { data } = await sb.from("assets").select("*").eq("tag", code).maybeSingle(); if (data) { putAsset(data); a = data; } } catch { }
  }
  if (!a) return bad(!C.byId.size && !navigator.onLine ? `<b>${esc(code)}</b><br>No asset data on this device yet. Connect to the internet once so it can download.`
      : `<b>${esc(code)}</b><br>No asset with this barcode${navigator.onLine ? "" : " in the offline copy"}.${isAdmin() && navigator.onLine ? ` <button class="sm" id="addnew">Add as new asset</button>` : ""}`),
    $("#addnew") && ($("#addnew").onclick = () => assetDialog({ tag: code }));
  const who = personName(a.holder_id);
  if (a.status === "maintenance" || a.status === "retired") return bad(`<b>${esc(a.name)}</b><br>Asset is ${STATUS[a.status].toLowerCase()} and cannot be moved.`);
  if (mode === "check_out" && a.status === "checked_out") return bad(`<b>${esc(a.name)}</b><br>Already checked out by ${esc(who)}.`);
  if (mode === "check_in" && a.status === "in_store" && a.store_id === S.storeId) return bad(`<b>${esc(a.name)}</b><br>Already in ${esc(storeName(S.storeId))}.`);
  if (S.cart[mode] !== list) return; // mode switched meanwhile
  list.push({ tag: a.tag, name: a.name, condition: "good", from: a.status === "checked_out" ? `with ${who}` : storeName(a.store_id) });
  saveCart(); navigator.vibrate?.(60); beep();
  res.innerHTML = `<div class="card result"><b>Added:</b> ${esc(a.name)}<br><span class="mut">Press Confirm when you have scanned everything.</span></div>`;
  renderCart();
}
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(); o.frequency.value = 880; o.connect(c.destination); o.start(); o.stop(c.currentTime + .1); } catch { } }

// ---------- assets ----------
function viewAssets(refresh) {
  const A = S.assets;
  if (!refresh || !$("#alist")) {
    $("#main").innerHTML = `<div class="card"><div class="row">
      <input id="q" type="search" placeholder="Search name or barcode" value="${esc(A.q)}">
      <select id="st"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${A.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select id="sc"><option value="0">This store</option><option value="1" ${A.all ? "selected" : ""}>All stores</option></select>
      ${isAdmin() ? `<button id="add">+ Add</button>` : ""}</div><p class="mut" id="cnt"></p>
      <div class="list" id="alist"></div><div class="row"><button class="sec" id="pv">Prev</button><span class="mut" id="pg" style="text-align:center"></span><button class="sec" id="nx">Next</button></div></div>`;
    $("#q").oninput = debounce(e => { A.q = e.target.value; A.page = 0; viewAssets(true); }, 300);
    $("#st").onchange = e => { A.status = e.target.value; A.page = 0; viewAssets(true); };
    $("#sc").onchange = e => { A.all = e.target.value === "1"; A.page = 0; viewAssets(true); };
    $("#pv").onclick = () => { A.page = Math.max(0, A.page - 1); viewAssets(true); };
    $("#nx").onclick = () => { A.page++; viewAssets(true); };
    if (isAdmin()) $("#add").onclick = () => assetDialog();
  }
  const term = A.q.toLowerCase().trim();
  let rows = [...C.byId.values()];
  if (!A.all && S.storeId) rows = rows.filter(a => a.store_id === S.storeId);
  if (A.status) rows = rows.filter(a => a.status === A.status);
  if (term) rows = rows.filter(a => a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term) || (a.category || "").toLowerCase().includes(term));
  rows.sort((x, y) => x.name.localeCompare(y.name) || x.tag.localeCompare(y.tag));
  const count = rows.length, last = Math.max(0, Math.ceil(count / PAGE) - 1);
  if (A.page > last) A.page = last;
  const data = rows.slice(A.page * PAGE, A.page * PAGE + PAGE);
  if (!$("#alist")) return;
  $("#cnt").textContent = `${count} asset${count === 1 ? "" : "s"}${C.lastSync ? ` · synced ${fmt(C.lastSync)}` : ""}`;
  $("#pg").textContent = `Page ${A.page + 1} / ${last + 1}`;
  $("#pv").disabled = A.page === 0; $("#nx").disabled = A.page >= last;
  $("#alist").innerHTML = data.map(a => `<div><span><b>${esc(a.name)}</b> <span class="pill ${a.status}">${STATUS[a.status]}</span><br>
      <span class="mut">${esc(a.tag)}${a.category ? " · " + esc(a.category) : ""} · ${esc(storeName(a.store_id))}${a.holder_id ? " · " + esc(personName(a.holder_id)) : ""}${a.condition && a.condition !== "good" ? " · " + esc(CONDITIONS[a.condition]) : ""}</span></span>
      ${isAdmin() ? `<button class="sec sm" data-e="${a.id}">Edit</button>` : ""}</div>`).join("") || `<p class="mut">${C.byId.size ? "No assets found." : "No assets downloaded yet."}</p>`;
  document.querySelectorAll("[data-e]").forEach(b => b.onclick = () => assetDialog(C.byId.get(b.dataset.e)));
}

function dialog(html) {
  const d = document.createElement("dialog"); d.innerHTML = html; document.body.appendChild(d);
  d.addEventListener("close", () => d.remove()); d.showModal(); return d;
}
function assetDialog(a = {}) {
  const d = dialog(`<form method="dialog" id="df"><h3>${a.id ? "Edit" : "Add"} asset</h3>
    <label>Barcode</label><input name="tag" required value="${esc(a.tag)}">
    <label>Name</label><input name="name" required value="${esc(a.name)}">
    <label>Category</label><input name="category" value="${esc(a.category)}">
    <label>Store</label><select name="store_id">${S.stores.map(s => `<option value="${s.id}" ${(a.store_id || S.storeId) === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
    <label>Status</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(a.status || "in_store") === k ? "selected" : ""}>${v}</option>`).join("")}</select>
    <label>Notes</label><textarea name="notes" rows="2">${esc(a.notes)}</textarea>
    <svg id="bc" style="width:100%;margin-top:8px;background:#fff;border-radius:6px"></svg>
    <p class="row"><button>Save</button><button type="button" class="sec" id="pr">Print label</button>${a.id ? `<button type="button" class="bad" id="rm">Delete</button>` : ""}<button type="button" class="sec" id="cx">Cancel</button></p></form>`);
  const f = $("#df", d), draw = () => { try { JsBarcode($("#bc", d), f.tag.value || " ", { format: "CODE128", height: 50, displayValue: true }); } catch { } };
  draw(); f.tag.oninput = draw;
  $("#cx", d).onclick = () => d.close();
  $("#pr", d).onclick = () => { const w = open("", "_blank"); w.document.write(`<body style="text-align:center;font-family:sans-serif">${$("#bc", d).outerHTML}<div>${esc(f.name.value)}</div><script>print()<\/script>`); w.document.close(); };
  if (a.id) $("#rm", d).onclick = async () => { if (!confirm("Delete this asset and its history?")) return; if (!needOnline()) return; const { error } = await sb.from("assets").delete().eq("id", a.id); error ? toast(error.message) : (removeAsset(a.id), d.close(), viewAssets(true)); };
  f.onsubmit = async e => {
    const v = Object.fromEntries(new FormData(f)); v.tag = v.tag.trim(); v.name = v.name.trim();
    if (v.status !== "checked_out") v.holder_id = null;
    if (!needOnline()) return e.preventDefault();
    const r = await (a.id ? sb.from("assets").update(v).eq("id", a.id) : sb.from("assets").insert(v)).select().single();
    if (r.error) { e.preventDefault(); toast(/duplicate/.test(r.error.message) ? "Barcode already exists" : r.error.message); } else { putAsset(r.data); viewAssets(true); }
  };
}

// ---------- activity ----------
async function viewActivity() {
  $("#main").innerHTML = `<div class="card"><b>Recent activity</b> <span class="mut" id="actnote"></span><div class="list" id="act"></div></div>`;
  let data = null;
  if (navigator.onLine) {
    try {
      const r = await sb.from("movements").select("id,action,note,condition,created_at,store_id,assets(tag,name),profiles(username,full_name)").order("created_at", { ascending: false }).limit(100);
      if (r.error) throw r.error; data = r.data; jset("activity", data); S.online = true;
    } catch (e) { if (isNetErr(e)) S.online = false; else return toast(e.message); }
  }
  if (!$("#act")) return;
  const cached = !data; data ??= jget("activity", []);
  $("#actnote").textContent = cached ? "(saved copy – offline)" : "(live)";
  const pend = C.outbox.filter(o => !o.err).sort((x, y) => y.at.localeCompare(x.at));
  const line = (who, act, name, tag, store, when, tail) => `<div><span><b>${esc(who)}</b> ${act === "check_out" ? "took" : "returned"} <b>${esc(name)}</b><br>
    <span class="mut">${esc(tag)} · ${esc(store)} · ${fmt(when)}${tail || ""}</span></span>
    <span class="pill ${act === "check_out" ? "checked_out" : "in_store"}">${act === "check_out" ? "OUT" : "IN"}</span></div>`;
  $("#act").innerHTML = pend.map(o => line(S.me.full_name || S.me.username, o.action, o.name, o.tag, storeName(o.store_id || C.byTag.get(o.tag)?.store_id), o.at, " · waiting to sync")).join("")
    + data.map(m => line(m.profiles?.full_name || m.profiles?.username, m.action, m.assets?.name, m.assets?.tag, storeName(m.store_id), m.created_at,
      m.condition && m.condition !== "good" ? ` · ${CONDITIONS[m.condition] || ""}` : "")).join("") || `<p class="mut">No activity yet.</p>`;
}

// ---------- people ----------
function viewPeople() {
  $("#main").innerHTML = `<div class="card"><b>User directory</b><div class="list" id="ppl"></div></div>`;
  const ps = [...C.profiles.values()].sort((x, y) => x.username.localeCompare(y.username));
  const n = {}; C.byId.forEach(a => { if (a.status === "checked_out" && a.holder_id) n[a.holder_id] = (n[a.holder_id] || 0) + 1; });
  $("#ppl").innerHTML = ps.map(p => `<div><span><b>${esc(p.full_name || p.username)}</b> <span class="mut">@${esc(p.username)}</span>
    ${p.role === "admin" ? `<span class="pill">admin</span>` : ""}${p.active ? "" : ` <span class="pill retired">disabled</span>`}<br><span class="mut">${n[p.id] || 0} item(s) held · joined ${fmt(p.created_at)}</span></span>
    ${isAdmin() && p.id !== S.me.id ? `<span class="row" style="flex:0 0 auto"><button class="sec sm" data-r="${p.id}" data-v="${p.role}">${p.role === "admin" ? "Make staff" : "Make admin"}</button>
      <button class="sec sm" data-a="${p.id}" data-v="${p.active}">${p.active ? "Disable" : "Enable"}</button></span>` : ""}</div>`).join("") || `<p class="mut">Not downloaded yet.</p>`;
  const upd = async (id, patch) => { if (!needOnline()) return; const { error } = await sb.from("profiles").update(patch).eq("id", id); error && toast(error.message); };
  document.querySelectorAll("[data-r]").forEach(b => b.onclick = () => upd(b.dataset.r, { role: b.dataset.v === "admin" ? "staff" : "admin" }));
  document.querySelectorAll("[data-a]").forEach(b => b.onclick = () => upd(b.dataset.a, { active: b.dataset.v !== "true" }));
}

// ---------- admin ----------
function viewAdmin() {
  $("#main").innerHTML = `<div class="card"><b>Stores</b><div class="list" id="sl"></div>
      <form class="row" id="sf"><input name="n" placeholder="New store name" required><input name="l" placeholder="Location (optional)"><button>Add store</button></form></div>
    <div class="card"><b>Bulk import assets (CSV)</b>
      <p class="mut">Header row: <code>tag,name,category,store</code> (store = store name; blank uses the selected store). Existing barcodes are updated. Handles thousands of rows.</p>
      <input type="file" id="csv" accept=".csv,text/csv"><p id="imp" class="mut"></p>
      <button class="sec sm" id="exp">Export all assets (CSV)</button></div>`;
  $("#sl").innerHTML = S.stores.map(s => `<div><span><b>${esc(s.name)}</b> <span class="mut">${esc(s.location)}</span></span></div>`).join("");
  $("#sf").onsubmit = async e => { e.preventDefault(); if (!needOnline()) return; const f = e.target; const { error } = await sb.from("stores").insert({ name: f.n.value.trim(), location: f.l.value.trim() || null }); error ? toast(error.message) : f.reset(); };
  $("#csv").onchange = e => importCsv(e.target.files[0]);
  $("#exp").onclick = exportCsv;
}
function parseCsv(t) {
  const rows = []; let r = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { r.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; r.push(c); c = ""; if (r.some(x => x.trim())) rows.push(r); r = []; }
    else c += ch;
  }
  r.push(c); if (r.some(x => x.trim())) rows.push(r);
  return rows;
}
async function importCsv(file) {
  if (!file || !needOnline()) return;
  const out = $("#imp"), rows = parseCsv((await file.text()).replace(/^﻿/, ""));
  const head = rows.shift().map(h => h.trim().toLowerCase()), ix = k => head.indexOf(k);
  if (ix("tag") < 0 || ix("name") < 0) return out.textContent = "CSV needs 'tag' and 'name' columns.";
  const byName = Object.fromEntries(S.stores.map(s => [s.name.toLowerCase(), s.id]));
  const seen = new Map(), bad = [];
  rows.forEach((r, i) => {
    const tag = (r[ix("tag")] || "").trim(), name = (r[ix("name")] || "").trim(), sn = ix("store") >= 0 ? (r[ix("store")] || "").trim().toLowerCase() : "";
    const store_id = sn ? byName[sn] : S.storeId;
    if (!tag || !name || !store_id) return bad.push(i + 2);
    seen.set(tag, { tag, name, category: ix("category") >= 0 ? (r[ix("category")] || "").trim() || null : null, store_id });
  });
  const items = [...seen.values()]; let done = 0;
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await sb.from("assets").upsert(items.slice(i, i + 500), { onConflict: "tag" });
    if (error) return out.textContent = `Failed after ${done} rows: ${error.message}`;
    done += Math.min(500, items.length - i); out.textContent = `Imported ${done} / ${items.length}…`;
  }
  await syncAssets(true);
  out.textContent = `Imported ${done} assets.${bad.length ? ` Skipped invalid rows: ${bad.slice(0, 20).join(", ")}${bad.length > 20 ? "…" : ""}` : ""}`;
}
function exportCsv() { // from the local copy, so it works offline too
  const all = [...C.byId.values()].sort((x, y) => x.tag.localeCompare(y.tag));
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "tag,name,category,store,status\n" + all.map(a => [a.tag, a.name, a.category, storeName(a.store_id), a.status].map(q).join(",")).join("\n");
  const l = document.createElement("a"); l.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); l.download = "assets.csv"; l.click();
}

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT") { S.me = null; renderAuth(); } });
boot();
