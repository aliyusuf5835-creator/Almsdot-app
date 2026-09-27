/* ============================================================================
   ALMSDOT TRADING LTD — app.js
   Vanilla JS, no build step. Talks to Supabase (Postgres + Auth) directly.
   All business rules (duplicate serials, sale-once, quality gate, roles)
   are enforced server-side in SQL functions — this file only calls them
   and renders the results. See supabase/migrations/0001_init.sql.
============================================================================ */

// ---- 1. Configuration -------------------------------------------------
// These two values are safe to expose publicly: the "publishable" key is
// designed for the browser and is meaningless without your Row Level
// Security policies, which are what actually protect the data.
const SUPABASE_URL = "https://wrtspdninxarjavrfeym.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_-J9UR_AdptQ-adrqhP3WOw_gW48gl9R";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ---- 2. State -----------------------------------------------------------
let page = "dashboard";
let currentUser = null;     // Supabase auth user
let currentProfile = null;  // { id, email, full_name, role, active }
let cache = { teams: [], salespeople: [], batches: [] };

// ---- 3. Small helpers -----------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
const fmtMoney = (n) => "KES " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "");
const fmtDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const todayStr = () => new Date().toISOString().slice(0, 10);

function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

function modal(body) {
  $("modal").innerHTML = `<div class="modal-box"><button class="close" onclick="closeModal()">&times;</button>${body}</div>`;
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }

// Wraps a Supabase call, turns network/DB errors into readable messages
// instead of a raw "Failed to fetch", and never crashes the render loop.
async function safeCall(promise, { fallback = null } = {}) {
  try {
    const r = await promise;
    if (r && r.error) {
      throw r.error;
    }
    return { data: r ? r.data : null, error: null };
  } catch (err) {
    let message = "Something went wrong.";
    if (err instanceof TypeError && /fetch/i.test(err.message || "")) {
      message = "Could not reach the server. Check your internet connection, then try again.";
    } else if (err && err.message) {
      message = err.message;
    }
    console.error(err);
    return { data: fallback, error: message };
  }
}

function errorPanel(message, retryFn) {
  return `<div class="wrap"><div class="error-panel"><span>&#9888; ${esc(message)}</span>
    <button class="secondary" onclick="(${retryFn})()">Retry</button></div></div>`;
}

// Generic CSV export (BOM for Excel, quotes escaped, commas/newlines safe).
function toCsv(rows, headers) {
  if (!rows.length) return "";
  const keys = headers || Object.keys(rows[0]);
  const esc1 = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc1(r[k])).join(","))].join("\n");
}
function downloadCsv(filename, rows, headers) {
  if (!rows.length) return toast("Nothing to export");
  const csv = toCsv(rows, headers);
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function serialsFromText(v) {
  return [...new Set(v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

function roleBadge(role) { return `<span class="badge b-${role}">${esc(role)}</span>`; }
function qualityBadge(q) { return `<span class="badge b-${q}">${q === "pass" ? "Quality Y" : q === "fail" ? "Quality N" : "Unchecked"}</span>`; }
function statusBadge(s) { return `<span class="badge b-${s}">${esc(s.replace("_", " "))}</span>`; }

function isAdmin() { return currentProfile && currentProfile.role === "admin"; }
function isManagerUp() { return currentProfile && (currentProfile.role === "admin" || currentProfile.role === "manager"); }

// ---- 4. Auth --------------------------------------------------------------
function showApp() { $("login").classList.add("hidden"); $("app").classList.remove("hidden"); }
function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }

async function boot() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) { currentUser = null; currentProfile = null; showLogin(); return; }
  currentUser = user;
  const { data: profile, error } = await safeCall(db.from("profiles").select("*").eq("id", user.id).single());
  if (error || !profile) {
    toast("Could not load your profile: " + (error || "not found"), true);
    await db.auth.signOut();
    showLogin();
    return;
  }
  if (!profile.active) {
    toast("Your account has been deactivated. Contact an administrator.", true);
    await db.auth.signOut();
    showLogin();
    return;
  }
  currentProfile = profile;
  $("navUsers").classList.toggle("hidden", !isAdmin());
  $("userBadge").innerHTML = `${esc(profile.full_name || profile.email)} ${roleBadge(profile.role)}`;
  showApp();
  safeCall(db.rpc("log_login"));
  render();
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("loginMsg").textContent = "";
  const { error } = await safeCall(db.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value }));
  if (error) $("loginMsg").textContent = error; else boot();
};

$("showSignupBtn").onclick = () => {
  $("loginForm").classList.add("hidden"); $("forgotBtn").classList.add("hidden"); $("showSignupBtn").classList.add("hidden");
  $("signupForm").classList.remove("hidden"); $("loginMsg").textContent = "";
};
$("backToLoginBtn").onclick = () => {
  $("signupForm").classList.add("hidden"); $("signupMsg").textContent = "";
  $("loginForm").classList.remove("hidden"); $("forgotBtn").classList.remove("hidden"); $("showSignupBtn").classList.remove("hidden");
};
$("signupForm").onsubmit = async (e) => {
  e.preventDefault();
  $("signupMsg").textContent = "";
  const name = $("suName").value.trim(), email = $("suEmail").value.trim(), pw = $("suPassword").value;
  if (pw.length < 6) { $("signupMsg").textContent = "Password must be at least 6 characters."; return; }
  const { error } = await safeCall(db.auth.signUp({ email, password: pw, options: { data: { full_name: name } } }));
  if (error) { $("signupMsg").textContent = error; return; }
  $("signupMsg").style.color = "var(--green)";
  $("signupMsg").textContent = "Account created. Check your email if confirmation is required, then sign in.";
};

$("forgotBtn").onclick = () => {
  const prefill = $("email").value || "";
  modal(`<h2>Reset Password</h2><p>Enter your account email and we'll send a password reset link.</p>
    <div class="form-grid"><label class="full">Email<input id="resetEmail" type="email" value="${esc(prefill)}" required></label></div>
    <div id="resetMsg" class="msg"></div>
    <div class="actions"><button class="primary" onclick="sendReset()">Send Reset Link</button></div>`);
};
async function sendReset() {
  const email = $("resetEmail").value.trim();
  if (!email) return toast("Enter your email");
  const redirectTo = location.origin + location.pathname;
  const { error } = await safeCall(db.auth.resetPasswordForEmail(email, { redirectTo }));
  $("resetMsg").textContent = error || "Check your email for a reset link.";
}
function showUpdatePassword() {
  modal(`<h2>Set New Password</h2><p>Enter a new password for your account.</p>
    <div class="form-grid"><label class="full">New Password<input id="newPassword" type="password" required></label>
    <label class="full">Confirm Password<input id="confirmPassword" type="password" required></label></div>
    <div id="updateMsg" class="msg"></div>
    <div class="actions"><button class="primary" onclick="updatePassword()">Update Password</button></div>`);
}
async function updatePassword() {
  const p1 = $("newPassword").value, p2 = $("confirmPassword").value;
  if (!p1 || p1.length < 6) return $("updateMsg").textContent = "Password must be at least 6 characters.";
  if (p1 !== p2) return $("updateMsg").textContent = "Passwords do not match.";
  const { error } = await safeCall(db.auth.updateUser({ password: p1 }));
  if (error) return $("updateMsg").textContent = error;
  closeModal();
  toast("Password reset successfully.");
  history.replaceState(null, "", location.pathname);
  await db.auth.signOut();
  boot();
}

$("logout").onclick = async () => { await db.auth.signOut(); currentUser = null; currentProfile = null; showLogin(); };

db.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") setTimeout(showUpdatePassword, 0);
  else setTimeout(boot, 0);
});

// ---- 5. Navigation ----------------------------------------------------
const PAGE_TITLES = { dashboard: "Dashboard", inventory: "Inventory", batches: "Batches", sales: "Sales & Teams", reports: "Reports", users: "Users", settings: "Settings" };
function nav(p) {
  if (p === "users" && !isAdmin()) return;
  page = p;
  $("pageTitle").textContent = PAGE_TITLES[p] || p;
  document.querySelectorAll("[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === p));
  $("side").classList.remove("open");
  render();
}
document.querySelectorAll("[data-page]").forEach((b) => (b.onclick = () => nav(b.dataset.page)));
$("menu").onclick = () => $("side").classList.toggle("open");

async function render() {
  const c = $("content");
  c.innerHTML = '<div class="wrap"><div class="empty">Loading...</div></div>';
  try {
    if (page === "dashboard") return dashboardPage(c);
    if (page === "inventory") return inventoryPage(c);
    if (page === "batches") return batchesPage(c);
    if (page === "sales") return salesPage(c);
    if (page === "reports") return reportsPage(c);
    if (page === "users") return usersPage(c);
    if (page === "settings") return settingsPage(c);
  } catch (err) {
    console.error(err);
    c.innerHTML = errorPanel("Something went wrong loading this page.", "render");
  }
}

// ---- 6. Dashboard -------------------------------------------------------
async function dashboardPage(c) {
  const { data: stats, error } = await safeCall(db.rpc("get_dashboard_stats"));
  if (error) { c.innerHTML = errorPanel(error, "render"); return; }
  const { data: recent } = await safeCall(db.from("batches").select("*").order("created_at", { ascending: false }).limit(6), { fallback: [] });
  const passRate = stats.total ? Math.round((stats.quality_pass / stats.total) * 100) : 0;
  const card = (a, b) => `<div class="card"><small>${a}</small><strong>${b}</strong></div>`;
  c.innerHTML = `<div class="wrap">
    <div class="hero"><div><h1>Dashboard</h1><p>ALMSDOT TRADING LTD — Serial &amp; Batch Management</p></div>
      <div class="hero-actions">
        ${isManagerUp() ? `<button class="secondary" onclick="scanToFind()">&#9635; Scan</button><button class="primary" onclick="addBatchModal()">+ Add Batch</button>` : ""}
      </div>
    </div>
    <div class="cards">
      ${card("Total Serials", stats.total)}
      ${card("In Stock", stats.in_stock)}
      ${card("Sold", stats.sold)}
      ${card("Quality Y", stats.quality_pass)}
      ${card("Quality N", stats.quality_fail)}
      ${card("Unchecked", stats.quality_unchecked)}
      ${card("Quality Pass Rate", passRate + "%")}
      ${card("Total Sales Value", fmtMoney(stats.total_sales_value))}
    </div>
    <div class="panel"><h2>Sales by Team</h2>
      ${stats.sales_by_team.length ? `<div class="table-wrap"><table class="table"><tr><th>Team</th><th>Sales</th><th>Value</th></tr>
        ${stats.sales_by_team.map((t) => `<tr><td>${esc(t.team)}</td><td>${t.count}</td><td>${fmtMoney(t.value)}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">No sales recorded yet.</div>`}
    </div>
    <div class="panel"><h2>Recent Batches</h2>
      ${(recent || []).length ? `<div class="table-wrap"><table class="table"><tr><th>Code</th><th>Product</th><th>Received</th></tr>
        ${recent.map((b) => `<tr><td class="mono">${esc(b.code)}</td><td>${esc(b.product_name)}</td><td>${fmtDay(b.received_at)}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">No batches yet.</div>`}
    </div>
  </div>`;
}

// ---- 7. Inventory ---------------------------------------------------------
let invRows = [];
async function inventoryPage(c) {
  const [{ data: serials, error }, { data: batches }] = await Promise.all([
    safeCall(db.from("serials").select("*, batches(code, product_name)").order("created_at", { ascending: false }).limit(2000), { fallback: [] }),
    safeCall(db.from("batches").select("id, code").order("code"), { fallback: [] }),
  ]);
  if (error) { c.innerHTML = errorPanel(error, "render"); return; }
  invRows = serials || [];
  cache.batches = batches || [];
  c.innerHTML = `<div class="wrap">
    <div class="hero"><div><h1>Inventory</h1><p>Manage boxes, batches and individual serials.</p></div>
      <div class="hero-actions">
        <button class="secondary" onclick="scanToFind()">&#9635; Scan Serial</button>
        ${isManagerUp() ? `<button class="secondary" onclick="addSerialModal()">+ Add Serial</button><button class="secondary" onclick="bulkAddModal()">+ Bulk Add</button><button class="primary" onclick="addBatchModal()">+ Add Batch</button>` : ""}
      </div>
    </div>
    <div class="toolbar">
      <input id="search" placeholder="Search serial or batch code...">
      <select id="bf"><option value="">All Batches</option>${cache.batches.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join("")}</select>
      <select id="qf"><option value="">All Quality</option><option value="pass">Quality Y</option><option value="fail">Quality N</option><option value="unchecked">Unchecked</option></select>
      <select id="sf"><option value="">All Status</option><option value="in_stock">In Stock</option><option value="sold">Sold</option><option value="returned">Returned</option></select>
    </div>
    <div class="panel"><div id="invTable"></div></div>
  </div>`;
  filterInventory();
  $("search").oninput = filterInventory; $("bf").onchange = filterInventory; $("qf").onchange = filterInventory; $("sf").onchange = filterInventory;
}
function filterInventory() {
  const q = ($("search")?.value || "").toLowerCase(), bf = $("bf")?.value, qf = $("qf")?.value, sf = $("sf")?.value;
  const rows = invRows.filter((x) =>
    (!q || x.serial_no.toLowerCase().includes(q) || (x.batches?.code || "").toLowerCase().includes(q)) &&
    (!bf || x.batch_id === bf) && (!qf || x.quality === qf) && (!sf || x.status === sf));
  $("invTable").innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
    <tr><th>Serial</th><th>Batch</th><th>Product</th><th>Quality</th><th>Status</th><th></th></tr>
    ${rows.map((x) => `<tr>
      <td class="mono"><b>${esc(x.serial_no)}</b></td>
      <td class="mono">${esc(x.batches?.code || "")}</td>
      <td>${esc(x.batches?.product_name || "")}</td>
      <td>${qualityBadge(x.quality)}</td>
      <td>${statusBadge(x.status)}</td>
      <td>
        ${isManagerUp() ? `<button class="secondary" onclick="qualityModal('${x.id}','${x.quality}')">Quality</button>` : ""}
        ${x.status === "in_stock" && x.quality !== "fail" ? `<button class="secondary" onclick="sellModal('${x.id}')">Sell</button>` : ""}
      </td>
    </tr>`).join("")}
  </table></div>` : `<div class="empty">No serials found.</div>`;
}

function qualityModal(id, current) {
  modal(`<h2>Update Quality</h2>
    <div class="form-grid">
      <label class="full">Quality<select id="qv">
        <option value="unchecked" ${current === "unchecked" ? "selected" : ""}>Unchecked</option>
        <option value="pass" ${current === "pass" ? "selected" : ""}>Quality Y (Pass)</option>
        <option value="fail" ${current === "fail" ? "selected" : ""}>Quality N (Fail)</option>
      </select></label>
      <label class="full">Note<input id="qn" placeholder="Optional note"></label>
    </div>
    <div class="actions"><button class="primary" onclick="saveQuality('${id}')">Save</button></div>`);
}
async function saveQuality(id) {
  const { error } = await safeCall(db.rpc("set_quality", { p_serial_id: id, p_quality: $("qv").value, p_note: $("qn").value || null }));
  if (error) return toast(error, true);
  toast("Quality updated"); closeModal(); render();
}

function addSerialModal() {
  modal(`<h2>Add Serial</h2>
    <div class="form-grid">
      <label class="full">Serial Number<input id="snInput" placeholder="Scan or type serial"></label>
      <label class="full">Batch<select id="snBatch">${cache.batches.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join("")}</select></label>
      <label>Quality<select id="snQuality"><option value="unchecked">Unchecked</option><option value="pass">Quality Y</option><option value="fail">Quality N</option></select></label>
    </div>
    <div class="actions"><button class="secondary" onclick="scanIntoField('snInput')">&#9635; Scan</button><button class="primary" onclick="saveSerial()">Save Serial</button></div>`);
}
async function saveSerial() {
  const sn = $("snInput").value.trim();
  if (!sn) return toast("Enter a serial number");
  const { error } = await safeCall(db.rpc("add_serial", { p_serial_no: sn, p_batch_id: $("snBatch").value, p_quality: $("snQuality").value, p_entry_method: "manual" }));
  if (error) return toast(error, true);
  toast("Serial added"); closeModal(); render();
}

function bulkAddModal() {
  modal(`<h2>Bulk Serial Entry</h2><p>Paste multiple serial numbers, one per line.</p>
    <div class="form-grid">
      <label class="full">Batch<select id="bulkBatch">${cache.batches.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join("")}</select></label>
      <label class="full">Serial Numbers<textarea id="bulkSerials" rows="8" placeholder="123456789\n123456790"></textarea></label>
    </div>
    <div id="bulkResults" class="results-list hidden"></div>
    <div class="actions"><button class="primary" onclick="saveBulk()">Add Serials</button></div>`);
}
async function saveBulk() {
  const list = serialsFromText($("bulkSerials").value);
  if (!list.length) return toast("Paste at least one serial number");
  const { data, error } = await safeCall(db.rpc("bulk_add_serials", { p_serial_nos: list, p_batch_id: $("bulkBatch").value }));
  if (error) return toast(error, true);
  const box = $("bulkResults"); box.classList.remove("hidden");
  const ok = data.filter((r) => r.ok).length;
  box.innerHTML = data.map((r) => `<div><span class="mono">${esc(r.serial_no)}</span><span class="${r.ok ? "ok" : "bad"}">${esc(r.message)}</span></div>`).join("");
  toast(`${ok} of ${data.length} added`);
  render();
}

// ---- 8. Batches ----------------------------------------------------------
async function batchesPage(c) {
  const { data: batches, error } = await safeCall(db.from("batches").select("*").order("created_at", { ascending: false }), { fallback: [] });
  if (error) { c.innerHTML = errorPanel(error, "render"); return; }
  cache.batches = (batches || []).map((b) => ({ id: b.id, code: b.code }));
  c.innerHTML = `<div class="wrap">
    <div class="hero"><div><h1>Batches</h1><p>All received batches / boxes.</p></div>
      <div class="hero-actions"><input id="batchSearch" placeholder="Search batch code or product..." style="min-width:220px">
      ${isManagerUp() ? `<button class="primary" onclick="addBatchModal()">+ Add Batch</button>` : ""}</div>
    </div>
    <div class="panel"><div id="batchTable"></div></div>
  </div>`;
  const renderTable = () => {
    const q = ($("batchSearch")?.value || "").toLowerCase();
    const rows = (batches || []).filter((b) => !q || b.code.toLowerCase().includes(q) || b.product_name.toLowerCase().includes(q));
    $("batchTable").innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
      <tr><th>Code</th><th>Product</th><th>Supplier</th><th>Received</th><th>Notes</th><th></th></tr>
      ${rows.map((b) => `<tr><td class="mono"><b>${esc(b.code)}</b></td><td>${esc(b.product_name)}</td><td>${esc(b.supplier || "")}</td><td>${fmtDay(b.received_at)}</td><td>${esc(b.notes || "")}</td>
        <td>${isManagerUp() ? `<button class="secondary" onclick='editBatchModal(${JSON.stringify(b)})'>Edit</button>` : ""}</td></tr>`).join("")}
    </table></div>` : `<div class="empty">No batches found.</div>`;
  };
  renderTable();
  $("batchSearch").oninput = renderTable;
}
function addBatchModal() {
  modal(`<h2>Add Batch / Box</h2>
    <div class="form-grid">
      <label>Batch Code<input id="bCode"></label>
      <label>Received Date<input id="bDate" type="date" value="${todayStr()}"></label>
      <label class="full">Product Name<input id="bProduct"></label>
      <label class="full">Supplier<input id="bSupplier"></label>
      <label class="full">Notes<textarea id="bNotes" rows="3"></textarea></label>
    </div>
    <div class="actions"><button class="primary" onclick="saveBatch()">Save Batch</button></div>`);
}
async function saveBatch() {
  const code = $("bCode").value.trim(), product = $("bProduct").value.trim();
  if (!code || !product) return toast("Batch code and product name are required");
  const { error } = await safeCall(db.rpc("create_batch", { p_code: code, p_product_name: product, p_supplier: $("bSupplier").value || null, p_received_at: $("bDate").value, p_notes: $("bNotes").value || null }));
  if (error) return toast(error, true);
  toast("Batch saved"); closeModal(); render();
}
function editBatchModal(b) {
  modal(`<h2>Edit Batch ${esc(b.code)}</h2>
    <div class="form-grid">
      <label class="full">Product Name<input id="ebProduct" value="${esc(b.product_name)}"></label>
      <label class="full">Supplier<input id="ebSupplier" value="${esc(b.supplier || "")}"></label>
      <label class="full">Notes<textarea id="ebNotes" rows="3">${esc(b.notes || "")}</textarea></label>
    </div>
    <div class="actions"><button class="primary" onclick="saveEditBatch('${b.id}')">Save Changes</button></div>`);
}
async function saveEditBatch(id) {
  const { error } = await safeCall(db.rpc("update_batch", { p_id: id, p_product_name: $("ebProduct").value.trim(), p_supplier: $("ebSupplier").value || null, p_notes: $("ebNotes").value || null }));
  if (error) return toast(error, true);
  toast("Batch updated"); closeModal(); render();
}

// ---- 9. Sales & Teams ------------------------------------------------------
async function salesPage(c) {
  const [{ data: sales, error }, { data: teams }, { data: people }] = await Promise.all([
    safeCall(db.from("sales").select("*, teams(name), salespeople(full_name)").order("sold_at", { ascending: false }).limit(300), { fallback: [] }),
    safeCall(db.from("teams").select("*").order("name"), { fallback: [] }),
    safeCall(db.from("salespeople").select("*, teams(name)").order("full_name"), { fallback: [] }),
  ]);
  if (error) { c.innerHTML = errorPanel(error, "render"); return; }
  cache.teams = teams || []; cache.salespeople = people || [];
  c.innerHTML = `<div class="wrap">
    <div class="hero"><div><h1>Sales &amp; Teams</h1><p>Live sales, teams and salespeople.</p></div>
      <div class="hero-actions">
        <button class="secondary" onclick="scanToFind()">&#9635; Scan &amp; Sell</button>
        ${isManagerUp() ? `<button class="secondary" onclick="addTeamModal()">+ Team</button><button class="secondary" onclick="addSalespersonModal()">+ Salesperson</button>` : ""}
      </div>
    </div>
    <div class="panel"><h2>Recent Sales</h2>
      ${sales.length ? `<div class="table-wrap"><table class="table"><tr><th>Date</th><th>Serial</th><th>Salesperson</th><th>Team</th><th>Customer</th><th>Price</th></tr>
        ${sales.map((s) => `<tr><td>${fmtDay(s.sold_at)}</td><td class="mono">${esc(s.serial_no)}</td><td>${esc(s.salespeople?.full_name || "")}</td><td>${esc(s.teams?.name || "")}</td><td>${esc(s.customer_name || "")}</td><td>${fmtMoney(s.price)}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">No sales recorded yet.</div>`}
    </div>
    <div class="panel"><h2>Teams</h2>
      ${cache.teams.length ? `<div class="table-wrap"><table class="table"><tr><th>Name</th><th>Region</th><th></th></tr>
        ${cache.teams.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.region || "")}</td><td>${isManagerUp() ? `<button class="secondary" onclick='editTeamModal(${JSON.stringify(t)})'>Edit</button>` : ""}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">No teams yet.</div>`}
    </div>
    <div class="panel"><h2>Salespeople</h2>
      ${cache.salespeople.length ? `<div class="table-wrap"><table class="table"><tr><th>Name</th><th>Phone</th><th>Team</th><th>Status</th><th></th></tr>
        ${cache.salespeople.map((p) => `<tr><td>${esc(p.full_name)}</td><td>${esc(p.phone || "")}</td><td>${esc(p.teams?.name || "")}</td><td>${p.active ? '<span class="badge b-pass">Active</span>' : '<span class="badge b-fail">Inactive</span>'}</td>
          <td>${isManagerUp() ? `<button class="secondary" onclick='editSalespersonModal(${JSON.stringify(p)})'>Edit</button>` : ""}</td></tr>`).join("")}
      </table></div>` : `<div class="empty">No salespeople yet.</div>`}
    </div>
  </div>`;
}

function addTeamModal() {
  modal(`<h2>Add Team</h2><div class="form-grid"><label class="full">Team Name<input id="tName"></label><label class="full">Region<input id="tRegion"></label></div>
    <div class="actions"><button class="primary" onclick="saveTeam()">Save Team</button></div>`);
}
async function saveTeam() {
  const name = $("tName").value.trim();
  if (!name) return toast("Team name is required");
  const { error } = await safeCall(db.rpc("create_team", { p_name: name, p_region: $("tRegion").value || null }));
  if (error) return toast(error, true);
  toast("Team created"); closeModal(); render();
}
function editTeamModal(t) {
  modal(`<h2>Edit Team</h2><div class="form-grid"><label class="full">Team Name<input id="etName" value="${esc(t.name)}"></label><label class="full">Region<input id="etRegion" value="${esc(t.region || "")}"></label></div>
    <div class="actions"><button class="primary" onclick="saveEditTeam('${t.id}')">Save Changes</button></div>`);
}
async function saveEditTeam(id) {
  const { error } = await safeCall(db.rpc("update_team", { p_id: id, p_name: $("etName").value.trim(), p_region: $("etRegion").value || null }));
  if (error) return toast(error, true);
  toast("Team updated"); closeModal(); render();
}
function addSalespersonModal() {
  modal(`<h2>Add Salesperson</h2><div class="form-grid">
    <label class="full">Full Name<input id="spName"></label>
    <label>Phone<input id="spPhone"></label>
    <label>Team<select id="spTeam">${cache.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
    </div><div class="actions"><button class="primary" onclick="saveSalesperson()">Save Salesperson</button></div>`);
}
async function saveSalesperson() {
  const name = $("spName").value.trim();
  if (!name) return toast("Full name is required");
  const { error } = await safeCall(db.rpc("create_salesperson", { p_full_name: name, p_phone: $("spPhone").value || null, p_team_id: $("spTeam").value || null }));
  if (error) return toast(error, true);
  toast("Salesperson added"); closeModal(); render();
}
function editSalespersonModal(p) {
  modal(`<h2>Edit Salesperson</h2><div class="form-grid">
    <label class="full">Full Name<input id="espName" value="${esc(p.full_name)}"></label>
    <label>Phone<input id="espPhone" value="${esc(p.phone || "")}"></label>
    <label>Team<select id="espTeam">${cache.teams.map((t) => `<option value="${t.id}" ${t.id === p.team_id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
    <label>Status<select id="espActive"><option value="true" ${p.active ? "selected" : ""}>Active</option><option value="false" ${!p.active ? "selected" : ""}>Inactive</option></select></label>
    </div><div class="actions"><button class="primary" onclick="saveEditSalesperson('${p.id}')">Save Changes</button></div>`);
}
async function saveEditSalesperson(id) {
  const { error } = await safeCall(db.rpc("update_salesperson", { p_id: id, p_full_name: $("espName").value.trim(), p_phone: $("espPhone").value || null, p_team_id: $("espTeam").value || null, p_active: $("espActive").value === "true" }));
  if (error) return toast(error, true);
  toast("Salesperson updated"); closeModal(); render();
}

async function sellModal(serialId) {
  const [{ data: s }, { data: t }, { data: p }] = await Promise.all([
    safeCall(db.from("serials").select("*, batches(code)").eq("id", serialId).single()),
    safeCall(db.from("teams").select("*").order("name"), { fallback: [] }),
    safeCall(db.from("salespeople").select("*").eq("active", true).order("full_name"), { fallback: [] }),
  ]);
  if (!s.data) return toast("Serial not found", true);
  if (s.data.quality === "fail") return toast("This serial failed quality and cannot be sold", true);
  if (s.data.status === "sold") return toast("This serial has already been sold", true);
  modal(`<h2>Record Sale</h2><p class="mono"><b>${esc(s.data.serial_no)}</b> — Batch ${esc(s.data.batches?.code || "")}</p>
    <div class="form-grid">
      <label>Salesperson<select id="saleSp">${(p.data || []).map((x) => `<option value="${x.id}">${esc(x.full_name)}</option>`).join("")}</select></label>
      <label>Team<select id="saleTeam">${(t.data || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
      <label>Selling Price (KES)<input id="salePrice" type="number" min="0" step="0.01"></label>
      <label>Sale Date<input id="saleDate" type="date" value="${todayStr()}"></label>
      <label class="full">Customer Name<input id="saleCustomer"></label>
    </div>
    <div class="actions"><button class="primary" onclick="confirmSale('${serialId}')">Confirm Sale</button></div>`);
}
async function confirmSale(serialId) {
  const { error } = await safeCall(db.rpc("record_sale", {
    p_serial_id: serialId, p_salesperson_id: $("saleSp").value, p_team_id: $("saleTeam").value,
    p_customer_name: $("saleCustomer").value || null, p_price: parseFloat($("salePrice").value || "0"),
  }));
  if (error) return toast(error, true);
  toast("Sale recorded"); closeModal(); render();
}

// ---- 10. Barcode scanner (native BarcodeDetector, manual fallback always available) ----
function scannerModal(onScan) {
  modal(`<h2>Scan Barcode</h2>
    <div class="scan-frame"><video id="scanVideo" class="scan-video" playsinline muted></video><div class="scan-guide"></div></div>
    <p id="scanMsg" class="msg" style="color:var(--muted)">Point the camera at a barcode. Not able to scan? Type the serial below.</p>
    <div class="form-grid"><label class="full">Serial Number<input id="scanManual" placeholder="Type serial number" autofocus></label></div>
    <div class="actions"><button class="primary" onclick="scanSubmitManual()">Use This Serial</button></div>`);
  startScanner(onScan);
}
let scanState = { stream: null, timer: null, onScan: null, cancelled: false };
async function startScanner(onScan) {
  scanState.cancelled = false; scanState.onScan = onScan;
  if (!navigator.mediaDevices?.getUserMedia) { $("scanMsg").textContent = "Camera not supported on this device. Type the serial number instead."; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    if (scanState.cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
    scanState.stream = stream;
    const video = $("scanVideo");
    if (!video) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = stream; await video.play();
    const Detector = window.BarcodeDetector;
    if (!Detector) { $("scanMsg").textContent = "This browser can't read barcodes automatically. Type the serial number instead."; return; }
    const detector = new Detector();
    const tick = async () => {
      if (scanState.cancelled || !$("scanVideo")) return;
      try {
        const codes = await detector.detect($("scanVideo"));
        const value = codes[0]?.rawValue?.trim();
        if (value) { stopScanner(); onScan(value); closeModal(); return; }
      } catch (e) { /* keep scanning */ }
      scanState.timer = setTimeout(tick, 350);
    };
    tick();
  } catch (e) {
    $("scanMsg").textContent = "Camera access was blocked or unavailable. Type the serial number instead.";
  }
}
function stopScanner() {
  scanState.cancelled = true;
  clearTimeout(scanState.timer);
  scanState.stream?.getTracks().forEach((t) => t.stop());
  scanState.stream = null;
}
function scanSubmitManual() {
  const v = $("scanManual").value.trim();
  if (!v) return toast("Type or scan a serial number");
  const cb = scanState.onScan; stopScanner(); closeModal(); if (cb) cb(v);
}
// Close modal handler also stops the camera stream.
const _origCloseModal = closeModal;
closeModal = function () { stopScanner(); _origCloseModal(); };

function scanIntoField(fieldId) { scannerModal((v) => { const el = $(fieldId); if (el) el.value = v; }); }
async function scanToFind() {
  scannerModal(async (v) => {
    const { data } = await safeCall(db.from("serials").select("id,status,quality").eq("serial_no", v).maybeSingle());
    if (!data) return toast("Serial not found");
    if (data.quality === "fail") return toast("This serial failed quality and cannot be sold", true);
    if (data.status === "in_stock") sellModal(data.id);
    else toast("Serial is " + data.status.replace("_", " "));
  });
}

// ---- 11. Reports -----------------------------------------------------------
function dateRangeFields(fromId, toId) {
  return `<label>From<input id="${fromId}" type="date"></label><label>To<input id="${toId}" type="date"></label>`;
}
function reportsPage(c) {
  c.innerHTML = `<div class="wrap"><div class="hero"><div><h1>Reports</h1><p>Choose a report to view and export.</p></div></div>
    <div class="links">
      <div class="link" onclick="reportPage('team')">&#9701;<br><b>Sales By Teams</b></div>
      <div class="link" onclick="reportPage('person')">&#9823;<br><b>Sale by Salesperson</b></div>
      <div class="link" onclick="reportPage('pass')">&#10003;<br><b>Quality Serials (Y)</b></div>
      <div class="link" onclick="reportPage('fail')">N<br><b>Non-Quality Serials (N)</b></div>
      <div class="link" onclick="reportPage('unchecked')">?<br><b>Unchecked Serials</b></div>
      <div class="link" onclick="reportPage('inventory')">&#9635;<br><b>Inventory Report</b></div>
      <div class="link" onclick="reportPage('batch')">&#128230;<br><b>Batch Report</b></div>
      <div class="link" onclick="reportPage('sales')">&#128176;<br><b>Sales Report</b></div>
      ${isAdmin() ? `<div class="link" onclick="reportPage('audit')">&#128269;<br><b>Audit History</b></div>` : ""}
    </div>
    <div id="reportBody"></div>
  </div>`;
}
async function reportPage(kind) {
  const body = $("reportBody");
  body.innerHTML = `<div class="panel"><div class="toolbar">${dateRangeFields("rFrom", "rTo")}<button class="secondary" onclick="runReport('${kind}')">Apply</button></div><div id="reportTable"><div class="empty">Choose a date range and press Apply, or Apply with no dates for everything.</div></div></div>`;
}
async function runReport(kind) {
  const from = $("rFrom").value, to = $("rTo").value;
  const table = $("reportTable");
  table.innerHTML = '<div class="empty">Loading...</div>';
  const dateCol = kind === "audit" ? "created_at" : kind === "team" || kind === "person" || kind === "sales" ? "sold_at" : "created_at";

  let query, title, rows = [], csvName = `almsdot_${kind}_report.csv`, csvHeaders = null;

  if (kind === "team" || kind === "person" || kind === "sales") {
    query = db.from("sales").select("*, teams(name), salespeople(full_name)").order("sold_at", { ascending: false });
  } else if (kind === "pass" || kind === "fail" || kind === "unchecked") {
    query = db.from("serials").select("serial_no, quality, status, created_at, batches(code, product_name)").eq("quality", kind).order("created_at", { ascending: false });
  } else if (kind === "inventory") {
    query = db.from("serials").select("serial_no, quality, status, created_at, batches(code, product_name)").order("created_at", { ascending: false });
  } else if (kind === "batch") {
    query = db.from("batches").select("*").order("created_at", { ascending: false });
  } else if (kind === "audit") {
    query = db.from("audit_entries").select("*").order("created_at", { ascending: false }).limit(2000);
  }
  if (from) query = query.gte(dateCol, from);
  if (to) query = query.lte(dateCol, to + "T23:59:59");

  const { data, error } = await safeCall(query, { fallback: [] });
  if (error) { table.innerHTML = errorPanel(error, `() => runReport('${kind}')`); return; }
  rows = data || [];

  if (kind === "team") {
    const m = {}; rows.forEach((x) => { const k = x.teams?.name || "Unassigned"; m[k] = m[k] || { count: 0, value: 0 }; m[k].count++; m[k].value += Number(x.price || 0); });
    title = "Sales By Teams";
    table.innerHTML = tableHtml(["Team", "Sales", "Value"], Object.entries(m).map(([k, v]) => [k, v.count, fmtMoney(v.value)]));
    return exportBtn(table, Object.entries(m).map(([k, v]) => ({ team: k, sales: v.count, value: v.value })), csvName);
  }
  if (kind === "person") {
    const m = {}; rows.forEach((x) => { const k = x.salespeople?.full_name || "Unassigned"; m[k] = m[k] || { count: 0, value: 0 }; m[k].count++; m[k].value += Number(x.price || 0); });
    table.innerHTML = tableHtml(["Salesperson", "Sales", "Value"], Object.entries(m).map(([k, v]) => [k, v.count, fmtMoney(v.value)]));
    return exportBtn(table, Object.entries(m).map(([k, v]) => ({ salesperson: k, sales: v.count, value: v.value })), csvName);
  }
  if (kind === "sales") {
    table.innerHTML = tableHtml(["Date", "Serial", "Salesperson", "Team", "Customer", "Price"], rows.map((x) => [fmtDay(x.sold_at), x.serial_no, x.salespeople?.full_name || "", x.teams?.name || "", x.customer_name || "", fmtMoney(x.price)]));
    return exportBtn(table, rows.map((x) => ({ date: fmtDay(x.sold_at), serial: x.serial_no, salesperson: x.salespeople?.full_name || "", team: x.teams?.name || "", customer: x.customer_name || "", price: x.price })), csvName);
  }
  if (kind === "pass" || kind === "fail" || kind === "unchecked" || kind === "inventory") {
    table.innerHTML = tableHtml(["Serial", "Batch", "Product", "Quality", "Status", "Added"], rows.map((x) => [x.serial_no, x.batches?.code || "", x.batches?.product_name || "", x.quality, x.status, fmtDay(x.created_at)]));
    return exportBtn(table, rows.map((x) => ({ serial: x.serial_no, batch: x.batches?.code || "", product: x.batches?.product_name || "", quality: x.quality, status: x.status, added: fmtDay(x.created_at) })), csvName);
  }
  if (kind === "batch") {
    table.innerHTML = tableHtml(["Code", "Product", "Supplier", "Received", "Notes"], rows.map((x) => [x.code, x.product_name, x.supplier || "", fmtDay(x.received_at), x.notes || ""]));
    return exportBtn(table, rows, csvName);
  }
  if (kind === "audit") {
    table.innerHTML = tableHtml(["Date", "Actor", "Action", "Entity", "Detail"], rows.map((x) => [fmtDate(x.created_at), x.actor_email || "", x.action, x.entity, x.detail || ""]));
    return exportBtn(table, rows.map((x) => ({ date: fmtDate(x.created_at), actor: x.actor_email, action: x.action, entity: x.entity, entity_id: x.entity_id, detail: x.detail })), csvName);
  }
}
function tableHtml(headers, rows) {
  if (!rows.length) return `<div class="empty">No records for this range.</div>`;
  return `<div class="table-wrap"><table class="table"><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
}
function exportBtn(table, rows, filename) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="actions"><button class="secondary" id="exportCsvBtn">Export CSV</button></div>`;
  table.appendChild(wrap);
  $("exportCsvBtn").onclick = () => downloadCsv(filename, rows);
}

// ---- 12. Users (admin only) -------------------------------------------------
async function usersPage(c) {
  if (!isAdmin()) { c.innerHTML = `<div class="wrap"><div class="empty">Admins only.</div></div>`; return; }
  const { data: users, error } = await safeCall(db.from("profiles").select("*").order("created_at", { ascending: false }), { fallback: [] });
  if (error) { c.innerHTML = errorPanel(error, "render"); return; }
  c.innerHTML = `<div class="wrap"><div class="hero"><div><h1>Users</h1><p>Manage roles and access. New accounts sign up from the login screen.</p></div></div>
    <div class="panel"><div class="table-wrap"><table class="table"><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>
      ${users.map((u) => `<tr>
        <td>${esc(u.full_name || "")}</td><td>${esc(u.email)}</td>
        <td><select onchange="changeRole('${u.id}', this.value)" ${u.id === currentUser.id ? "disabled" : ""}>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
          <option value="manager" ${u.role === "manager" ? "selected" : ""}>Manager</option>
          <option value="salesperson" ${u.role === "salesperson" ? "selected" : ""}>Salesperson</option>
        </select></td>
        <td>${u.active ? '<span class="badge b-pass">Active</span>' : '<span class="badge b-fail">Inactive</span>'}</td>
        <td>${u.id === currentUser.id ? "" : `<button class="secondary" onclick="toggleActive('${u.id}', ${!u.active})">${u.active ? "Deactivate" : "Activate"}</button>`}</td>
      </tr>`).join("")}
    </table></div></div></div>`;
}
async function changeRole(id, role) {
  const { error } = await safeCall(db.rpc("update_user_role", { p_user_id: id, p_role: role }));
  if (error) return toast(error, true);
  toast("Role updated"); render();
}
async function toggleActive(id, active) {
  const { error } = await safeCall(db.rpc("update_user_active", { p_user_id: id, p_active: active }));
  if (error) return toast(error, true);
  toast(active ? "User activated" : "User deactivated"); render();
}

// ---- 13. Settings ------------------------------------------------------------
function settingsPage(c) {
  c.innerHTML = `<div class="wrap"><div class="hero"><div><h1>Settings</h1><p>Your account.</p></div></div>
    <div class="panel"><h2>Profile</h2>
      <p><b>Name:</b> ${esc(currentProfile.full_name || "")}</p>
      <p><b>Email:</b> ${esc(currentProfile.email)}</p>
      <p><b>Role:</b> ${roleBadge(currentProfile.role)}</p>
    </div>
    <div class="panel"><h2>Change Password</h2>
      <div class="form-grid">
        <label class="full">New Password<input id="setP1" type="password"></label>
        <label class="full">Confirm Password<input id="setP2" type="password"></label>
      </div>
      <div id="setMsg" class="msg"></div>
      <div class="actions"><button class="primary" onclick="changeOwnPassword()">Update Password</button></div>
    </div>
  </div>`;
}
async function changeOwnPassword() {
  const p1 = $("setP1").value, p2 = $("setP2").value;
  if (!p1 || p1.length < 6) return $("setMsg").textContent = "Password must be at least 6 characters.";
  if (p1 !== p2) return $("setMsg").textContent = "Passwords do not match.";
  const { error } = await safeCall(db.auth.updateUser({ password: p1 }));
  if (error) return $("setMsg").textContent = error;
  $("setMsg").style.color = "var(--green)"; $("setMsg").textContent = "Password updated.";
  $("setP1").value = ""; $("setP2").value = "";
}

// ---- 14. Boot ----------------------------------------------------------------
boot();
