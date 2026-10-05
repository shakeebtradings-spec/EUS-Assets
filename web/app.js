"use strict";
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.EUS_CONFIG;
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PAGE = 50;
const STATUS = { in_store: "In store", checked_out: "Checked out", maintenance: "Maintenance", retired: "Retired" };
const emailFor = u => `${u.toLowerCase()}@eus-assets.app`; // usernames map to a placeholder email; no email is ever sent

const S = { me: null, stores: [], storeId: localStorage.getItem("store") || "", tab: "scan", mode: "check_out",
  assets: { q: "", status: "", all: false, page: 0 }, scanner: null, lastScan: { code: "", at: 0 }, live: false };

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2800); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const storeName = id => S.stores.find(s => s.id === id)?.name ?? "—";
const fmt = d => new Date(d).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const isAdmin = () => S.me?.role === "admin";

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
    if (r.error) return toast(/invalid login/i.test(r.error.message) ? "Wrong username or password" : /already/i.test(r.error.message) ? "Username already taken" : r.error.message);
    boot();
  };
}

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderAuth();
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !me) { toast("Profile not found"); await sb.auth.signOut(); return renderAuth(); }
  if (!me.active) { toast("This account has been disabled"); await sb.auth.signOut(); return renderAuth(); }
  S.me = me;
  await loadStores();
  renderShell();
  subscribe();
}

async function loadStores() {
  const { data } = await sb.from("stores").select("*").order("name");
  S.stores = data || [];
  if (!S.stores.find(s => s.id === S.storeId)) S.storeId = S.stores[0]?.id || "";
  localStorage.setItem("store", S.storeId);
}

// ---------- live updates ----------
let channel;
function subscribe() {
  if (channel) sb.removeChannel(channel);
  const bump = debounce(() => { if (S.tab !== "scan") renderTab(true); }, 400);
  channel = sb.channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "assets" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "stores" }, async () => { await loadStores(); renderShell(true); })
    .subscribe(st => { S.live = st === "SUBSCRIBED"; const d = $(".live"); if (d) d.classList.toggle("on", S.live); });
}
// Re-sync whenever the device comes back online / app returns to foreground.
window.addEventListener("online", () => S.me && renderTab(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) renderTab(true); });

// ---------- shell ----------
function renderShell(keepTab) {
  const tabs = [["scan", "Scan"], ["assets", "Assets"], ["activity", "Activity"], ["people", "People"], ...(isAdmin() ? [["admin", "Admin"]] : [])];
  $("#app").innerHTML = `<header><span class="live ${S.live ? "on" : ""}" title="Live connection"></span><h1>EUS Assets</h1>
    <select id="store" aria-label="Store">${S.stores.map(s => `<option value="${s.id}" ${s.id === S.storeId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
    <button class="sec sm" id="out" title="${esc(S.me.username)}">Sign out</button></header>
    <nav>${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === S.tab ? "on" : ""}">${l}</button>`).join("")}</nav>
    <div class="wrap" id="main"></div>`;
  $("#store").onchange = e => { S.storeId = e.target.value; localStorage.setItem("store", S.storeId); S.assets.page = 0; renderTab(); };
  $("#out").onclick = async () => { await sb.auth.signOut(); S.me = null; renderAuth(); };
  document.querySelectorAll("nav button").forEach(b => b.onclick = () => { stopScanner(); S.tab = b.dataset.t; document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b)); renderTab(); });
  renderTab();
}
function renderTab() { ({ scan: viewScan, assets: viewAssets, activity: viewActivity, people: viewPeople, admin: viewAdmin }[S.tab])(arguments[0]); }

// ---------- scan ----------
function viewScan(refresh) {
  if (refresh && S.scanner) return; // don't disturb a running camera
  $("#main").innerHTML = `<div class="card"><div class="seg">
      <button data-m="check_out" class="out ${S.mode === "check_out" ? "on" : ""}">Check OUT</button>
      <button data-m="check_in" class="in ${S.mode === "check_in" ? "on" : ""}">Check IN</button></div>
      <p class="mut">${S.mode === "check_in" ? `Items scanned are returned to <b>${esc(storeName(S.storeId))}</b>.` : "Items scanned are taken by you."}</p>
      <div id="reader"></div>
      <p class="row"><button id="cam">Start camera</button></p>
      <form class="row" id="mf"><input name="c" placeholder="…or type / use a USB scanner" autocomplete="off"><button class="sec">Go</button></form></div>
      <div id="res"></div><div class="card"><b>My items</b><div class="list" id="mine"></div></div>`;
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { S.mode = b.dataset.m; viewScan(); });
  $("#cam").onclick = () => S.scanner ? stopScanner() : startScanner();
  $("#mf").onsubmit = e => { e.preventDefault(); const c = e.target.c.value.trim(); e.target.c.value = ""; if (c) handleCode(c, true); };
  loadMine();
}
async function loadMine() {
  const { data } = await sb.from("assets").select("tag,name,store_id,updated_at").eq("holder_id", S.me.id).order("updated_at", { ascending: false });
  const el = $("#mine"); if (!el) return;
  el.innerHTML = (data || []).map(a => `<div><span><b>${esc(a.name)}</b><br><span class="mut">${esc(a.tag)} · from ${esc(storeName(a.store_id))}</span></span></div>`).join("") || `<p class="mut">Nothing checked out.</p>`;
}
async function startScanner() {
  if (typeof Html5Qrcode === "undefined") return toast("Scanner library failed to load (offline?)");
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
async function handleCode(code, manual) {
  const now = Date.now();
  if (!manual && code === S.lastScan.code && now - S.lastScan.at < 3000) return; // debounce repeat reads
  S.lastScan = { code, at: now };
  const { data, error } = await sb.rpc("scan_asset", { p_tag: code, p_action: S.mode, p_store: S.storeId || null });
  const res = $("#res"); if (!res) return;
  if (error) {
    navigator.vibrate?.([200, 80, 200]);
    const msg = error.message.replace(/^NOT_FOUND: /, "");
    res.innerHTML = `<div class="card result err"><b>${esc(code)}</b><br>${esc(msg)}</div>`;
    return;
  }
  navigator.vibrate?.(60); beep();
  res.innerHTML = `<div class="card result"><b>${S.mode === "check_out" ? "Checked out" : "Checked in"}:</b> ${esc(data.name)}<br><span class="mut">${esc(data.tag)} · ${esc(storeName(data.store_id))}</span></div>`;
  loadMine();
}
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(); o.frequency.value = 880; o.connect(c.destination); o.start(); o.stop(c.currentTime + .1); } catch { } }

// ---------- assets ----------
async function viewAssets(refresh) {
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
  let q = sb.from("assets").select("*, holder:profiles(username,full_name)", { count: "exact" }).order("name").range(A.page * PAGE, A.page * PAGE + PAGE - 1);
  if (!A.all && S.storeId) q = q.eq("store_id", S.storeId);
  if (A.status) q = q.eq("status", A.status);
  const term = A.q.replace(/[,()%*]/g, " ").trim();
  if (term) q = q.or(`name.ilike.%${term}%,tag.ilike.%${term}%,category.ilike.%${term}%`);
  const { data, count, error } = await q;
  if (error) return toast(error.message);
  if (!$("#alist")) return;
  const last = Math.max(0, Math.ceil((count || 0) / PAGE) - 1);
  if (A.page > last) { A.page = last; return viewAssets(true); }
  $("#cnt").textContent = `${count} asset${count === 1 ? "" : "s"}`;
  $("#pg").textContent = `Page ${A.page + 1} / ${last + 1}`;
  $("#pv").disabled = A.page === 0; $("#nx").disabled = A.page >= last;
  $("#alist").innerHTML = data.map(a => `<div><span><b>${esc(a.name)}</b> <span class="pill ${a.status}">${STATUS[a.status]}</span><br>
      <span class="mut">${esc(a.tag)}${a.category ? " · " + esc(a.category) : ""} · ${esc(storeName(a.store_id))}${a.holder ? " · " + esc(a.holder.full_name || a.holder.username) : ""}</span></span>
      ${isAdmin() ? `<button class="sec sm" data-e="${a.id}">Edit</button>` : ""}</div>`).join("") || `<p class="mut">No assets found.</p>`;
  document.querySelectorAll("[data-e]").forEach(b => b.onclick = () => assetDialog(data.find(a => a.id === b.dataset.e)));
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
  if (a.id) $("#rm", d).onclick = async () => { if (!confirm("Delete this asset and its history?")) return; const { error } = await sb.from("assets").delete().eq("id", a.id); error ? toast(error.message) : (d.close(), viewAssets(true)); };
  f.onsubmit = async e => {
    const v = Object.fromEntries(new FormData(f)); v.tag = v.tag.trim(); v.name = v.name.trim();
    if (v.status !== "checked_out") v.holder_id = null;
    const r = a.id ? await sb.from("assets").update(v).eq("id", a.id) : await sb.from("assets").insert(v);
    if (r.error) { e.preventDefault(); toast(/duplicate/.test(r.error.message) ? "Barcode already exists" : r.error.message); } else viewAssets(true);
  };
}

// ---------- activity ----------
async function viewActivity() {
  $("#main").innerHTML = `<div class="card"><b>Recent activity</b> <span class="mut">(live)</span><div class="list" id="act"></div></div>`;
  const { data, error } = await sb.from("movements").select("id,action,note,created_at,store_id,assets(tag,name),profiles(username,full_name)").order("created_at", { ascending: false }).limit(100);
  if (error) return toast(error.message);
  if (!$("#act")) return;
  $("#act").innerHTML = data.map(m => `<div><span><b>${esc(m.profiles?.full_name || m.profiles?.username)}</b> ${m.action === "check_out" ? "took" : "returned"} <b>${esc(m.assets?.name)}</b><br>
    <span class="mut">${esc(m.assets?.tag)} · ${esc(storeName(m.store_id))} · ${fmt(m.created_at)}</span></span>
    <span class="pill ${m.action === "check_out" ? "checked_out" : "in_store"}">${m.action === "check_out" ? "OUT" : "IN"}</span></div>`).join("") || `<p class="mut">No activity yet.</p>`;
}

// ---------- people ----------
async function viewPeople() {
  $("#main").innerHTML = `<div class="card"><b>User directory</b><div class="list" id="ppl"></div></div>`;
  const [{ data: ps, error }, { data: held }] = await Promise.all([
    sb.from("profiles").select("*").order("username"),
    sb.from("assets").select("holder_id").eq("status", "checked_out")]);
  if (error) return toast(error.message);
  if (!$("#ppl")) return;
  const n = {}; (held || []).forEach(h => n[h.holder_id] = (n[h.holder_id] || 0) + 1);
  $("#ppl").innerHTML = ps.map(p => `<div><span><b>${esc(p.full_name || p.username)}</b> <span class="mut">@${esc(p.username)}</span>
    ${p.role === "admin" ? `<span class="pill">admin</span>` : ""}${p.active ? "" : ` <span class="pill retired">disabled</span>`}<br><span class="mut">${n[p.id] || 0} item(s) held · joined ${fmt(p.created_at)}</span></span>
    ${isAdmin() && p.id !== S.me.id ? `<span class="row" style="flex:0 0 auto"><button class="sec sm" data-r="${p.id}" data-v="${p.role}">${p.role === "admin" ? "Make staff" : "Make admin"}</button>
      <button class="sec sm" data-a="${p.id}" data-v="${p.active}">${p.active ? "Disable" : "Enable"}</button></span>` : ""}</div>`).join("");
  document.querySelectorAll("[data-r]").forEach(b => b.onclick = async () => { const { error } = await sb.from("profiles").update({ role: b.dataset.v === "admin" ? "staff" : "admin" }).eq("id", b.dataset.r); error && toast(error.message); });
  document.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => { const { error } = await sb.from("profiles").update({ active: b.dataset.v !== "true" }).eq("id", b.dataset.a); error && toast(error.message); });
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
  $("#sf").onsubmit = async e => { e.preventDefault(); const f = e.target; const { error } = await sb.from("stores").insert({ name: f.n.value.trim(), location: f.l.value.trim() || null }); error ? toast(error.message) : f.reset(); };
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
  if (!file) return;
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
  out.textContent = `Imported ${done} assets.${bad.length ? ` Skipped invalid rows: ${bad.slice(0, 20).join(", ")}${bad.length > 20 ? "…" : ""}` : ""}`;
}
async function exportCsv() {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("assets").select("tag,name,category,status,store_id").order("tag").range(from, from + 999);
    if (error) return toast(error.message);
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "tag,name,category,store,status\n" + all.map(a => [a.tag, a.name, a.category, storeName(a.store_id), a.status].map(q).join(",")).join("\n");
  const l = document.createElement("a"); l.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); l.download = "assets.csv"; l.click();
}

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT") { S.me = null; renderAuth(); } });
boot();
