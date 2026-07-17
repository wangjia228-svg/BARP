/* BARP — Bobot Attachment & Run Progress. vanilla JS, IndexedDB-backed, offline-first PWA. */

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- IndexedDB helper ----------
const DB_NAME = "barp-db-v1";
const DB_VERSION = 5;
let dbPromise = null;

function createStores(db) {
  if (!db.objectStoreNames.contains("attachments")) {
    db.createObjectStore("attachments", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("entries")) {
    const s = db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
    s.createIndex("byAttachment", "attachmentId");
  }
  if (!db.objectStoreNames.contains("missions")) {
    db.createObjectStore("missions", { keyPath: "id", autoIncrement: true });
  }
  // "runGroups" = the "Run" concept in FLL terms: one leave-and-return trip,
  // containing several missions. Not to be confused with the "runs" store
  // below, which is a whole ~2:30 Game Run (the thing with the scoreboard).
  if (!db.objectStoreNames.contains("runGroups")) {
    db.createObjectStore("runGroups", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("runs")) {
    db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("meta")) {
    db.createObjectStore("meta", { keyPath: "key" });
  }
  // Practice Sessions was removed as a feature — drop the leftover store if present.
  if (db.objectStoreNames.contains("sessions")) {
    db.deleteObjectStore("sessions");
  }
  // The automatic pre-change snapshot system was replaced with per-delete
  // undo toasts — drop the leftover store if present.
  if (db.objectStoreNames.contains("deletionSnapshots")) {
    db.deleteObjectStore("deletionSnapshots");
  }
}

// allowRecovery=true means: if this specific database name/version conflicts
// with something already on the device, wipe just that stray database and
// recreate it fresh — there's nothing to lose from a database that has never
// successfully opened in the first place.
function tryOpenDB(allowRecovery) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      const err = req.error;
      if (allowRecovery && err && err.name === "VersionError") {
        const delReq = indexedDB.deleteDatabase(DB_NAME);
        delReq.onsuccess = () => { tryOpenDB(false).then(resolve, reject); };
        delReq.onerror = () => reject(err);
        delReq.onblocked = () => {
          reject(new Error("Another open tab/window with this app is blocking a required database reset — close it, then reload this page."));
        };
      } else {
        reject(err);
      }
    };
  });
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = tryOpenDB(true).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}
function tx(storeNames, mode) { return openDB().then((db) => db.transaction(storeNames, mode)); }
function reqToPromise(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function dbGetAll(store) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).getAll()); }
async function dbGet(store, key) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).get(key)); }
async function dbPut(store, value) { const t = await tx([store], "readwrite"); return reqToPromise(t.objectStore(store).put(value)); }
async function dbDelete(store, key) { const t = await tx([store], "readwrite"); return reqToPromise(t.objectStore(store).delete(key)); }
async function dbGetByIndex(store, indexName, value) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).index(indexName).getAll(value)); }
async function dbClear(store) { const t = await tx([store], "readwrite"); return reqToPromise(t.objectStore(store).clear()); }

// Raw reads used when building a snapshot — same as dbGetAll, kept as a
// separate name for clarity at call sites that are specifically building a
// backup rather than refreshing on-screen state.
async function dbGetAllRaw(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction([store], "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function restoreFullData(data) {
  await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta"); await dbClear("runGroups");
  for (const a of data.attachments || []) await dbPut("attachments", a);
  for (const en of data.entries || []) await dbPut("entries", en);
  for (const m of data.missions || []) await dbPut("missions", m);
  for (const r of data.runs || []) await dbPut("runs", r);
  for (const meta of data.meta || []) await dbPut("meta", meta);
  for (const g of data.runGroups || []) await dbPut("runGroups", g);
  await initAll();
}
async function snapshotCurrentData() {
  return {
    attachments: await dbGetAllRaw("attachments"),
    entries: await dbGetAllRaw("entries"),
    missions: await dbGetAllRaw("missions"),
    runs: await dbGetAllRaw("runs"),
    meta: await dbGetAllRaw("meta"),
    runGroups: await dbGetAllRaw("runGroups"),
  };
}
// Full-state snapshots taken the moment Attachments/Runs editing starts, so
// Cancel can revert every change made during the session (adds, edits,
// deletes, reorders) — not just the drag order, which is all the Save/Cancel
// buttons used to govern.
let attachmentEditSessionSnapshot = null;
let runsEditSessionSnapshot = null;

// ---------- App state ----------
const state = {
  attachments: [],
  selectedAttachmentIds: new Set(),
  filterInitialized: false,
  entries: [],
  missions: [],
  runGroups: [], // "Run" = one leave-and-return trip, grouping several missions
  runs: [],
  expandedMissions: new Set(),
  expandedRunGroups: new Set(),
  editingAttachmentOrder: false,
  editingAllOrder: false,
  skipEquipmentInspectionAsk: true,
  keepGoingAfterBuzzer: false,
  interactiveScoringEnabled: true,
  interactiveIterationsEnabled: false,
  guidedRun: null, // { run, legIdx, missionIdxInLeg, taskIdx, matchStartTs, ... }
};

// ---------- Visible error reporting ----------
// If a click handler throws, buttons can look "dead" (the CSS :active press
// still fires since that's pure CSS, but nothing else happens). This surfaces
// the real error on screen instead of it vanishing into the console.
function showErrorBanner(message) {
  let banner = document.getElementById("error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "error-banner";
    banner.addEventListener("click", () => { banner.hidden = true; });
    document.body.appendChild(banner);
  }
  banner.onclick = () => { banner.hidden = true; };
  banner.textContent = "Something went wrong: " + message + " — tap to dismiss";
  banner.hidden = false;
}
async function resetLocalDatabase() {
  try {
    const db = await openDB();
    db.close();
  } catch (e) { /* nothing open yet — fine */ }
  dbPromise = null;
  const req = indexedDB.deleteDatabase(DB_NAME);
  req.onsuccess = () => location.reload();
  req.onerror = () => location.reload();
  req.onblocked = () => showErrorBanner("Close any other open tabs/windows with this app, then try again.");
}
window.addEventListener("error", (e) => showErrorBanner(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => showErrorBanner(e.reason?.message || String(e.reason)));

// ---------- Drag-to-reorder (touch-friendly, works with mouse too) ----------
// ---------- Drag-to-reorder (SortableJS-backed) ----------
// Thin wrapper around the SortableJS library (loaded via CDN in index.html).
// `group` lets several containers share a name so items can be dragged
// between them (used for missions moving between runs / Unassigned) —
// leave it unset for a container whose items should only reorder in place
// (attachments, run groups, tasks within one mission).
const sortableInstances = new WeakMap(); // container element -> its current Sortable instance
function makeSortable(container, { group, onEnd } = {}) {
  const existing = sortableInstances.get(container);
  if (existing) { existing.destroy(); sortableInstances.delete(container); }
  const instance = Sortable.create(container, {
    handle: ".drag-handle",
    animation: 150,
    group,
    fallbackOnBody: true, // recommended by SortableJS for nested sortable lists
    swapThreshold: 0.65,
    onEnd,
  });
  sortableInstances.set(container, instance);
  return instance;
}
function reorderToolbarHTML(editing, prefix) {
  return editing
    ? `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-save-order-${prefix}">Save order</button><button type="button" class="btn-small-link" id="btn-cancel-order-${prefix}">Cancel</button></div>`
    : `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-edit-order-${prefix}">&#8645; Reorder</button></div>`;
}

// ---------- Modal helpers ----------
const modalBackdrop = document.getElementById("modal-backdrop");
const modalBox = document.getElementById("modal-box");
function openModal(html) { modalBox.innerHTML = html; modalBackdrop.hidden = false; }
function closeModal() { modalBackdrop.hidden = true; modalBox.innerHTML = ""; }
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop && !state.guidedRun) closeModal();
});

let undoToastTimer = null;
function showUndoToast(message, onUndo) {
  let toast = document.getElementById("undo-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "undo-toast";
    toast.className = "undo-toast";
    document.body.appendChild(toast);
  }
  clearTimeout(undoToastTimer);
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" id="undo-toast-btn">Undo</button><button type="button" class="toast-close-btn" id="undo-toast-close" title="Dismiss">&#10005;</button>`;
  toast.hidden = false;
  document.getElementById("undo-toast-btn").addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(undoToastTimer);
    onUndo();
  });
  document.getElementById("undo-toast-close").addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(undoToastTimer);
  });
  undoToastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}
function showSimpleToast(message) {
  let toast = document.getElementById("simple-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "simple-toast";
    toast.className = "undo-toast";
    document.body.appendChild(toast);
  }
  clearTimeout(toast._timer);
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" class="toast-close-btn" id="simple-toast-close" title="Dismiss">&#10005;</button>`;
  toast.hidden = false;
  document.getElementById("simple-toast-close").addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(toast._timer);
  });
  toast._timer = setTimeout(() => { toast.hidden = true; }, 3000);
}

// ---------- Tab navigation ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.editingAttachmentOrder || state.editingAllOrder) {
      showSimpleToast("Save or cancel your changes first");
      return;
    }
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    btn.classList.add("active");
    document.getElementById(btn.dataset.view).hidden = false;
    if (btn.dataset.view === "view-analysis") renderAnalysisTab();
  });
});

// ---------- Utility ----------
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Task scoring math ----------
function taskMaxPoints(t) {
  if (t.type === "bool") return t.points || 0;
  if (t.type === "number") return (t.max || 0) * (t.pointsPerUnit || 1);
  if (t.type === "choice") return (t.options || []).reduce((mx, o) => Math.max(mx, o.points || 0), 0);
  return 0;
}
function pointsFromRawTask(t, raw) {
  if (t.type === "bool") return raw ? (t.points || 0) : 0;
  if (t.type === "number") return (Number(raw) || 0) * (t.pointsPerUnit || 1);
  if (t.type === "choice") {
    if (raw === null || raw === undefined || raw === "") return 0;
    const opt = (t.options || [])[raw];
    return opt ? (opt.points || 0) : 0;
  }
  return 0;
}
function missionMaxPoints(m) { return visibleTasks(m).reduce((sum, t) => sum + taskMaxPoints(t), 0); }
function missionScoreForRun(m, run) {
  return visibleTasks(m).reduce((sum, t) => sum + pointsFromRawTask(t, (run.rawScores || {})[t.id]), 0);
}
// Bonus points awarded for unused precision tokens at the end of a run —
// every run starts with 6, and how many are left over scores extra.
const PRECISION_TOKEN_BONUS = { 0: 0, 1: 10, 2: 15, 3: 25, 4: 35, 5: 50, 6: 50 };
function precisionTokenBonus(remaining) { return PRECISION_TOKEN_BONUS[remaining] ?? 0; }
// Reverse of the above, for importing scoresheets — bonus point values aren't
// unique (5 and 6 tokens both score 50), so ties resolve to the higher count.
function tokensFromPrecisionBonus(bonusValue) {
  const matches = Object.entries(PRECISION_TOKEN_BONUS).filter(([, v]) => v === bonusValue).map(([k]) => Number(k));
  return matches.length ? Math.max(...matches) : 0;
}
const PRECISION_TOKENS_START = 6;

// Bonus points for passing the equipment inspection (attachments fit within
// the inspection area) — asked once at the start of the run, before the
// countdown.
const EQUIPMENT_INSPECTION_BONUS = 20;

function runMaxPoints(missions) { return missions.reduce((sum, m) => sum + missionMaxPoints(m), 0) + 50 + EQUIPMENT_INSPECTION_BONUS; }
function runTotal(run, missions) {
  return missions.reduce((sum, m) => sum + missionScoreForRun(m, run), 0)
    + precisionTokenBonus(run.precisionTokensRemaining ?? 0)
    + (run.equipmentInspectionPassed ? EQUIPMENT_INSPECTION_BONUS : 0);
}

// ==========================================================
// ATTACHMENTS + LOG
// ==========================================================
async function loadAttachments() {
  state.attachments = (await dbGetAll("attachments")).filter((a) => !a.deleted).sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0));
  if (!state.filterInitialized) {
    state.selectedAttachmentIds = new Set(state.attachments.map((a) => a.id));
    state.filterInitialized = true;
  } else {
    state.selectedAttachmentIds = new Set([...state.selectedAttachmentIds].filter((id) => state.attachments.some((a) => a.id === id)));
  }
  renderAttachmentChips();
  renderAttachmentsSetup();
  await renderIterationTotal();
  await renderEntryList();
}
async function renumberAttachments() {
  const remaining = (await dbGetAll("attachments")).filter((a) => !a.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const [i, a] of remaining.entries()) { a.order = i; a.number = i + 1; await dbPut("attachments", a); }
}
async function restoreDeletedAttachment(id) {
  const att = await dbGet("attachments", id);
  if (!att) return;
  delete att.deleted;
  delete att.deletedAt;
  await dbPut("attachments", att);
  const entries = await dbGetByIndex("entries", "byAttachment", id);
  for (const en of entries) {
    if (en.deletedWithAttachmentId === id) {
      delete en.deleted;
      delete en.deletedAt;
      delete en.deletedWithAttachmentId;
      await dbPut("entries", en);
    }
  }
  await renumberAttachments();
  await loadAttachments();
  syncToTeamDrive();
}

async function iterationCount(attachmentId) {
  const entries = await dbGetByIndex("entries", "byAttachment", attachmentId);
  return entries.filter((e) => !e.deleted).length;
}

async function renderIterationTotal() {
  const all = (await dbGetAll("entries")).filter((e) => !e.deleted);
  const line = document.getElementById("iteration-total-line");
  line.textContent = all.length ? `${all.length} total engineering iteration${all.length === 1 ? "" : "s"} logged` : "";
}

function renderAttachmentChips() {
  const wrap = document.getElementById("attachment-chips");
  wrap.innerHTML = "";
  document.getElementById("log-empty-state").hidden = state.attachments.length > 0;
  document.querySelector(".filter-row").hidden = state.attachments.length === 0;
  if (!state.attachments.length) { document.getElementById("entry-list").innerHTML = ""; document.getElementById("log-select-prompt").hidden = true; return; }

  const allBtn = document.createElement("button");
  const allSelected = state.selectedAttachmentIds.size === state.attachments.length;
  allBtn.className = "chip chip-all" + (allSelected ? " active" : "");
  allBtn.textContent = "All";
  allBtn.addEventListener("click", async () => {
    state.selectedAttachmentIds = allSelected ? new Set() : new Set(state.attachments.map((a) => a.id));
    renderAttachmentChips();
    await renderEntryList();
  });
  wrap.appendChild(allBtn);

  state.attachments.forEach((att) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.selectedAttachmentIds.has(att.id) ? " active" : "");
    chip.innerHTML = `<span class="chip-num">#${esc(att.number)}</span>${esc(att.name)}`;
    chip.addEventListener("click", async () => {
      if (state.selectedAttachmentIds.has(att.id)) state.selectedAttachmentIds.delete(att.id);
      else state.selectedAttachmentIds.add(att.id);
      renderAttachmentChips();
      await renderEntryList();
    });
    wrap.appendChild(chip);
  });
}

document.getElementById("sort-select").addEventListener("change", renderEntryList);

function entryFieldHTML(label, text, uid) {
  const SHOW_MORE_TRIGGER = 80; // roughly 2 lines of text at this font size/column width
  const TRUNCATE_TO = 60; // roughly 1.5 lines — leaves room for "… Show more" on that same line
  const truncatable = text.length > SHOW_MORE_TRIGGER;
  const shortText = truncatable ? text.slice(0, TRUNCATE_TO).trimEnd() + "…" : text;
  return `<div class="entry-field">
    <span class="entry-field-label">${esc(label)}</span>
    <span class="entry-field-value" id="${uid}" data-full="${esc(text)}" data-short="${esc(shortText)}">${esc(truncatable ? shortText : text)}</span>
    ${truncatable ? `<button type="button" class="entry-showmore-btn" data-target="${uid}">Show more</button>` : ""}
  </div>`;
}
function entryCardHTML(entry, attachmentLabel) {
  const sizeLabel = { small: "Small change", moderate: "Moderate change", major: "Major change" }[entry.size] || "";
  const whatHTML = entry.whatChanged ? entryFieldHTML("What changed", entry.whatChanged, `efv-${entry.id}-what`) : "";
  const whyHTML = entry.whyChanged ? entryFieldHTML("Why changed", entry.whyChanged, `efv-${entry.id}-why`) : "";
  return `
    <div class="entry-time">
      <span class="entry-time-text">${fmtDate(entry.timestamp)}
        ${attachmentLabel ? ` &middot; <span class="entry-att-tag">${esc(attachmentLabel)}</span>` : ""}
        ${sizeLabel ? ` &middot; <span class="size-badge size-${entry.size}">${esc(sizeLabel)}</span>` : ""}
      </span>
      <button class="btn-icon entry-del-btn" data-id="${entry.id}" title="Delete">&#128465;&#65039;</button>
    </div>
    <div class="entry-body-row">
      ${entry.photo ? `<img src="${entry.photo}" alt="">` : ""}
      <div class="entry-fields">
        ${whatHTML}${whyHTML}
      </div>
    </div>`;
}

async function renderEntryList() {
  const list = document.getElementById("entry-list");
  const prompt = document.getElementById("log-select-prompt");
  if (!state.attachments.length) { list.innerHTML = ""; prompt.hidden = true; return; }
  if (!state.selectedAttachmentIds.size) { list.innerHTML = ""; prompt.hidden = false; return; }
  prompt.hidden = true;

  const attById = Object.fromEntries(state.attachments.map((a) => [a.id, a]));
  const allEntries = await dbGetAll("entries");
  let entries = allEntries.filter((e) => !e.deleted && state.selectedAttachmentIds.has(e.attachmentId));

  const sortMode = document.getElementById("sort-select").value;
  if (sortMode === "name") {
    entries.sort((a, b) => {
      const an = attById[a.attachmentId]?.name || "", bn = attById[b.attachmentId]?.name || "";
      return an.localeCompare(bn) || b.timestamp - a.timestamp;
    });
  } else {
    entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<p class="empty-sub">No iterations recorded yet for the selected attachment${state.selectedAttachmentIds.size === 1 ? "" : "s"}. Tap + Record Iteration above to log your first change.</p>`;
    return;
  }
  const showTag = state.selectedAttachmentIds.size > 1 || state.attachments.length > 1;
  entries.forEach((entry) => {
    const att = attById[entry.attachmentId];
    const card = document.createElement("div");
    card.className = "entry-card";
    card.innerHTML = entryCardHTML(entry, showTag ? (att ? `#${att.number} ${att.name}` : "deleted attachment") : null);
    card.querySelector(".btn-icon").addEventListener("click", async () => {
      if (!confirm("This removes the entry from the log. You can restore it any time from Settings → Recently Deleted.")) return;
      entry.deleted = true;
      entry.deletedAt = Date.now();
      await dbPut("entries", entry);
      await renderEntryList();
      await renderIterationTotal();
      renderAttachmentsSetup();
      syncToTeamDrive();
      showUndoToast("Entry deleted.", () => restoreDeletedEntry(entry));
    });
    card.querySelectorAll(".entry-showmore-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.target);
        const expanded = target.textContent === target.dataset.full;
        target.textContent = expanded ? target.dataset.short : target.dataset.full;
        btn.textContent = expanded ? "Show more" : "Show less";
      });
    });
    list.appendChild(card);
  });
}

// ---- Attachment management (Setup tab) ----
document.getElementById("btn-record-iteration").addEventListener("click", () => openRecordIterationModal());

function renderAttachmentsSetup() {
  const list = document.getElementById("attachment-setup-list");
  const editing = state.editingAttachmentOrder;
  renderAttachmentOrderToolbar();
  (async () => {
    list.innerHTML = "";
    if (!state.attachments.length) {
      list.innerHTML = `<p class="empty-sub">No attachments yet.${editing ? "" : " Tap Edit to add one."}</p>`;
      return;
    }
    for (const [idx, att] of state.attachments.entries()) {
      const row = document.createElement("div");
      row.dataset.idx = idx;
      row.dataset.attId = String(att.id);
      if (editing) {
        row.className = "mission-row";
        row.innerHTML = `
          <span class="drag-handle">&#9776;</span>
          <span class="drag-num">#${idx + 1}</span>
          <div class="m-info"><div class="m-name">${esc(att.name)}</div></div>
          <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
          <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
        `;
        row.querySelector('[data-act="edit"]').addEventListener("click", () => openAttachmentModal(att));
        row.querySelector('[data-act="del"]').addEventListener("click", async () => {
          if (!confirm(`Delete "${att.name}" and everything logged under it?`)) return;
          const entries = await dbGetByIndex("entries", "byAttachment", att.id);
          const now = Date.now();
          for (const en of entries) { if (!en.deleted) { en.deleted = true; en.deletedAt = now; en.deletedWithAttachmentId = att.id; await dbPut("entries", en); } }
          att.deleted = true;
          att.deletedAt = now;
          await dbPut("attachments", att);
          await renumberAttachments();
          await loadAttachments();
          syncToTeamDrive();
          showUndoToast(`Deleted "${att.name}".`, async () => {
            await restoreDeletedAttachment(att.id);
          });
        });
        list.appendChild(row);
      } else {
        const count = await iterationCount(att.id);
        row.className = "mission-row";
        row.innerHTML = `
          ${att.photo ? `<img class="att-thumb" src="${att.photo}" alt="">` : ""}
          <div class="m-info">
            <div class="m-name">#${esc(att.number)} ${esc(att.name)}</div>
            <div class="m-sub">${count} iteration${count === 1 ? "" : "s"} logged</div>
          </div>
        `;
        list.appendChild(row);
      }
    }
    if (editing && state.attachments.length) {
      makeSortable(list, {
        onEnd: () => {
          [...list.querySelectorAll(".drag-num")].forEach((el, i) => { el.textContent = `#${i + 1}`; });
        },
      });
    }
  })();
}

function renderAttachmentOrderToolbar() {
  const el = document.getElementById("attachment-order-toolbar-top");
  const editing = state.editingAttachmentOrder;
  el.innerHTML = editing
    ? `<div class="edit-mode-toolbar">
         <button type="button" class="btn btn-amber btn-sm" id="btn-add-attachment">+ Attachment</button>
         <div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-save-order-attachments">Save</button><button type="button" class="btn-small-link" id="btn-cancel-order-attachments">Cancel</button></div>
       </div>`
    : `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-edit-order-attachments">Edit</button></div>`;
  wireAttachmentOrderToolbar();
}

function wireAttachmentOrderToolbar() {
  const addBtn = document.getElementById("btn-add-attachment");
  if (addBtn) addBtn.addEventListener("click", () => openAttachmentModal(null));
  const editBtn = document.getElementById("btn-edit-order-attachments");
  if (editBtn) editBtn.addEventListener("click", async () => {
    attachmentEditSessionSnapshot = await snapshotCurrentData();
    state.editingAttachmentOrder = true;
    renderAttachmentsSetup();
  });
  const cancelBtn = document.getElementById("btn-cancel-order-attachments");
  if (cancelBtn) cancelBtn.addEventListener("click", async () => {
    state.editingAttachmentOrder = false;
    if (attachmentEditSessionSnapshot) {
      await restoreFullData(attachmentEditSessionSnapshot);
      attachmentEditSessionSnapshot = null;
    } else {
      state.attachments = (await dbGetAll("attachments")).sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0));
      renderAttachmentsSetup();
    }
  });
  const saveBtn = document.getElementById("btn-save-order-attachments");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const list = document.getElementById("attachment-setup-list");
    const orderedIds = [...list.querySelectorAll("[data-att-id]")].map((row) => row.dataset.attId);
    orderedIds.forEach((id, idx) => {
      const att = state.attachments.find((a) => String(a.id) === id);
      if (att) { att.order = idx; att.number = idx + 1; }
    });
    for (const att of state.attachments) await dbPut("attachments", att);
    attachmentEditSessionSnapshot = null;
    state.editingAttachmentOrder = false;
    await loadAttachments();
    syncToTeamDrive();
  });
}

function openAttachmentModal(att) {
  const isEdit = !!att;
  let pendingAttPhoto = isEdit ? (att.photo || null) : null;
  openModal(`
    <h2>${isEdit ? "Edit attachment" : "New attachment"}</h2>
    <div class="field"><label>Name</label><input class="text-input" id="m-att-name" type="text" value="${isEdit ? esc(att.name) : ""}" placeholder="e.g. Coral claw"></div>
    <div class="field">
      <label>Picture (optional)</label>
      <div class="photo-preview-wrap" id="att-photo-preview-wrap">${pendingAttPhoto ? `<img class="photo-preview" src="${pendingAttPhoto}">` : ""}</div>
      <div class="camera-view" id="att-camera-view" hidden>
        <video id="att-camera-video" autoplay playsinline muted></video>
        <div class="camera-controls">
          <button type="button" class="btn btn-ghost" id="att-camera-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="att-camera-capture">Capture</button>
        </div>
      </div>
      <div class="btn-group" id="att-photo-btn-group">
        <button type="button" class="btn btn-amber" id="att-btn-take-photo">&#128247; Take Photo</button>
        <button type="button" class="btn btn-ghost" id="att-btn-choose-photo">Choose from files</button>
      </div>
      <input type="file" accept="image/*" id="m-att-photo" hidden>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  const attCameraIds = { view: "att-camera-view", video: "att-camera-video", btnGroup: "att-photo-btn-group", previewWrap: "att-photo-preview-wrap" };
  document.getElementById("m-cancel").addEventListener("click", () => { stopCamera(); closeModal(); });
  document.getElementById("att-btn-choose-photo").addEventListener("click", () => document.getElementById("m-att-photo").click());
  document.getElementById("att-btn-take-photo").addEventListener("click", () => openCamera(attCameraIds, (dataUrl) => { pendingAttPhoto = dataUrl; }));
  document.getElementById("att-camera-cancel").addEventListener("click", () => stopCamera());
  document.getElementById("att-camera-capture").addEventListener("click", () => capturePhoto());
  document.getElementById("m-att-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAttPhoto = await resizeImageToDataURL(file, 900, 0.72);
    document.getElementById("att-photo-preview-wrap").innerHTML = `<img class="photo-preview" src="${pendingAttPhoto}">`;
  });
  document.getElementById("m-save").addEventListener("click", async () => {
    stopCamera();
    const name = document.getElementById("m-att-name").value.trim();
    if (!name) { alert("Give this attachment a name."); return; }
    const record = isEdit ? att : { id: crypto.randomUUID(), order: state.attachments.length, number: state.attachments.length + 1 };
    record.name = name;
    record.photo = pendingAttPhoto;
    if (!isEdit) record.createdAt = Date.now();
    const id = await dbPut("attachments", record);
    if (!isEdit) { state.selectedAttachmentIds.add(id); }
    closeModal();
    await loadAttachments();
    syncToTeamDrive();
  });
}

// ---- Record Iteration modal (attachment picker + size + what/why + photo + voice-to-text) ----
let pendingPhoto = null;
let pendingSize = "small";
let recognizer = null;

function openRecordIterationModal() {
  if (!state.attachments.length) {
    openModal(`<h2>No attachments yet</h2><p class="empty-sub">Go to Settings to add a robot attachment first.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="m-close" type="button">Got it</button></div>`);
    document.getElementById("m-close").addEventListener("click", closeModal);
    return;
  }
  if (state.interactiveIterationsEnabled) { startInteractiveIterationFlow(); return; }
  openRecordIterationModalClassic();
}

function openRecordIterationModalClassic() {
  pendingPhoto = null;
  pendingSize = "small";
  const defaultAttId = state.selectedAttachmentIds.size === 1 ? [...state.selectedAttachmentIds][0] : state.attachments[0].id;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  openModal(`
    <h2>Record Iteration</h2>
    <div class="field"><label>Attachment</label>
      <select class="text-input" id="ri-attachment">
        ${state.attachments.map((a) => `<option value="${a.id}" ${a.id === defaultAttId ? "selected" : ""}>#${esc(a.number)} ${esc(a.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Size of this iteration</label>
      <div class="size-picker" id="ri-size-picker">
        <button type="button" class="size-btn" data-size="small">Small<span>bug fix</span></button>
        <button type="button" class="size-btn" data-size="moderate">Moderate<span>a real change</span></button>
        <button type="button" class="size-btn" data-size="major">Major<span>strategy change</span></button>
      </div>
    </div>
    <div class="field">
      <label>Photo</label>
      <div class="photo-preview-wrap" id="photo-preview-wrap"></div>
      <div class="camera-view" id="camera-view" hidden>
        <video id="camera-video" autoplay playsinline muted></video>
        <div class="camera-controls">
          <button type="button" class="btn btn-ghost" id="camera-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="camera-capture">Capture</button>
        </div>
      </div>
      <div class="btn-group" id="photo-btn-group">
        <button type="button" class="btn btn-amber" id="btn-take-photo">&#128247; Take Photo</button>
        <button type="button" class="btn btn-ghost" id="btn-choose-photo">Choose from files</button>
      </div>
      <input type="file" accept="image/*" id="ri-photo" hidden>
    </div>
    <div class="field">
      <label>What changed?</label>
      ${SpeechRec ? `<div class="voice-row"><button class="btn btn-ghost" id="m-voice-btn-1" type="button">&#127908; Dictate</button><span class="voice-status" id="m-voice-status-1"></span></div>` : ""}
      <textarea class="textarea-input" id="ri-what" placeholder="e.g. Swapped the claw's gear ratio from 1:1 to 3:1"></textarea>
    </div>
    <div class="field">
      <label>Why changed?</label>
      ${SpeechRec ? `<div class="voice-row"><button class="btn btn-ghost" id="m-voice-btn-2" type="button">&#127908; Dictate</button><span class="voice-status" id="m-voice-status-2"></span></div>` : ""}
      <textarea class="textarea-input" id="ri-why" placeholder="e.g. It was stalling under load on the last run"></textarea>
    </div>
    ${SpeechRec ? "" : `<p class="type-hint">Voice-to-text isn't supported in this browser &mdash; try Chrome on Android.</p>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save entry</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", () => { stopRecognizer(); stopCamera(); closeModal(); });

  document.querySelectorAll("#ri-size-picker .size-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#ri-size-picker .size-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      pendingSize = btn.dataset.size;
    });
  });

  document.getElementById("btn-choose-photo").addEventListener("click", () => document.getElementById("ri-photo").click());
  document.getElementById("ri-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingPhoto = await resizeImageToDataURL(file, 900, 0.72);
    document.getElementById("photo-preview-wrap").innerHTML = `<img class="photo-preview" src="${pendingPhoto}">`;
  });

  const riCameraIds = { view: "camera-view", video: "camera-video", btnGroup: "photo-btn-group", previewWrap: "photo-preview-wrap" };
  document.getElementById("btn-take-photo").addEventListener("click", () => openCamera(riCameraIds, (dataUrl) => { pendingPhoto = dataUrl; }));
  document.getElementById("camera-cancel").addEventListener("click", () => stopCamera());
  document.getElementById("camera-capture").addEventListener("click", () => capturePhoto());

  if (SpeechRec) {
    document.getElementById("m-voice-btn-1").addEventListener("click", () => toggleVoiceNote(SpeechRec, "ri-what", "m-voice-status-1", "m-voice-btn-1"));
    document.getElementById("m-voice-btn-2").addEventListener("click", () => toggleVoiceNote(SpeechRec, "ri-why", "m-voice-status-2", "m-voice-btn-2"));
  }

  document.getElementById("m-save").addEventListener("click", async () => {
    stopRecognizer();
    stopCamera();
    const attachmentId = document.getElementById("ri-attachment").value;
    const whatChanged = document.getElementById("ri-what").value.trim();
    const whyChanged = document.getElementById("ri-why").value.trim();
    if (!whatChanged && !whyChanged && !pendingPhoto) { alert("Add a photo or a note first."); return; }
    await dbPut("entries", { id: crypto.randomUUID(), attachmentId, timestamp: Date.now(), photo: pendingPhoto, whatChanged, whyChanged, size: pendingSize });
    state.selectedAttachmentIds.add(attachmentId);
    closeModal();
    renderAttachmentChips();
    await renderEntryList();
    await renderIterationTotal();
    renderAttachmentsSetup();
    syncToTeamDrive();
  });
}

// ---- Interactive iteration logging: one step at a time, camera-first ----
const ITER_STEPS = ["attachment", "size", "photo", "what", "why"];
function startInteractiveIterationFlow() {
  state.iterFlow = {
    step: 0,
    attachmentId: null,
    size: null,
    photo: null,
    what: "",
    why: "",
  };
  renderIterStep();
}
function renderIterStep() {
  iterStopCameraStream(); // leaving/entering any step other than photo shouldn't leave the camera running
  const step = ITER_STEPS[state.iterFlow.step];
  if (step === "attachment") renderIterAttachmentStep();
  else if (step === "size") renderIterSizeStep();
  else if (step === "photo") renderIterPhotoStep();
  else if (step === "what") renderIterWhatStep();
  else renderIterWhyStep();
}
function iterHeaderHTML(title) {
  const canBack = state.iterFlow.step > 0;
  return `<div class="gfs-header">
    <div class="gfs-header-top">
      <button type="button" class="gfs-cancel-x" id="iter-cancel" title="Cancel">&#10005;</button>
      <button type="button" class="gfs-back-btn" id="iter-back" ${canBack ? "" : "disabled"}>&#8592;</button>
      <div class="guided-phase-badge">Record Iteration</div>
    </div>
    <h2 class="gfs-mission-name">${esc(title)}</h2>
  </div>`;
}
function wireIterNav() {
  document.getElementById("iter-cancel").addEventListener("click", () => {
    if (!confirm("Discard this iteration entry?")) return;
    iterStopCameraStream();
    stopRecognizer();
    state.iterFlow = null;
    closeGuidedFullscreen();
  });
  const back = document.getElementById("iter-back");
  if (back && state.iterFlow.step > 0) {
    back.addEventListener("click", () => { state.iterFlow.step--; renderIterStep(); });
  }
}
function renderIterAttachmentStep() {
  openGuidedFullscreen(`
    ${iterHeaderHTML("Which attachment?")}
    <div class="gfs-body gfs-center">
      <div class="iter-attachment-grid">
        ${state.attachments.map((a) => `<button type="button" class="iter-attachment-btn${a.id === state.iterFlow.attachmentId ? " active" : ""}" data-id="${a.id}">#${esc(a.number)} ${esc(a.name)}</button>`).join("")}
      </div>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireIterNav();
  document.querySelectorAll(".iter-attachment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.iterFlow.attachmentId = btn.dataset.id;
      state.iterFlow.step++;
      renderIterStep();
    });
  });
}
function renderIterSizeStep() {
  openGuidedFullscreen(`
    ${iterHeaderHTML("Size of this iteration?")}
    <div class="gfs-body gfs-center">
      <div class="size-picker size-picker-big" id="iter-size-picker">
        <button type="button" class="size-btn${state.iterFlow.size === "small" ? " active" : ""}" data-size="small">Small<span>bug fix</span></button>
        <button type="button" class="size-btn${state.iterFlow.size === "moderate" ? " active" : ""}" data-size="moderate">Moderate<span>a real change</span></button>
        <button type="button" class="size-btn${state.iterFlow.size === "major" ? " active" : ""}" data-size="major">Major<span>strategy change</span></button>
      </div>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireIterNav();
  document.querySelectorAll("#iter-size-picker .size-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.iterFlow.size = btn.dataset.size;
      state.iterFlow.step++;
      renderIterStep();
    });
  });
}
async function iterStartCamera() {
  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.getElementById("iter-camera-video");
    if (video) video.srcObject = activeCameraStream;
  } catch (err) {
    showErrorBanner("Couldn't access the camera (" + (err.message || err.name) + ") — use the upload button instead.");
  }
}
function iterStopCameraStream() {
  if (activeCameraStream) { activeCameraStream.getTracks().forEach((t) => t.stop()); activeCameraStream = null; }
}
function iterCapturePhoto() {
  const video = document.getElementById("iter-camera-video");
  if (!video || !video.videoWidth) return;
  const maxDim = 900;
  let { videoWidth: width, videoHeight: height } = video;
  if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
  else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  state.iterFlow.photo = canvas.toDataURL("image/jpeg", 0.72);
  iterStopCameraStream();
  renderIterPhotoStep(); // switch straight into the review/preview screen
}
function renderIterPhotoStep() {
  const hasPhoto = !!state.iterFlow.photo;
  openGuidedFullscreen(`
    ${iterHeaderHTML(hasPhoto ? "Review photo" : "Take a photo")}
    <div class="gfs-body gfs-center">
      ${hasPhoto ? `
        <div class="iter-photo-preview-big"><img src="${state.iterFlow.photo}"></div>
        <button type="button" class="btn btn-ghost btn-full" id="iter-retake-btn" style="margin-top:14px;">&#8635; Retake</button>
      ` : `
        <div class="camera-view" id="iter-camera-view"><video id="iter-camera-video" autoplay playsinline muted></video></div>
        <div class="iter-shutter-row">
          <button type="button" class="iter-upload-btn" id="iter-upload-btn" title="Upload a photo instead">&#128193;</button>
          <button type="button" class="iter-shutter-btn" id="iter-shutter-btn" title="Capture"></button>
          <span class="iter-shutter-spacer"></span>
        </div>
        <input type="file" accept="image/*" id="iter-photo-file" hidden>
      `}
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn btn-primary btn-full" id="iter-photo-next">${hasPhoto ? "Next" : "Skip photo"}</button>
    </div>
  `);
  wireIterNav();
  if (hasPhoto) {
    document.getElementById("iter-retake-btn").addEventListener("click", () => {
      state.iterFlow.photo = null;
      renderIterPhotoStep(); // back to the camera
    });
  } else {
    iterStartCamera(); // camera opens immediately — this step is camera-first, not a choice screen
    document.getElementById("iter-shutter-btn").addEventListener("click", iterCapturePhoto);
    document.getElementById("iter-upload-btn").addEventListener("click", () => document.getElementById("iter-photo-file").click());
    document.getElementById("iter-photo-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      iterStopCameraStream();
      state.iterFlow.photo = await resizeImageToDataURL(file, 900, 0.72);
      renderIterPhotoStep(); // switch straight into the review/preview screen
    });
  }
  document.getElementById("iter-photo-next").addEventListener("click", () => {
    state.iterFlow.step++;
    renderIterStep();
  });
}
function renderIterWhatStep() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  openGuidedFullscreen(`
    ${iterHeaderHTML("What changed?")}
    <div class="gfs-body gfs-center">
      ${SpeechRec ? `
        <button type="button" class="iter-dictate-btn" id="iter-voice-1">&#127908;<span>Dictate</span></button>
        <div class="voice-status" id="iter-voice-status-1"></div>
      ` : ""}
      <textarea class="textarea-input iter-fallback-textarea" id="iter-what" placeholder="e.g. Swapped the claw's gear ratio from 1:1 to 3:1">${esc(state.iterFlow.what)}</textarea>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn btn-primary btn-full" id="iter-what-next">Next</button>
    </div>
  `);
  wireIterNav();
  if (SpeechRec) document.getElementById("iter-voice-1").addEventListener("click", () => toggleVoiceNote(SpeechRec, "iter-what", "iter-voice-status-1", "iter-voice-1"));
  document.getElementById("iter-what-next").addEventListener("click", () => {
    stopRecognizer();
    state.iterFlow.what = document.getElementById("iter-what").value.trim();
    state.iterFlow.step++;
    renderIterStep();
  });
}
function renderIterWhyStep() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  openGuidedFullscreen(`
    ${iterHeaderHTML("Why changed?")}
    <div class="gfs-body gfs-center">
      ${SpeechRec ? `
        <button type="button" class="iter-dictate-btn" id="iter-voice-2">&#127908;<span>Dictate</span></button>
        <div class="voice-status" id="iter-voice-status-2"></div>
      ` : ""}
      <textarea class="textarea-input iter-fallback-textarea" id="iter-why" placeholder="e.g. It was stalling under load on the last run">${esc(state.iterFlow.why)}</textarea>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn btn-primary btn-full" id="iter-save">Save entry</button>
    </div>
  `);
  wireIterNav();
  if (SpeechRec) document.getElementById("iter-voice-2").addEventListener("click", () => toggleVoiceNote(SpeechRec, "iter-why", "iter-voice-status-2", "iter-voice-2"));
  document.getElementById("iter-save").addEventListener("click", async () => {
    stopRecognizer();
    state.iterFlow.why = document.getElementById("iter-why").value.trim();
    const { attachmentId, size, photo, what, why } = state.iterFlow;
    if (!what && !why && !photo) { alert("Add a photo or a note first."); return; }
    await dbPut("entries", { id: crypto.randomUUID(), attachmentId, timestamp: Date.now(), photo, whatChanged: what, whyChanged: why, size });
    state.selectedAttachmentIds.add(attachmentId);
    state.iterFlow = null;
    closeGuidedFullscreen();
    renderAttachmentChips();
    await renderEntryList();
    await renderIterationTotal();
    renderAttachmentsSetup();
    syncToTeamDrive();
  });
}

let activeCameraStream = null;
let activeCameraIds = null;
let activeCameraCallback = null;
async function openCamera(ids, onCapture) {
  activeCameraIds = ids;
  activeCameraCallback = onCapture;
  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.getElementById(ids.video);
    video.srcObject = activeCameraStream;
    document.getElementById(ids.view).hidden = false;
    document.getElementById(ids.btnGroup).hidden = true;
  } catch (err) {
    // Permission denied, no camera, or an insecure context — fall back to the
    // regular file picker rather than leaving the person stuck.
    showErrorBanner("Couldn't access the camera (" + (err.message || err.name) + ") — use Choose from files instead.");
  }
}
function stopCamera() {
  if (activeCameraStream) { activeCameraStream.getTracks().forEach((t) => t.stop()); activeCameraStream = null; }
  if (activeCameraIds) {
    const view = document.getElementById(activeCameraIds.view);
    const btnGroup = document.getElementById(activeCameraIds.btnGroup);
    if (view) view.hidden = true;
    if (btnGroup) btnGroup.hidden = false;
  }
}
function capturePhoto() {
  if (!activeCameraIds) return;
  const video = document.getElementById(activeCameraIds.video);
  const maxDim = 900;
  let { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return;
  if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
  else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
  const wrap = document.getElementById(activeCameraIds.previewWrap);
  if (wrap) wrap.innerHTML = `<img class="photo-preview" src="${dataUrl}">`;
  if (activeCameraCallback) activeCameraCallback(dataUrl);
  stopCamera();
}

function resizeImageToDataURL(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toggleVoiceNote(SpeechRec, textareaId, statusId, btnId) {
  const statusEl = document.getElementById(statusId);
  const btn = document.getElementById(btnId);
  if (recognizer) { stopRecognizer(); return; }
  recognizer = new SpeechRec();
  recognizer.lang = "en-US"; recognizer.continuous = true; recognizer.interimResults = false;
  recognizer.onstart = () => {
    statusEl.textContent = "listening…"; statusEl.classList.add("listening");
    if (btn.classList.contains("iter-dictate-btn")) { btn.classList.add("recording"); btn.innerHTML = "&#9209;<span>Stop</span>"; }
    else btn.textContent = "⏹ Stop";
  };
  recognizer.onerror = () => { statusEl.textContent = "mic error — try again"; };
  recognizer.onend = () => {
    statusEl.classList.remove("listening"); statusEl.textContent = "stopped";
    if (btn.classList.contains("iter-dictate-btn")) { btn.classList.remove("recording"); btn.innerHTML = "&#127908;<span>Dictate</span>"; }
    else btn.textContent = "🎙 Dictate";
    recognizer = null;
  };
  recognizer.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) transcript += event.results[i][0].transcript + " ";
    }
    if (transcript) {
      const ta = document.getElementById(textareaId);
      ta.value = (ta.value ? ta.value + " " : "") + transcript.trim();
    }
  };
  recognizer.start();
}
function stopRecognizer() { if (recognizer) { try { recognizer.stop(); } catch (e) {} recognizer = null; } }

// ==========================================================
// MISSIONS + TASKS (Setup tab)
// ==========================================================
async function loadRunGroups() {
  state.runGroups = (await dbGetAll("runGroups")).filter((g) => !g.deleted).sort((a, b) => a.order - b.order);
  renderRunGroups();
}
async function restoreDeletedRunGroup(id) {
  const g = await dbGet("runGroups", id);
  if (!g) return;
  delete g.deleted;
  delete g.deletedAt;
  await dbPut("runGroups", g);
  await loadRunGroups();
  await loadMissions();
  renderRunGroups();
  syncToTeamDrive();
}

// Missions carry a global .order spanning every run group, so guided-run
// traversal and CSV export can just sort state.missions and get the right
// sequence. This recomputes it from (run-group order, mission's order within
// that group) any time the grouping structure changes.
async function recomputeGlobalMissionOrder() {
  const groups = (await dbGetAll("runGroups")).filter((g) => !g.deleted).sort((a, b) => a.order - b.order);
  const allMissions = (await dbGetAll("missions")).filter((m) => !m.deleted);
  let globalIdx = 0;
  for (const g of groups) {
    const groupMissions = allMissions.filter((m) => m.runGroupId === g.id).sort((a, b) => a.order - b.order);
    for (const m of groupMissions) { m.order = globalIdx++; await dbPut("missions", m); }
  }
  const orphans = allMissions.filter((m) => !groups.some((g) => g.id === m.runGroupId)).sort((a, b) => a.order - b.order);
  for (const m of orphans) { m.order = globalIdx++; await dbPut("missions", m); }
}

async function loadMissions() {
  state.missions = (await dbGetAll("missions")).filter((m) => !m.deleted).sort((a, b) => a.order - b.order);
  state.missions.forEach((m) => { if (!m.tasks) m.tasks = []; if (m.taskSeq === undefined) m.taskSeq = 0; });
}
// Deleted tasks stay in mission.tasks (so they can be restored later) — every
// place that displays or scores a mission's tasks should read through this,
// not mission.tasks directly, so a soft-deleted task doesn't show up in the
// UI or count towards scoring while it's sitting in the trash.
function visibleTasks(mission) { return (mission.tasks || []).filter((t) => !t.deleted); }
async function restoreDeletedMission(id) {
  const m = await dbGet("missions", id);
  if (!m) return;
  delete m.deleted;
  delete m.deletedAt;
  await dbPut("missions", m);
  await recomputeGlobalMissionOrder();
  await loadMissions();
  renderRunGroups();
  syncToTeamDrive();
}
async function restoreDeletedTask(missionId, taskId) {
  const m = await dbGet("missions", missionId);
  if (!m) return;
  const t = (m.tasks || []).find((tt) => tt.id === taskId);
  if (!t) return;
  delete t.deleted;
  delete t.deletedAt;
  await dbPut("missions", m);
  await loadMissions();
  renderRunGroups();
  syncToTeamDrive();
}

function taskSubLabel(t) {
  if (t.type === "bool") return `Yes/No · ${taskMaxPoints(t)} pts`;
  if (t.type === "number") return `Count 0–${t.max} · ${t.pointsPerUnit} pt/each · max ${taskMaxPoints(t)}`;
  return `Multi-state · max ${taskMaxPoints(t)} pts`;
}

// ---- Runs (leave-and-return trips), each holding several missions ----

function renderOrderToolbarTop() {
  const el = document.getElementById("order-toolbar-top");
  const editing = state.editingAllOrder;
  el.innerHTML = editing
    ? `<div class="edit-mode-toolbar">
         <div class="btn-group">
           <button type="button" class="btn btn-ghost btn-sm" id="btn-import-missions">Import CSV</button>
           <button type="button" class="btn btn-amber btn-sm" id="btn-add-rungroup">+ Run</button>
         </div>
         <div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-save-order-all">Save</button><button type="button" class="btn-small-link" id="btn-cancel-order-all">Cancel</button></div>
       </div>`
    : `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-edit-order-all">Edit</button></div>`;
  if (editing) {
    document.getElementById("btn-add-rungroup").addEventListener("click", () => openRunGroupModal(null));
    document.getElementById("btn-import-missions").addEventListener("click", openImportMissionsModal);
    document.getElementById("btn-save-order-all").addEventListener("click", saveAllOrder);
    document.getElementById("btn-cancel-order-all").addEventListener("click", async () => {
      state.editingAllOrder = false;
      if (runsEditSessionSnapshot) {
        await restoreFullData(runsEditSessionSnapshot);
        runsEditSessionSnapshot = null;
      } else {
        await loadMissions();
        await loadRunGroups();
      }
    });
  } else {
    document.getElementById("btn-edit-order-all").addEventListener("click", async () => {
      runsEditSessionSnapshot = await snapshotCurrentData();
      state.editingAllOrder = true;
      renderRunGroups();
    });
  }
}

// Reads whatever order rows currently sit in, in the DOM — robust regardless
// of how many nested levels were actually dragged this session. A mission's
// run assignment is read from whichever run's container its row currently
// sits in, so cross-run drags are picked up correctly.
async function saveAllOrder() {
  const groupEls = [...document.querySelectorAll("#rungroup-list > [data-gid]")];

  groupEls.forEach((el, idx) => {
    const g = state.runGroups.find((x) => x.id === el.dataset.gid);
    if (g) g.order = idx;
  });
  for (const g of state.runGroups) await dbPut("runGroups", g);

  groupEls.forEach((groupEl) => {
    const gid = groupEl.dataset.gid;
    const missionListContainer = groupEl.querySelector(":scope > .task-list");
    if (!missionListContainer) return;
    const missionEls = [...missionListContainer.querySelectorAll(":scope > [data-mid]")];
    missionEls.forEach((mEl, idx) => {
      const m = state.missions.find((x) => x.id === mEl.dataset.mid);
      if (m) { m.order = idx; m.runGroupId = gid; }
    });
  });
  // Missions dragged into (or left in) the Unassigned bucket get their
  // runGroupId cleared — otherwise they'd still silently point at whatever
  // run they used to belong to, even though they visually moved out of it.
  const unassignedEl = document.querySelector("#rungroup-list > [data-unassigned]");
  if (unassignedEl) {
    const missionListContainer = unassignedEl.querySelector(":scope > .task-list");
    if (missionListContainer) {
      const missionEls = [...missionListContainer.querySelectorAll(":scope > [data-mid]")];
      missionEls.forEach((mEl, idx) => {
        const m = state.missions.find((x) => x.id === mEl.dataset.mid);
        if (m) { m.order = idx; m.runGroupId = null; }
      });
    }
  }

  const allMissionEls = [...document.querySelectorAll("[data-mid]")];
  for (const mEl of allMissionEls) {
    const m = state.missions.find((x) => x.id === mEl.dataset.mid);
    if (!m) continue;
    const taskEls = [...mEl.querySelectorAll(":scope > .task-list > [data-tid]")];
    if (!taskEls.length) continue;
    const reordered = taskEls.map((te) => m.tasks.find((t) => t.id === te.dataset.tid)).filter(Boolean);
    if (reordered.length === visibleTasks(m).length) {
      m.tasks = [...reordered, ...m.tasks.filter((t) => t.deleted)];
    }
  }
  for (const m of state.missions) await dbPut("missions", m);

  await recomputeGlobalMissionOrder();
  state.editingAllOrder = false;
  runsEditSessionSnapshot = null;
  await loadMissions();
  await loadRunGroups();
  syncToTeamDrive();
}

function renderRunGroups() {
  renderOrderToolbarTop();
  const list = document.getElementById("rungroup-list");
  const editing = state.editingAllOrder;
  list.innerHTML = "";
  if (!state.runGroups.length) {
    list.innerHTML = `<p class="empty-sub">No runs yet. Add one, then add the missions it covers.</p>`;
  }

  state.runGroups.forEach((g) => {
    const wrap = document.createElement("div");
    wrap.dataset.gid = g.id;
    wrap.className = "mission-group";
    const expanded = editing ? true : state.expandedRunGroups.has(g.id);
    const groupMissions = state.missions.filter((m) => m.runGroupId === g.id);
    wrap.innerHTML = `
      <div class="mission-row mission-group-head${editing ? "" : " mission-expand-target"}" data-act="expand">
        ${editing ? `<span class="drag-handle">&#9776;</span>` : ""}
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(runGroupDisplayName(g))}</div>
          <div class="m-sub">${groupMissions.length} mission${groupMissions.length === 1 ? "" : "s"}</div>
        </div>
        ${editing ? `<button class="btn-icon btn-icon-add" data-act="add-mission" title="Add a mission">&#43;</button><button class="btn-icon" data-act="edit">&#9998;&#65039;</button><button class="btn-icon" data-act="del">&#128465;&#65039;</button>` : ""}
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    if (!editing) {
      wrap.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
        if (expanded) state.expandedRunGroups.delete(g.id); else state.expandedRunGroups.add(g.id);
        renderRunGroups();
      });
    } else {
      const addBtn = wrap.querySelector('[data-act="add-mission"]');
      if (addBtn) addBtn.addEventListener("click", () => openMissionNameModal(null, g));
      const editBtn = wrap.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener("click", () => openRunGroupModal(g));
      const delBtn = wrap.querySelector('[data-act="del"]');
      if (delBtn) delBtn.addEventListener("click", async () => {
        const displayName = runGroupDisplayName(g);
        if (!confirm(`Delete "${displayName}"? Its missions move to "Unassigned" rather than being deleted.`)) return;
        g.deleted = true;
        g.deletedAt = Date.now();
        await dbPut("runGroups", g);
        await loadRunGroups();
        await loadMissions();
        renderRunGroups();
        syncToTeamDrive();
        showUndoToast(`Deleted "${displayName}".`, async () => {
          await restoreDeletedRunGroup(g.id);
        });
      });
    }
    if (expanded) {
      const container = wrap.querySelector(".task-list");
      renderMissionsForGroup(container, g);
      makeSortable(container, { group: "missions" });
    }
    list.appendChild(wrap);
  });
  if (editing && state.runGroups.length) makeSortable(list);

  const orphans = state.missions.filter((m) => !state.runGroups.some((g) => g.id === m.runGroupId));
  let orphanWrap = null;
  if (orphans.length) {
    orphanWrap = document.createElement("div");
    orphanWrap.className = "mission-group unassigned-group";
    orphanWrap.dataset.unassigned = "1";
    const orphanExpanded = editing ? true : state.expandedRunGroups.has("unassigned");
    orphanWrap.innerHTML = `
      <div class="mission-row mission-group-head${editing ? "" : " mission-expand-target"}" data-act="expand">
        <span class="mission-expand-chevron">${orphanExpanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">Unassigned</div>
          <div class="m-sub">${orphans.length} mission${orphans.length === 1 ? "" : "s"} without a run</div>
        </div>
      </div>
      <div class="task-list" ${orphanExpanded ? "" : "hidden"}></div>
    `;
    if (!editing) {
      orphanWrap.querySelector('[data-act="expand"]').addEventListener("click", () => {
        if (orphanExpanded) state.expandedRunGroups.delete("unassigned"); else state.expandedRunGroups.add("unassigned");
        renderRunGroups();
      });
    }
    if (orphanExpanded) {
      const orphanContainer = orphanWrap.querySelector(".task-list");
      renderOrphanMissions(orphanContainer, orphans);
      makeSortable(orphanContainer, { group: "missions" });
    }
  }

  if (orphanWrap) list.appendChild(orphanWrap);
}

function renderOrphanMissions(container, orphans) {
  const editing = state.editingAllOrder;
  container.innerHTML = "";
  orphans.forEach((m) => {
    const expanded = editing ? true : state.expandedMissions.has(m.id);
    const row = document.createElement("div");
    row.className = "mission-group";
    row.dataset.mid = m.id;
    row.innerHTML = `
      <div class="mission-row mission-group-head${editing ? "" : " mission-expand-target"}" data-act="expand">
        ${editing ? `<span class="drag-handle">&#9776;</span>` : ""}
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(m.name)}</div>
          <div class="m-sub">${visibleTasks(m).length} task${visibleTasks(m).length === 1 ? "" : "s"} · max ${missionMaxPoints(m)} pts</div>
        </div>
        ${editing ? `<button class="btn-icon btn-icon-add" data-act="add-task" title="Add a task">&#43;</button><button class="btn-icon" data-act="edit">&#9998;&#65039;</button><button class="btn-icon" data-act="del">&#128465;&#65039;</button>` : ""}
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    if (!editing) {
      row.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
        if (expanded) state.expandedMissions.delete(m.id); else state.expandedMissions.add(m.id);
        renderRunGroups();
      });
    } else {
      row.querySelector('[data-act="add-task"]').addEventListener("click", () => openTaskModal(m, null));
      row.querySelector('[data-act="edit"]').addEventListener("click", () => openMissionNameModal(m, null));
      row.querySelector('[data-act="del"]').addEventListener("click", async () => {
        if (!confirm(`Delete mission "${m.name}" and all its tasks?`)) return;
        m.deleted = true;
        m.deletedAt = Date.now();
        await dbPut("missions", m);
        await loadMissions();
        renderRunGroups();
        syncToTeamDrive();
        showUndoToast(`Deleted mission "${m.name}".`, async () => {
          await restoreDeletedMission(m.id);
        });
      });
    }
    if (expanded) renderTaskList(row.querySelector(".task-list"), m);
    container.appendChild(row);
  });
}

function openRunGroupModal(g) {
  const isEdit = !!g;
  const previewNum = isEdit ? runGroupNumber(g) : state.runGroups.length + 1;
  openModal(`
    <h2>${isEdit ? "Rename run" : "New run"}</h2>
    <p class="empty-sub">This will be <strong>Run ${previewNum}</strong> — the number is automatic based on order. Give it a nickname if you want one.</p>
    <div class="field"><label>Nickname (optional)</label><input class="text-input" id="rg-name" value="${isEdit ? esc(g.name || "") : ""}" placeholder="e.g. Flower"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("rg-name").value.trim();
    const record = isEdit ? g : { id: crypto.randomUUID(), order: state.runGroups.length };
    record.name = name;
    const id = await dbPut("runGroups", record);
    closeModal();
    if (!isEdit) { state.expandedRunGroups.add(id); }
    await loadRunGroups();
    syncToTeamDrive();
  });
}

// ---- Missions nested within a run ----
function renderMissionsForGroup(container, group) {
  const editing = state.editingAllOrder;
  container.innerHTML = "";
  const groupMissions = state.missions.filter((m) => m.runGroupId === group.id).sort((a, b) => a.order - b.order);

  groupMissions.forEach((m) => {
    const expanded = editing ? true : state.expandedMissions.has(m.id);
    const row = document.createElement("div");
    row.className = "mission-group";
    row.dataset.mid = m.id;
    row.innerHTML = `
      <div class="mission-row mission-group-head${editing ? "" : " mission-expand-target"}" data-act="expand">
        ${editing ? `<span class="drag-handle">&#9776;</span>` : ""}
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(m.name)}</div>
          <div class="m-sub">${visibleTasks(m).length} task${visibleTasks(m).length === 1 ? "" : "s"} · max ${missionMaxPoints(m)} pts</div>
        </div>
        ${editing ? `<button class="btn-icon btn-icon-add" data-act="add-task" title="Add a task">&#43;</button><button class="btn-icon" data-act="edit">&#9998;&#65039;</button><button class="btn-icon" data-act="del">&#128465;&#65039;</button>` : ""}
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    if (!editing) {
      row.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
        if (expanded) state.expandedMissions.delete(m.id); else state.expandedMissions.add(m.id);
        renderRunGroups();
      });
    } else {
      const addBtn = row.querySelector('[data-act="add-task"]');
      if (addBtn) addBtn.addEventListener("click", () => openTaskModal(m, null));
      const editBtn = row.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener("click", () => openMissionNameModal(m, group));
      const delBtn = row.querySelector('[data-act="del"]');
      if (delBtn) delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete mission "${m.name}" and all its tasks?`)) return;
        m.deleted = true;
        m.deletedAt = Date.now();
        await dbPut("missions", m);
        await loadMissions();
        renderRunGroups();
        syncToTeamDrive();
        showUndoToast(`Deleted mission "${m.name}".`, async () => {
          await restoreDeletedMission(m.id);
        });
      });
    }
    if (expanded) {
      const taskListEl = row.querySelector(".task-list");
      renderTaskList(taskListEl, m);
    }
    container.appendChild(row);
  });
}

function openMissionNameModal(m, group) {
  const isEdit = !!m;
  const currentGroupId = isEdit ? m.runGroupId : group?.id;
  openModal(`
    <h2>${isEdit ? "Edit mission" : "New mission"}</h2>
    <div class="field"><label>Official mission number</label><input class="text-input" id="m-mission-number" type="number" value="${isEdit && m.number != null ? m.number : ""}" placeholder="e.g. 7"></div>
    <div class="field"><label>Mission name</label><input class="text-input" id="m-mission-name" value="${isEdit ? esc(m.name) : ""}" placeholder="e.g. Coral nursery"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("m-mission-name").value.trim();
    if (!name) { alert("Name this mission."); return; }
    const numberVal = document.getElementById("m-mission-number").value.trim();
    const newGroupId = currentGroupId;
    const record = isEdit ? m : { id: crypto.randomUUID(), order: 9999, tasks: [], taskSeq: 0 };
    record.name = name;
    record.number = numberVal === "" ? null : Number(numberVal);
    record.runGroupId = newGroupId;
    const id = await dbPut("missions", record);
    closeModal();
    if (!isEdit) { state.expandedMissions.add(id); }
    state.expandedRunGroups.add(newGroupId);
    await recomputeGlobalMissionOrder();
    await loadMissions();
    renderRunGroups();
    syncToTeamDrive();
  });
}

function optionRowHtml(label = "", points = 0) {
  return `<div class="option-row">
    <input class="text-input" placeholder="Option label" value="${esc(label)}" data-f="label">
    <input type="number" placeholder="pts" value="${points}" data-f="points">
    <button class="btn-icon" data-act="rm-option">&#10005;</button>
  </div>`;
}

function renderTaskList(container, mission) {
  const editing = state.editingAllOrder;
  container.innerHTML = "";
  visibleTasks(mission).forEach((t) => {
    const row = document.createElement("div");
    row.dataset.tid = t.id;
    if (editing) {
      row.className = "task-row";
      row.innerHTML = `
        <span class="drag-handle">&#9776;</span>
        <div class="m-info"><div class="m-name">${esc(t.name)}</div></div>
        <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
        <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
      `;
      row.querySelector('[data-act="edit"]').addEventListener("click", () => openTaskModal(mission, t));
      row.querySelector('[data-act="del"]').addEventListener("click", async () => {
        if (!confirm(`Delete task "${t.name}"?`)) return;
        t.deleted = true;
        t.deletedAt = Date.now();
        await dbPut("missions", mission);
        await loadMissions();
        renderRunGroups();
        syncToTeamDrive();
        showUndoToast(`Deleted task "${t.name}".`, async () => {
          await restoreDeletedTask(mission.id, t.id);
        });
      });
      container.appendChild(row);
      return;
    }
    row.className = "task-row";
    row.innerHTML = `
      <div class="m-info">
        <div class="m-name">${esc(t.name)}</div>
        <div class="m-sub">${taskSubLabel(t)}</div>
      </div>
    `;
    container.appendChild(row);
  });
  if (editing && visibleTasks(mission).length) makeSortable(container);
}

function openTaskModal(mission, t) {
  const isEdit = !!t;
  const type = t?.type || "bool";
  openModal(`
    <h2>${isEdit ? "Edit task" : "New task"}</h2>
    <p class="empty-sub">Mission: ${esc(mission.name)}</p>
    <div class="field"><label>Task name</label><input class="text-input" id="t-name" value="${isEdit ? esc(t.name) : ""}" placeholder="e.g. Sample in habitat"></div>
    <div class="field"><label>Scoring type</label>
      <select class="text-input" id="t-type">
        <option value="bool" ${type === "bool" ? "selected" : ""}>Yes / No</option>
        <option value="number" ${type === "number" ? "selected" : ""}>Counted objects</option>
        <option value="choice" ${type === "choice" ? "selected" : ""}>Multiple states</option>
      </select>
    </div>
    <div id="t-type-fields"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  function renderTypeFields() {
    const ty = document.getElementById("t-type").value;
    const box = document.getElementById("t-type-fields");
    if (ty === "bool") {
      box.innerHTML = `<div class="field"><label>Points when achieved</label><input type="number" class="text-input" id="t-bool-points" value="${isEdit && t.type === "bool" ? t.points : 20}"></div>`;
    } else if (ty === "number") {
      box.innerHTML = `
        <div class="field"><label>Max count</label><input type="number" class="text-input" id="t-num-max" value="${isEdit && t.type === "number" ? t.max : 5}"></div>
        <div class="field"><label>Points per unit</label><input type="number" class="text-input" id="t-num-ppu" value="${isEdit && t.type === "number" ? t.pointsPerUnit : 10}"></div>`;
    } else {
      const opts = (isEdit && t.type === "choice" && t.options.length) ? t.options : [{ label: "Partial", points: 10 }, { label: "Full", points: 20 }];
      box.innerHTML = `<div class="field"><label>States (in addition to "not achieved" = 0 pts)</label>
        <div class="options-editor" id="t-options">${opts.map((o) => optionRowHtml(o.label, o.points)).join("")}</div>
        <button class="btn btn-ghost" id="t-add-option" type="button" style="margin-top:8px;">+ Add state</button>
      </div>`;
      document.getElementById("t-add-option").addEventListener("click", () => {
        document.getElementById("t-options").insertAdjacentHTML("beforeend", optionRowHtml("", 0));
        bindOptionRemovers();
      });
      bindOptionRemovers();
    }
  }
  function bindOptionRemovers() {
    document.querySelectorAll('[data-act="rm-option"]').forEach((btn) => { btn.onclick = () => btn.closest(".option-row").remove(); });
  }
  renderTypeFields();
  document.getElementById("t-type").addEventListener("change", renderTypeFields);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("t-name").value.trim();
    if (!name) { alert("Name this task."); return; }
    const ty = document.getElementById("t-type").value;
    const record = isEdit ? t : { id: crypto.randomUUID() };
    record.name = name; record.type = ty;
    if (ty === "bool") {
      record.points = Number(document.getElementById("t-bool-points").value) || 0;
      delete record.max; delete record.pointsPerUnit; delete record.options;
    } else if (ty === "number") {
      record.max = Number(document.getElementById("t-num-max").value) || 0;
      record.pointsPerUnit = Number(document.getElementById("t-num-ppu").value) || 0;
      delete record.points; delete record.options;
    } else {
      const rows = document.querySelectorAll("#t-options .option-row");
      record.options = Array.from(rows).map((r) => ({
        label: r.querySelector('[data-f="label"]').value.trim() || "State",
        points: Number(r.querySelector('[data-f="points"]').value) || 0,
      }));
      delete record.points; delete record.max; delete record.pointsPerUnit;
    }
    if (!isEdit) { mission.tasks.push(record); }
    await dbPut("missions", mission);
    closeModal();
    await loadMissions();
    state.expandedMissions.add(mission.id);
    renderRunGroups();
    syncToTeamDrive();
  });
}

// ---- Import missions CSV ----
const EXAMPLE_MISSIONS_CSV =
`Run,Mission,Task,Type,Points,Max,PointsPerUnit,Options
Run 1,M01 Coral Nursery,Place sample in nursery,bool,20,,,
Run 1,M01 Coral Nursery,Samples relocated,number,,4,10,
Run 1,M02 Reef Restoration,Restoration state,choice,,,,Partial:10;Full:20
Run 2,M03 Salvage Operation,Ship raised,bool,20,,,
`;

function openImportMissionsModal() {
  openModal(`
    <h2>Import missions</h2>
    <p class="empty-sub">Upload a CSV with columns <strong>Run, Mission, Task, Type, Points, Max, PointsPerUnit, Options</strong>. The Run column groups missions into leave-and-return trips (created automatically if they don't exist yet — leave it blank to use your first run). Rows sharing a Mission name are grouped together. <strong>Type</strong> is <code>bool</code>, <code>number</code>, or <code>choice</code>. For <code>choice</code> rows, put states in <strong>Options</strong> as <code>Label:Points;Label:Points</code>. Importing adds to what's already there rather than replacing it.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-example">Download example CSV</button>
      <button class="btn btn-primary" id="m-choose">Choose CSV file</button>
    </div>
  `);
  document.getElementById("m-example").addEventListener("click", () => download("missions-example.csv", EXAMPLE_MISSIONS_CSV, "text/csv"));
  document.getElementById("m-choose").addEventListener("click", () => { closeModal(); document.getElementById("file-import-missions").click(); });
}

document.getElementById("file-import-missions").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const rows = parseCSV(await file.text());
  if (!rows.length) { alert("That file looks empty."); return; }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iRun = col("run"), iMission = col("mission"), iTask = col("task"), iType = col("type"), iPoints = col("points"), iMax = col("max"), iPpu = col("pointsperunit"), iOptions = col("options");
  if (iMission === -1 || iTask === -1 || iType === -1) { alert("CSV needs at least Mission, Task, and Type columns."); return; }
  if (!state.runGroups.length) {
    const gid = crypto.randomUUID();
    await dbPut("runGroups", { id: gid, name: "", order: 0 });
    state.runGroups = await dbGetAll("runGroups");
  }
  const dataRows = rows.slice(1);
  let missionsAdded = 0, tasksAdded = 0, runsAdded = 0;
  for (const r of dataRows) {
    const missionName = (r[iMission] || "").trim();
    const taskName = (r[iTask] || "").trim();
    const type = (r[iType] || "").trim().toLowerCase();
    const runName = iRun !== -1 ? (r[iRun] || "").trim() : "";
    if (!missionName || !taskName || !["bool", "number", "choice"].includes(type)) continue;

    let group = runName ? state.runGroups.find((g) => g.name.toLowerCase() === runName.toLowerCase()) : state.runGroups[0];
    if (runName && !group) {
      const gid = crypto.randomUUID();
      await dbPut("runGroups", { id: gid, name: runName, order: state.runGroups.length });
      group = { id: gid, name: runName, order: state.runGroups.length };
      state.runGroups.push(group);
      runsAdded++;
    }

    let mission = state.missions.find((m) => m.name.toLowerCase() === missionName.toLowerCase());
    if (!mission) {
      mission = { id: crypto.randomUUID(), order: 9999, name: missionName, tasks: [], taskSeq: 0, runGroupId: group.id };
      await dbPut("missions", mission);
      state.missions.push(mission);
      missionsAdded++;
    }
    const task = { id: crypto.randomUUID(), name: taskName, type };
    if (type === "bool") task.points = Number(r[iPoints]) || 0;
    else if (type === "number") { task.max = Number(r[iMax]) || 0; task.pointsPerUnit = Number(r[iPpu]) || 0; }
    else if (type === "choice") {
      task.options = (r[iOptions] || "").split(";").map((s) => s.trim()).filter(Boolean).map((pair) => {
        const [label, pts] = pair.split(":");
        return { label: (label || "State").trim(), points: Number(pts) || 0 };
      });
    }
    mission.tasks.push(task);
    await dbPut("missions", mission);
    tasksAdded++;
  }
  await recomputeGlobalMissionOrder();
  await loadMissions();
  await loadRunGroups();
  syncToTeamDrive();
  alert(`Imported ${tasksAdded} task${tasksAdded === 1 ? "" : "s"} across ${missionsAdded} new mission${missionsAdded === 1 ? "" : "s"} and ${runsAdded} new run${runsAdded === 1 ? "" : "s"} (plus any matched into existing ones).`);
});

// ==========================================================
// GUIDED PRACTICE GAME RUNS
// ==========================================================
document.getElementById("btn-start-run").addEventListener("click", startGuidedRun);
document.getElementById("run-filter-from").addEventListener("change", renderRuns);
document.getElementById("run-filter-to").addEventListener("change", renderRuns);
document.getElementById("btn-clear-run-filter").addEventListener("click", () => {
  document.getElementById("run-filter-from").value = "";
  document.getElementById("run-filter-to").value = "";
  renderRuns();
});

// ---- Sound effects ----
// Official FLL match audio is copyrighted by FIRST, so these files aren't
// included by default — drop your own MP3s in a `sounds/` folder next to
// index.html with these exact names and they'll play automatically; if a
// file is missing, playback just silently no-ops.
const SOUND_FILES = {
  start: "sounds/start-horn.mp3",
  thirty: "sounds/thirty-seconds.mp3",
  buzzer: "sounds/buzzer.mp3",
};
// Web Audio API instead of <audio> elements: HTMLMediaElement playback has
// real, inconsistent latency (seek + decode pipeline) even after being
// "unlocked" once. Decoding every sound into an AudioBuffer up front means
// actually playing it later is just starting a buffer — effectively instant.
let audioCtx = null;
const audioBuffers = {};
function getAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}
async function preloadSound(key) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const resp = await fetch(SOUND_FILES[key]);
    if (!resp.ok) return; // file not shipped (copyrighted audio) — fine, playback just no-ops
    const arr = await resp.arrayBuffer();
    audioBuffers[key] = await ctx.decodeAudioData(arr);
  } catch (e) { /* missing/undecodable file — playSound will just no-op below */ }
}
function preloadAllSounds() { Object.keys(SOUND_FILES).forEach(preloadSound); }
function unlockAllSounds() {
  // Must be called from directly inside a click handler (a real user
  // gesture) — this is what lets the AudioContext actually produce sound on
  // iOS/Chrome's autoplay policies. Decoding already happened at load time.
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume();
}
function playSound(key) {
  const ctx = getAudioCtx();
  const buf = audioBuffers[key];
  if (!ctx || !buf) return; // missing file — silently no-op, same as before
  if (ctx.state === "suspended") ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  return src;
}
// Plays a sound and resolves once it actually finishes — using the buffer's
// real decoded duration, with a fallback timer in case the file is missing
// (the app ships without the copyrighted FLL audio by default).
function playSoundAndWait(key, fallbackMs) {
  return new Promise((resolve) => {
    const ctx = getAudioCtx();
    const buf = audioBuffers[key];
    if (!ctx || !buf) { setTimeout(resolve, fallbackMs); return; }
    if (ctx.state === "suspended") ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    src.onended = finish;
    setTimeout(finish, buf.duration * 1000 + 100); // safety net alongside onended
    src.start(0);
  });
}

// ---- Precision tokens ----
function precisionTokenWidgetHTML() {
  const remaining = state.guidedRun?.run?.precisionTokensRemaining ?? 0;
  return `<button type="button" class="precision-token-btn" id="grn-token-btn">&#129689; Precision Tokens: <span id="grn-token-count">${remaining}</span></button>`;
}
function wirePrecisionTokenButton() {
  const btn = document.getElementById("grn-token-btn");
  if (btn) btn.addEventListener("click", usePrecisionToken);
}
async function usePrecisionToken() {
  const run = state.guidedRun?.run;
  if (!run || (run.precisionTokensRemaining || 0) <= 0) return;
  run.precisionTokensRemaining -= 1;
  await dbPut("runs", run);
  const el = document.getElementById("grn-token-count");
  if (el) el.textContent = run.precisionTokensRemaining;
  const pointsEl = document.getElementById("grn-points");
  if (pointsEl) pointsEl.textContent = `${liveScoreHTML()} pts`;
  const overviewLabel = document.querySelector(".gfs-timer-label");
  if (overviewLabel && overviewLabel.textContent.includes("tokens left")) {
    overviewLabel.textContent = `${fmtDuration(run.totalTimeMs)} total time · ${run.precisionTokensRemaining} tokens left · inspection ${run.equipmentInspectionPassed ? `passed (+${EQUIPMENT_INSPECTION_BONUS})` : "not passed"} · review below or save now`;
  }
}

// ---- Helpers for navigating Run groups (legs) and their missions ----
function getLegMissions(leg) {
  return state.missions.filter((m) => m.runGroupId === leg.id).sort((a, b) => a.order - b.order);
}
// The run number is never stored — it's always derived from current order,
// so it stays correct automatically as runs get added, deleted, or reordered.
// The name field is just a nickname on top of that ("Flower", "Spinny"),
// not a replacement for it.
function runGroupNumber(g) {
  const sorted = state.runGroups.slice().sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((x) => x.id === g.id);
  return idx >= 0 ? idx + 1 : null;
}
function runGroupDisplayName(g) {
  const num = runGroupNumber(g);
  const label = num != null ? `Run ${num}` : "Run";
  return g.name ? `${label} - ${g.name}` : label;
}
function nextGameRunLabel() {
  const todayStr = new Date().toLocaleDateString();
  const todayCount = state.runs.filter((r) => new Date(r.startedAt || 0).toLocaleDateString() === todayStr).length;
  return `Game Run ${todayCount + 1}`;
}

// ---- Start flow: equipment inspection (optional), then countdown, then horn ----
let pendingEquipmentInspection = false;

async function startGuidedRun() {
  const legsWithMissions = state.runGroups.filter((g) => getLegMissions(g).some((m) => visibleTasks(m).length));
  if (!legsWithMissions.length) {
    openModal(`<h2>No missions yet</h2><p class="empty-sub">Add runs, missions, and tasks in the Settings tab first, matching the official scoresheet.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="m-close">Got it</button></div>`);
    document.getElementById("m-close").addEventListener("click", closeModal);
    return;
  }
  pendingEquipmentInspection = false;
  if (state.skipEquipmentInspectionAsk) {
    pendingEquipmentInspection = true; // not asking means it always counts as passed
    renderPreRunScreen();
  } else {
    renderEquipmentInspectionScreen();
  }
}

function renderEquipmentInspectionScreen() {
  openGuidedFullscreen(`
    <div class="gfs-header">
      <div class="guided-phase-badge">Equipment Inspection</div>
      <h2 class="gfs-mission-name">Does everything fit within the inspection area?</h2>
    </div>
    <div class="gfs-body gfs-center">
      <button type="button" class="btn btn-primary btn-full gfs-big-action gfs-huge-action" id="grn-inspection-yes">Yes</button>
      <button type="button" class="btn btn-ghost btn-full gfs-big-action" id="grn-inspection-no" style="margin-top:12px;">No</button>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn-link-cancel" id="grn-cancel-pre">Cancel</button>
    </div>
  `);
  document.getElementById("grn-cancel-pre").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("grn-inspection-yes").addEventListener("click", () => {
    pendingEquipmentInspection = true;
    unlockAllSounds(); // must happen synchronously, right here, to count as a user gesture
    runCountdown();
  });
  document.getElementById("grn-inspection-no").addEventListener("click", () => {
    pendingEquipmentInspection = false;
    unlockAllSounds();
    runCountdown();
  });
}

function renderPreRunScreen() {
  openGuidedFullscreen(`
    <div class="gfs-header">
      <div class="guided-phase-badge">Ready?</div>
      <h2 class="gfs-mission-name">New Practice Game Run</h2>
    </div>
    <div class="gfs-body gfs-center">
      <button type="button" class="btn btn-amber btn-full gfs-big-action gfs-huge-action" id="grn-start-countdown">Tap to start countdown</button>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn-link-cancel" id="grn-cancel-pre">Cancel</button>
    </div>
  `);
  document.getElementById("grn-cancel-pre").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("grn-start-countdown").addEventListener("click", () => {
    unlockAllSounds(); // must happen synchronously, right here, to count as a user gesture
    runCountdown();
  });
}

async function runCountdown() {
  const body = document.querySelector("#guided-fullscreen .gfs-body");
  const footer = document.querySelector("#guided-fullscreen .gfs-footer");
  if (footer) footer.hidden = true;
  for (const n of ["3", "2", "1"]) {
    if (body) body.innerHTML = `<div class="gfs-countdown-num">${n}</div>`;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (body) body.innerHTML = `<div class="gfs-countdown-num gfs-countdown-go">GO!</div>`;
  playSound("start");
  await new Promise((r) => setTimeout(r, 400));
  await actuallyStartRun();
}

async function actuallyStartRun() {
  const now = Date.now();
  const run = {
    id: crypto.randomUUID(),
    order: state.runs.length,
    label: nextGameRunLabel(),
    date: new Date(now).toLocaleDateString(),
    startedAt: now,
    inProgress: true,
    precisionTokensRemaining: PRECISION_TOKENS_START,
    equipmentInspectionPassed: pendingEquipmentInspection,
    rawScores: {},
    missionTimings: [],
    transitionTimings: [],
    notes: "",
  };
  await dbPut("runs", run);
  // Skip to the first leg that actually has missions with tasks.
  let legIdx = 0;
  while (legIdx < state.runGroups.length && !getLegMissions(state.runGroups[legIdx]).some((m) => visibleTasks(m).length)) legIdx++;
  state.guidedRun = {
    run,
    legIdx,
    missionIdxInLeg: 0,
    taskIdx: 0,
    matchStartTs: now,
    missionStartTs: now,
    played30: false,
    playedBuzzer: false,
    timeExpired: false,
  };
  // Interactive mode walks through missions one task at a time; non-interactive
  // goes straight to the (fully editable) overview with a live timer running
  // on it — basically a plain scoresheet with a clock, fill it in as you go.
  if (state.interactiveScoringEnabled) renderCurrentTaskScreen();
  else renderGuidedOverview();
  state.guidedRun.timerHandle = setInterval(tickGuidedTimer, 100);
  // Scheduled precisely against the match clock (not the poll interval) so
  // the 30s tone fires close to on time; the buzzer itself is triggered by
  // tickGuidedTimer's own zero-crossing check below, since that re-measures
  // real elapsed time on every tick and can't drift the way a single
  // long-duration setTimeout can over a full 2:30 span.
  scheduleGuidedAlarms(state.guidedRun);
}

// ---- Continuous match clock (one clock for the whole game run, like a real FLL match) ----
const MATCH_LENGTH_MS = 150000; // 2:30, standard FLL match length
function scheduleGuidedAlarms(gr) {
  gr.timeout30 = setTimeout(() => {
    if (state.guidedRun !== gr || gr.played30) return;
    gr.played30 = true;
    playSound("thirty");
  }, Math.max(0, 120000 - (Date.now() - gr.matchStartTs)));
  gr.timeoutBuzzer = setTimeout(() => {
    if (state.guidedRun !== gr || gr.timeExpired) return;
    handleTimeExpired();
  }, Math.max(0, MATCH_LENGTH_MS - (Date.now() - gr.matchStartTs)));
}
function currentTimerDisplay() {
  const elapsed = Date.now() - state.guidedRun.matchStartTs;
  const remaining = MATCH_LENGTH_MS - elapsed;
  if (remaining >= 0) return fmtDuration(remaining);
  if (state.keepGoingAfterBuzzer) return `+${fmtDuration(-remaining)}`;
  return fmtDuration(0);
}
function tickGuidedTimer() {
  if (!state.guidedRun) return;
  const elapsed = Date.now() - state.guidedRun.matchStartTs;
  const remaining = MATCH_LENGTH_MS - elapsed;
  const el = document.getElementById("grn-timer");
  const header = document.querySelector(".gfs-header");
  if (el) el.textContent = currentTimerDisplay();
  if (header) header.classList.toggle("header-danger", remaining <= 0);
  if (remaining <= 0 && !state.guidedRun.timeExpired) handleTimeExpired();
}
function handleTimeExpired() {
  if (!state.guidedRun || state.guidedRun.timeExpired) return;
  const gr = state.guidedRun;
  gr.timeExpired = true;
  const header = document.querySelector(".gfs-header");
  if (header) header.classList.add("header-danger");

  if (state.keepGoingAfterBuzzer) {
    // Let the user keep scoring — the timer keeps running (now counting up
    // past zero as overtime) instead of freezing the screen and forcing the
    // final overview the moment the clock hits zero.
    playSound("buzzer");
    const el = document.getElementById("grn-timer");
    if (el) el.textContent = currentTimerDisplay();
    return;
  }

  const el = document.getElementById("grn-timer");
  if (el) el.textContent = fmtDuration(0);
  // Freeze the screen — no score changes, no precision token spending —
  // until the buzzer sound actually finishes, then move on to the overview.
  const fullscreenEl = document.getElementById("guided-fullscreen");
  if (fullscreenEl) fullscreenEl.classList.add("gfs-frozen");
  playSoundAndWait("buzzer", 2000).then(async () => {
    if (state.guidedRun !== gr) return; // run was cancelled/replaced meanwhile
    stopGuidedTimer();
    const { run } = gr;
    const now = Date.now();
    run.finishedAt = now;
    run.totalTimeMs = now - gr.matchStartTs;
    await dbPut("runs", run);
    renderGuidedOverview();
  });
}
function stopGuidedTimer() {
  if (state.guidedRun?.timerHandle) clearInterval(state.guidedRun.timerHandle);
  if (state.guidedRun?.timeout30) clearTimeout(state.guidedRun.timeout30);
  if (state.guidedRun?.timeoutBuzzer) clearTimeout(state.guidedRun.timeoutBuzzer);
}
function liveTimerHTML() {
  return currentTimerDisplay();
}
function liveScoreHTML() {
  if (!state.guidedRun) return "0 / 0";
  return `${runTotal(state.guidedRun.run, state.missions)} / ${runMaxPoints(state.missions)}`;
}

function openGuidedFullscreen(html) {
  let el = document.getElementById("guided-fullscreen");
  if (!el) {
    el = document.createElement("div");
    el.id = "guided-fullscreen";
    el.className = "guided-fullscreen";
    document.body.appendChild(el);
  }
  el.classList.remove("gfs-frozen"); // never let a leftover freeze from a
  // cancelled/timed-out run block the next run's buttons
  el.innerHTML = html;
  el.hidden = false;
}
function closeGuidedFullscreen() {
  const el = document.getElementById("guided-fullscreen");
  if (el) { el.hidden = true; el.innerHTML = ""; el.classList.remove("gfs-frozen"); }
}

function cancelGuidedRunLink() {
  return `<button type="button" class="gfs-cancel-x" id="grn-cancel" title="Cancel this game run">&#10005;</button>`;
}
function gfsHeaderTopHTML(badgeText, showBack, backEnabled) {
  return `<div class="gfs-header-top">
    ${cancelGuidedRunLink()}
    ${showBack ? `<button type="button" class="gfs-back-btn" id="grn-back" ${backEnabled ? "" : "disabled"}>&#8592;</button>` : ""}
    <div class="guided-phase-badge">${badgeText}</div>
  </div>`;
}
function wireCancelLink() {
  document.getElementById("grn-cancel").addEventListener("click", async () => {
    if (!confirm("Cancel and discard this practice game run?")) return;
    stopGuidedTimer();
    await dbDelete("runs", state.guidedRun.run.id);
    state.guidedRun = null;
    closeGuidedFullscreen();
    await loadRuns();
  });
}

// A task counts as "complete" once it has any score entered — not
// necessarily full points.
function isTaskComplete(t, raw) {
  const v = raw[t.id];
  if (t.type === "bool") return !!v;
  if (t.type === "number") return (Number(v) || 0) > 0;
  return v !== null && v !== undefined && v !== "";
}

// Small row-style task display, used only by the editable Final Overview
// (where you see every task in every mission at once, not one at a time).
function taskRowHTML(t, raw) {
  const max = taskMaxPoints(t);
  if (t.type === "bool") {
    const on = !!raw[t.id];
    return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="bool">
      <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${on ? max : 0} / ${max}</span></span>
      <div class="gfs-choice-strip">
        <button type="button" class="gfs-choice-btn${on ? " active" : ""}" data-tid="${t.id}" data-val="yes">Yes</button>
        <button type="button" class="gfs-choice-btn${!on ? " active" : ""}" data-tid="${t.id}" data-val="no">No</button>
      </div>
    </div>`;
  }
  if (t.type === "number") {
    const val = raw[t.id] ?? 0;
    const btns = Array.from({ length: (t.max || 0) + 1 }, (_, i) =>
      `<button type="button" class="gfs-num-btn${val === i ? " active" : ""}" data-tid="${t.id}" data-val="${i}">${i}</button>`
    ).join("");
    return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="number">
      <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${pointsFromRawTask(t, val)} / ${max}</span></span>
      <div class="gfs-num-strip">${btns}</div>
    </div>`;
  }
  const cur = raw[t.id] ?? "";
  const btns = [`<button type="button" class="gfs-choice-btn${cur === "" ? " active" : ""}" data-tid="${t.id}" data-val="">Not achieved</button>`]
    .concat((t.options || []).map((o, i) => `<button type="button" class="gfs-choice-btn${String(cur) === String(i) ? " active" : ""}" data-tid="${t.id}" data-val="${i}">${esc(o.label)}</button>`))
    .join("");
  return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="choice">
    <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${pointsFromRawTask(t, cur)} / ${max}</span></span>
    <div class="gfs-choice-strip">${btns}</div>
  </div>`;
}

// ---- One task at a time, tap-to-advance, with a back arrow. Auto-advances
// through every mission in the current run before asking for "Robot returned". ----
function renderCurrentTaskScreen() {
  const { run, legIdx, missionIdxInLeg, taskIdx } = state.guidedRun;
  const leg = state.runGroups[legIdx];
  const legMissions = getLegMissions(leg);
  const mission = legMissions[missionIdxInLeg];
  const tasks = visibleTasks(mission);
  if (taskIdx >= tasks.length) {
    finishCurrentMission(leg, legMissions);
    return;
  }
  const task = tasks[taskIdx];
  const raw = run.rawScores;
  let controlHTML;
  if (task.type === "bool") {
    controlHTML = `
      <button type="button" class="gfs-big-choice gfs-big-complete" id="gfs-mark-complete">Complete</button>
      <button type="button" class="gfs-big-choice gfs-big-incomplete" id="gfs-mark-incomplete">Incomplete</button>
    `;
  } else if (task.type === "number") {
    const val = raw[task.id] ?? 0;
    controlHTML = `<div class="gfs-num-strip gfs-num-strip-big">${Array.from({ length: (task.max || 0) + 1 }, (_, i) =>
      `<button type="button" class="gfs-num-btn gfs-num-btn-big${val === i ? (i === 0 ? " active-zero" : " active") : ""}" data-val="${i}">${i}</button>`
    ).join("")}</div>`;
  } else {
    const cur = raw[task.id] ?? "";
    controlHTML = `<div class="gfs-choice-strip gfs-choice-strip-big">
      <button type="button" class="gfs-choice-btn gfs-choice-btn-big${cur === "" ? " active-zero" : ""}" data-val="">Not achieved</button>
      ${(task.options || []).map((o, i) => `<button type="button" class="gfs-choice-btn gfs-choice-btn-big${String(cur) === String(i) ? " active" : ""}" data-val="${i}">${esc(o.label)}</button>`).join("")}
    </div>`;
  }

  const canGoBack = taskIdx > 0 || missionIdxInLeg > 0;
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${gfsHeaderTopHTML(esc(runGroupDisplayName(leg)), true, canGoBack)}
      ${precisionTokenWidgetHTML()}
      <h2 class="gfs-mission-name">${esc(mission.name)}</h2>
      <div class="gfs-timer-row">
        <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
        <div class="gfs-points" id="grn-points">${liveScoreHTML()} pts</div>
      </div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="gfs-task-prompt">${esc(task.name)} <span class="gfs-task-pts">/ ${taskMaxPoints(task)} pts</span></p>
      ${controlHTML}
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    if (state.guidedRun.taskIdx > 0) {
      state.guidedRun.taskIdx--;
    } else if (state.guidedRun.missionIdxInLeg > 0) {
      state.guidedRun.missionIdxInLeg--;
      const prevMission = legMissions[state.guidedRun.missionIdxInLeg];
      state.guidedRun.taskIdx = Math.max(0, visibleTasks(prevMission).length - 1);
    } else {
      return;
    }
    renderCurrentTaskScreen();
  });

  if (task.type === "bool") {
    document.getElementById("gfs-mark-complete").addEventListener("click", () => { raw[task.id] = true; advanceTask(); });
    document.getElementById("gfs-mark-incomplete").addEventListener("click", () => { raw[task.id] = false; advanceTask(); });
  } else if (task.type === "number") {
    document.querySelectorAll(".gfs-num-btn-big").forEach((btn) => {
      btn.addEventListener("click", () => { raw[task.id] = Number(btn.dataset.val); advanceTask(); });
    });
  } else {
    document.querySelectorAll(".gfs-choice-btn-big").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.val;
        raw[task.id] = v === "" ? null : Number(v);
        advanceTask();
      });
    });
  }
}
function advanceTask() {
  state.guidedRun.taskIdx++;
  renderCurrentTaskScreen();
}

async function finishCurrentMission(leg, legMissions) {
  const { run, missionIdxInLeg } = state.guidedRun;
  const mission = legMissions[missionIdxInLeg];
  const now = Date.now();
  const durationMs = now - state.guidedRun.missionStartTs;
  run.missionTimings.push({ missionId: mission.id, missionName: mission.name, runGroupId: leg.id, runGroupName: leg.name, startTs: state.guidedRun.missionStartTs, endTs: now, durationMs });
  await dbPut("runs", run);
  if (missionIdxInLeg < legMissions.length - 1) {
    state.guidedRun.missionIdxInLeg++;
    state.guidedRun.taskIdx = 0;
    state.guidedRun.missionStartTs = now;
    renderCurrentTaskScreen();
  } else {
    renderRobotReturnedScreen();
  }
}

function renderRobotReturnedScreen() {
  const { legIdx } = state.guidedRun;
  const leg = state.runGroups[legIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${gfsHeaderTopHTML(esc(runGroupDisplayName(leg)), true, true)}
      ${precisionTokenWidgetHTML()}
      <h2 class="gfs-mission-name">All missions done for this run</h2>
      <div class="gfs-timer-row">
        <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
        <div class="gfs-points" id="grn-points">${liveScoreHTML()} pts</div>
      </div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">Every mission in "${esc(runGroupDisplayName(leg))}" is marked.</p>
      <button type="button" class="btn btn-primary btn-full gfs-big-action gfs-huge-action" id="grn-done">Robot returned</button>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    const legMissions = getLegMissions(leg);
    state.guidedRun.missionIdxInLeg = legMissions.length - 1;
    state.guidedRun.taskIdx = Math.max(0, visibleTasks(legMissions[legMissions.length - 1]).length - 1);
    renderCurrentTaskScreen();
  });
  document.getElementById("grn-done").addEventListener("click", async () => {
    const { run, legIdx } = state.guidedRun;
    const now = Date.now();
    // Find the next leg (in run-group order) that actually has scoreable missions.
    let nextLegIdx = legIdx + 1;
    while (nextLegIdx < state.runGroups.length && !getLegMissions(state.runGroups[nextLegIdx]).some((m) => visibleTasks(m).length)) nextLegIdx++;
    if (nextLegIdx >= state.runGroups.length) {
      stopGuidedTimer();
      run.finishedAt = now;
      run.totalTimeMs = now - state.guidedRun.matchStartTs;
      await dbPut("runs", run);
      renderGuidedOverview();
    } else {
      state.guidedRun.legIdx = nextLegIdx;
      state.guidedRun.missionIdxInLeg = 0;
      state.guidedRun.taskIdx = 0;
      state.guidedRun.transitionStartTs = now;
      renderGuidedTransitionPhase();
    }
  });
}

function renderGuidedTransitionPhase() {
  const { legIdx } = state.guidedRun;
  const nextLeg = state.runGroups[legIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${gfsHeaderTopHTML("Transition", false, false)}
      ${precisionTokenWidgetHTML()}
      <h2 class="gfs-mission-name">Heading to: ${esc(runGroupDisplayName(nextLeg))}</h2>
      <div class="gfs-timer-row">
        <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
        <div class="gfs-points" id="grn-points">${liveScoreHTML()} pts</div>
      </div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">Tap when the robot leaves base for the next run.</p>
      <button type="button" class="btn btn-amber btn-full gfs-big-action gfs-huge-action" id="grn-leave">Robot leaves for next run</button>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-leave").addEventListener("click", () => {
    const now = Date.now();
    const durationMs = now - state.guidedRun.transitionStartTs;
    state.guidedRun.run.transitionTimings.push({ beforeRunGroupId: nextLeg.id, durationMs });
    state.guidedRun.missionStartTs = now;
    renderCurrentTaskScreen();
  });
}

function renderGuidedOverview() {
  const { run } = state.guidedRun;
  const isLive = !run.finishedAt; // non-interactive mode reaches this screen while the clock is still running
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${gfsHeaderTopHTML(isLive ? "Scoring" : "Final overview", false, false)}
      <h2 class="gfs-mission-name">${esc(run.label)}</h2>
      ${isLive ? `
        <div class="gfs-timer-row" style="justify-content:center; gap:24px;">
          <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
          <div class="gfs-timer" id="gfs-overview-total">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</div>
        </div>
        <div class="gfs-timer-label">time left &middot; score &middot; fill in scores below as you go</div>
      ` : `
        <div class="gfs-timer" id="gfs-overview-total">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</div>
        <div class="gfs-timer-label">${fmtDuration(run.totalTimeMs)} total time &middot; review below or save now</div>
      `}
      <button class="btn btn-primary btn-full" id="grn-save-top" type="button" style="margin-top:12px;">&#10003; Save &amp; Finish</button>
    </div>
    <div class="gfs-body" id="gfs-overview-body"></div>
    <div class="gfs-footer">
      <button class="btn btn-primary btn-full" id="grn-save-bottom" type="button">Save &amp; Finish</button>
    </div>
  `);
  renderOverviewBody();
  wireCancelLink();
  document.getElementById("grn-save-top").addEventListener("click", finalizeGuidedRun);
  document.getElementById("grn-save-bottom").addEventListener("click", finalizeGuidedRun);
}

function renderOverviewBody() {
  const { run } = state.guidedRun;
  const body = document.getElementById("gfs-overview-body");
  const inspectionOn = !!run.equipmentInspectionPassed;
  const tokensLeft = run.precisionTokensRemaining ?? 0;
  const bonusHTML = `<div class="gfs-section">
    <h3>Bonuses</h3>
    <div class="gfs-task-row gfs-task-row-wrap">
      <span class="gfs-task-name">Equipment Inspection <span class="gfs-task-pts">${inspectionOn ? EQUIPMENT_INSPECTION_BONUS : 0} / ${EQUIPMENT_INSPECTION_BONUS}</span></span>
      <div class="gfs-choice-strip">
        <button type="button" class="gfs-choice-btn${inspectionOn ? " active" : ""}" data-special="inspection" data-val="yes">Yes</button>
        <button type="button" class="gfs-choice-btn${!inspectionOn ? " active" : ""}" data-special="inspection" data-val="no">No</button>
      </div>
    </div>
    <div class="gfs-task-row gfs-task-row-wrap">
      <span class="gfs-task-name">Precision Tokens Left <span class="gfs-task-pts">+${precisionTokenBonus(tokensLeft)} pts</span></span>
      <div class="gfs-num-strip">${Array.from({ length: 7 }, (_, i) =>
        `<button type="button" class="gfs-num-btn${tokensLeft === i ? " active" : ""}" data-special="tokens" data-val="${i}">${i}</button>`
      ).join("")}</div>
    </div>
  </div>`;
  body.innerHTML = bonusHTML + state.runGroups.map((leg) => {
    const legMissions = getLegMissions(leg);
    const missionsHTML = legMissions.map((m) => {
      const score = missionScoreForRun(m, run);
      const max = missionMaxPoints(m);
      const timing = (run.missionTimings || []).find((t) => t.missionId === m.id);
      const rows = visibleTasks(m).map((t) => taskRowHTML(t, run.rawScores)).join("") || `<p class="empty-sub">No tasks.</p>`;
      return `<div class="gfs-subsection">
        <h4>${esc(m.name)} <span class="gfs-task-pts">${score} / ${max}${timing ? ` &middot; ${fmtDuration(timing.durationMs)}` : ""}</span></h4>
        <div class="gfs-task-list">${rows}</div>
      </div>`;
    }).join("");
    return `<div class="gfs-section">
      <h3>${esc(runGroupDisplayName(leg))}</h3>
      ${missionsHTML || `<p class="empty-sub">No missions in this run.</p>`}
    </div>`;
  }).join("");
  bindOverviewEvents();
  updateOverviewTotal();
}

function bindOverviewEvents() {
  document.querySelectorAll('#gfs-overview-body [data-special="inspection"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.equipmentInspectionPassed = btn.dataset.val === "yes";
      renderOverviewBody();
    });
  });
  document.querySelectorAll('#gfs-overview-body [data-special="tokens"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.precisionTokensRemaining = Number(btn.dataset.val);
      renderOverviewBody();
    });
  });
  document.querySelectorAll('#gfs-overview-body [data-type="bool"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.rawScores[btn.dataset.tid] = btn.dataset.val === "yes";
      renderOverviewBody();
    });
  });
  document.querySelectorAll("#gfs-overview-body .gfs-num-btn:not([data-special])").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.rawScores[btn.dataset.tid] = Number(btn.dataset.val);
      renderOverviewBody();
    });
  });
  document.querySelectorAll('#gfs-overview-body [data-type="choice"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.val;
      state.guidedRun.run.rawScores[btn.dataset.tid] = v === "" ? null : Number(v);
      renderOverviewBody();
    });
  });
}

function updateOverviewTotal() {
  const el = document.getElementById("gfs-overview-total");
  if (el) el.textContent = `${runTotal(state.guidedRun.run, state.missions)} / ${runMaxPoints(state.missions)}`;
}

async function finalizeGuidedRun() {
  stopGuidedTimer();
  const { run } = state.guidedRun;
  if (!run.finishedAt) {
    const now = Date.now();
    run.finishedAt = now;
    run.totalTimeMs = now - state.guidedRun.matchStartTs;
  }
  run.inProgress = false;
  await dbPut("runs", run);
  state.guidedRun = null;
  closeGuidedFullscreen();
  await loadRuns();
  syncToTeamDrive();
}
// ---- Saved game runs / analysis ----
async function loadRuns() {
  state.runs = (await dbGetAll("runs")).filter((r) => !r.deleted).sort((a, b) => a.order - b.order);
  renderRuns();
}
async function restoreDeletedRun(id) {
  const run = await dbGet("runs", id);
  if (!run) return;
  delete run.deleted;
  delete run.deletedAt;
  await dbPut("runs", run);
  await loadRuns();
  syncToTeamDrive();
}
async function restoreDeletedEntry(entry) {
  delete entry.deleted;
  delete entry.deletedAt;
  delete entry.deletedWithAttachmentId;
  await dbPut("entries", entry);
  renderAttachmentChips();
  await renderEntryList();
  await renderIterationTotal();
  renderAttachmentsSetup();
  syncToTeamDrive();
}

// ---- Recently Deleted (cloud-restorable trash) ----
// Every delete in this app is a soft delete now — this is the "later" undo,
// separate from and longer-lived than the immediate 8-second toast: restore
// any specific item, any time, not just right after deleting it.
async function openRecentlyDeletedModal() {
  const [allAttachments, allEntries, allRunGroups, allMissions, allRuns] = await Promise.all([
    dbGetAll("attachments"), dbGetAll("entries"), dbGetAll("runGroups"), dbGetAll("missions"), dbGetAll("runs"),
  ]);
  const deletedAttachments = allAttachments.filter((a) => a.deleted);
  const deletedEntries = allEntries.filter((e) => e.deleted);
  const deletedRunGroups = allRunGroups.filter((g) => g.deleted);
  const deletedMissions = allMissions.filter((m) => m.deleted);
  const deletedTasks = [];
  allMissions.forEach((m) => { (m.tasks || []).forEach((t) => { if (t.deleted) deletedTasks.push({ mission: m, task: t }); }); });
  const deletedRuns = allRuns.filter((r) => r.deleted);
  const totalCount = deletedAttachments.length + deletedEntries.length + deletedRunGroups.length + deletedMissions.length + deletedTasks.length + deletedRuns.length;

  openModal(`
    <h2>Recently Deleted</h2>
    ${totalCount === 0 ? `<p class="empty-sub">Nothing deleted.</p>` : `<div id="rd-sections"></div>`}
    <div class="modal-actions"><button class="btn btn-ghost btn-full" id="m-close" type="button">Close</button></div>
  `);
  document.getElementById("m-close").addEventListener("click", closeModal);
  if (totalCount === 0) return;
  const container = document.getElementById("rd-sections");

  function addSection(title, items, nameFn, deletedAtFn, onRestore) {
    if (!items.length) return;
    const section = document.createElement("div");
    section.className = "gfs-section";
    section.innerHTML = `<h3>${esc(title)}</h3>`;
    const list = document.createElement("div");
    list.className = "mission-list";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "mission-row";
      row.innerHTML = `
        <div class="m-info">
          <div class="m-name">${esc(nameFn(item))}</div>
          <div class="m-sub">Deleted ${new Date(deletedAtFn(item)).toLocaleString()}</div>
        </div>
        <button class="btn btn-ghost">Restore</button>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        await onRestore(item);
        closeModal();
        openRecentlyDeletedModal();
      });
      list.appendChild(row);
    });
    section.appendChild(list);
    container.appendChild(section);
  }

  addSection("Attachments", deletedAttachments, (a) => a.name, (a) => a.deletedAt, (a) => restoreDeletedAttachment(a.id));
  addSection("Log entries", deletedEntries, (e) => e.whatChanged || e.whyChanged || "Entry", (e) => e.deletedAt, (e) => restoreDeletedEntry(e));
  addSection("Runs (leg groups)", deletedRunGroups, (g) => g.name, (g) => g.deletedAt, (g) => restoreDeletedRunGroup(g.id));
  addSection("Missions", deletedMissions, (m) => m.name, (m) => m.deletedAt, (m) => restoreDeletedMission(m.id));
  addSection("Tasks", deletedTasks, ({ mission, task }) => `${task.name} (in ${mission.name})`, ({ task }) => task.deletedAt, ({ mission, task }) => restoreDeletedTask(mission.id, task.id));
  addSection("Game runs", deletedRuns, (r) => r.label, (r) => r.deletedAt, (r) => restoreDeletedRun(r.id));
}

function getRunDateFilterRange() {
  const fromVal = document.getElementById("run-filter-from")?.value;
  const toVal = document.getElementById("run-filter-to")?.value;
  return {
    from: fromVal ? new Date(fromVal).getTime() : -Infinity,
    to: toVal ? new Date(toVal).getTime() : Infinity,
  };
}

function renderRuns() {
  const list = document.getElementById("run-list");
  const stats = document.getElementById("run-stats");
  list.innerHTML = "";
  const allCompleted = state.runs.filter((r) => !r.inProgress);
  const incomplete = state.runs.filter((r) => r.inProgress);
  const { from, to } = getRunDateFilterRange();
  const completed = allCompleted.filter((r) => { const t = r.startedAt || 0; return t >= from && t <= to; });

  if (!allCompleted.length && !incomplete.length) {
    list.innerHTML = `<p class="empty-sub">No practice game runs yet. Click Start New Practice Game Run to begin tracking your progress.</p>`;
    stats.innerHTML = "";
    return;
  }
  if (!completed.length) {
    list.innerHTML = `<p class="empty-sub">No completed game runs in that date range.</p>`;
  }

  if (completed.length) {
    const totals = completed.map((r) => runTotal(r, state.missions));
    const best = Math.max(...totals);
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const avgGameTime = completed.reduce((s, r) => s + (r.totalTimeMs || 0), 0) / completed.length;
    stats.innerHTML = `
      <div class="stat-box"><span class="stat-num">${best}</span><span class="stat-label">Best score</span></div>
      <div class="stat-box"><span class="stat-num">${avg.toFixed(1)}</span><span class="stat-label">Avg score</span></div>
      <div class="stat-box"><span class="stat-num">${fmtDuration(avgGameTime)}</span><span class="stat-label">Avg game time</span></div>
    `;
  } else {
    stats.innerHTML = "";
  }

  incomplete.forEach((run) => {
    const card = document.createElement("div");
    card.className = "run-card run-card-incomplete";
    card.innerHTML = `
      <div class="rc-row">
        <div class="rc-title-block">
          <div class="run-title">${esc(run.label)}</div>
          <div class="run-date">incomplete run</div>
        </div>
        <button class="btn-icon rc-icon-btn" data-act="del" title="Delete">&#128465;&#65039;</button>
      </div>
    `;
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`Delete incomplete game run "${run.label}"?`)) return;
      run.deleted = true;
      run.deletedAt = Date.now();
      await dbPut("runs", run);
      await loadRuns();
      syncToTeamDrive();
      showUndoToast(`Deleted "${run.label}".`, async () => {
        await restoreDeletedRun(run.id);
      });
    });
    list.appendChild(card);
  });

  completed.slice().reverse().forEach((run) => {
    const total = runTotal(run, state.missions);
    const maxTotal = runMaxPoints(state.missions);
    const avgOp = breakdownAvgOpTime(run);
    const card = document.createElement("div");
    card.className = "run-card";
    card.innerHTML = `
      <div class="rc-row">
        <div class="rc-title-block">
          <div class="run-title">${esc(run.label)}</div>
          <div class="run-date">${esc(run.date || "")}</div>
        </div>
        <div class="rc-stat"><span class="rc-stat-val">${total}/${maxTotal}</span><span class="rc-stat-label">pts</span></div>
        <div class="rc-stat"><span class="rc-stat-val">${fmtDuration(run.totalTimeMs || 0)}</span><span class="rc-stat-label">time</span></div>
        <div class="rc-stat"><span class="rc-stat-val">${avgOp !== null ? fmtDuration(avgOp) : "&mdash;"}</span><span class="rc-stat-label">avg op</span></div>
        <button class="btn-icon rc-icon-btn" data-act="view" title="View breakdown">&#128065;&#65039;</button>
        <button class="btn-icon rc-icon-btn" data-act="del" title="Delete">&#128465;&#65039;</button>
      </div>
    `;
    card.querySelector('[data-act="view"]').addEventListener("click", () => renderRunBreakdown(run));
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (!confirm(`Delete game run "${run.label}"?`)) return;
      run.deleted = true;
      run.deletedAt = Date.now();
      await dbPut("runs", run);
      await loadRuns();
      syncToTeamDrive();
      showUndoToast(`Deleted "${run.label}".`, async () => {
        await restoreDeletedRun(run.id);
      });
    });
    list.appendChild(card);
  });
}

function breakdownAvgOpTime(run) {
  const transitions = run.transitionTimings || [];
  if (!transitions.length) return null;
  return transitions.reduce((s, t) => s + t.durationMs, 0) / transitions.length;
}
function renderRunBreakdown(run) {
  state.breakdown = { run, editing: false, tab: "scores" };
  const avgOp = breakdownAvgOpTime(run);
  openGuidedFullscreen(`
    <div class="gfs-header">
      <div class="gfs-header-top">
        <button type="button" class="gfs-back-btn" id="brk-back">&#8592;</button>
        <button type="button" class="brk-edit-icon-btn" id="brk-edit-btn">&#9998;&#65039; Edit</button>
        <div class="guided-phase-badge">${esc(run.label)}</div>
      </div>
      <div class="gfs-timer" id="brk-total">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</div>
      <div class="gfs-timer-label">${fmtDuration(run.totalTimeMs || 0)} total time &middot; avg operation time ${avgOp !== null ? fmtDuration(avgOp) : "&mdash;"}</div>
      <div class="brk-tabs">
        <button type="button" class="brk-tab-btn" data-tab="scores">Scores</button>
        <button type="button" class="brk-tab-btn" data-tab="timing">Timing</button>
      </div>
    </div>
    <div class="gfs-body" id="brk-body"></div>
    <div class="gfs-footer">
      <button type="button" class="btn btn-primary btn-full" id="brk-close-btn">Close</button>
    </div>
  `);
  document.getElementById("brk-back").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("brk-close-btn").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("brk-edit-btn").addEventListener("click", async () => {
    const b = state.breakdown;
    if (b.editing) {
      await dbPut("runs", b.run);
      await loadRuns();
      syncToTeamDrive();
    }
    b.editing = !b.editing;
    renderBreakdownTabs();
  });
  renderBreakdownTabs();
}

function renderBreakdownTabs() {
  const b = state.breakdown;
  document.querySelectorAll(".brk-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === b.tab);
    btn.onclick = () => { b.tab = btn.dataset.tab; renderBreakdownTabs(); };
  });
  const editBtn = document.getElementById("brk-edit-btn");
  if (editBtn) {
    editBtn.hidden = b.tab !== "scores";
    editBtn.innerHTML = b.editing ? "&#10003; Save" : "&#9998;&#65039; Edit";
  }
  if (b.tab === "scores") renderBreakdownScoresTab();
  else renderBreakdownTimingTab();
}

function renderBreakdownScoresTab() {
  const { run, editing } = state.breakdown;
  const body = document.getElementById("brk-body");
  const inspectionOn = !!run.equipmentInspectionPassed;
  const tokensLeft = run.precisionTokensRemaining ?? 0;
  const bonusHTML = `<div class="gfs-section">
    <h3>Bonuses</h3>
    <div class="gfs-task-row gfs-task-row-wrap">
      <span class="gfs-task-name">Equipment Inspection <span class="gfs-task-pts">${inspectionOn ? EQUIPMENT_INSPECTION_BONUS : 0} / ${EQUIPMENT_INSPECTION_BONUS}</span></span>
      <div class="gfs-choice-strip">
        <button type="button" class="gfs-choice-btn${inspectionOn ? " active" : ""}" data-special="inspection" data-val="yes">Yes</button>
        <button type="button" class="gfs-choice-btn${!inspectionOn ? " active" : ""}" data-special="inspection" data-val="no">No</button>
      </div>
    </div>
    <div class="gfs-task-row gfs-task-row-wrap">
      <span class="gfs-task-name">Precision Tokens Left <span class="gfs-task-pts">+${precisionTokenBonus(tokensLeft)} pts</span></span>
      <div class="gfs-num-strip">${Array.from({ length: 7 }, (_, i) =>
        `<button type="button" class="gfs-num-btn${tokensLeft === i ? " active" : ""}" data-special="tokens" data-val="${i}">${i}</button>`
      ).join("")}</div>
    </div>
  </div>`;
  const sectionsHTML = state.runGroups.map((leg) => {
    const legMissions = getLegMissions(leg);
    const missionsHTML = legMissions.map((m) => {
      const score = missionScoreForRun(m, run);
      const max = missionMaxPoints(m);
      const timing = (run.missionTimings || []).find((t) => t.missionId === m.id);
      const rows = visibleTasks(m).map((t) => taskRowHTML(t, run.rawScores || {})).join("") || `<p class="empty-sub">No tasks.</p>`;
      return `<div class="gfs-subsection">
        <h4>${esc(m.name)} <span class="gfs-task-pts">${score} / ${max}${timing ? ` &middot; ${fmtDuration(timing.durationMs)}` : ""}</span></h4>
        <div class="gfs-task-list">${rows}</div>
      </div>`;
    }).join("");
    return `<div class="gfs-section">
      <h3>${esc(runGroupDisplayName(leg))}</h3>
      ${missionsHTML || `<p class="empty-sub">No missions in this run.</p>`}
    </div>`;
  }).join("");
  body.className = "gfs-body" + (editing ? "" : " brk-readonly");
  body.innerHTML = bonusHTML + sectionsHTML;
  if (editing) bindBreakdownEditEvents();
}

function bindBreakdownEditEvents() {
  const { run } = state.breakdown;
  document.querySelectorAll('#brk-body [data-special="inspection"]').forEach((btn) => {
    btn.addEventListener("click", () => { run.equipmentInspectionPassed = btn.dataset.val === "yes"; renderBreakdownScoresTab(); refreshBreakdownTotal(); });
  });
  document.querySelectorAll('#brk-body [data-special="tokens"]').forEach((btn) => {
    btn.addEventListener("click", () => { run.precisionTokensRemaining = Number(btn.dataset.val); renderBreakdownScoresTab(); refreshBreakdownTotal(); });
  });
  document.querySelectorAll('#brk-body [data-type="bool"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => { run.rawScores[btn.dataset.tid] = btn.dataset.val === "yes"; renderBreakdownScoresTab(); refreshBreakdownTotal(); });
  });
  document.querySelectorAll("#brk-body .gfs-num-btn:not([data-special])").forEach((btn) => {
    btn.addEventListener("click", () => { run.rawScores[btn.dataset.tid] = Number(btn.dataset.val); renderBreakdownScoresTab(); refreshBreakdownTotal(); });
  });
  document.querySelectorAll('#brk-body [data-type="choice"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.val;
      run.rawScores[btn.dataset.tid] = v === "" ? null : Number(v);
      renderBreakdownScoresTab();
      refreshBreakdownTotal();
    });
  });
}
function refreshBreakdownTotal() {
  const { run } = state.breakdown;
  const el = document.getElementById("brk-total");
  if (el) el.textContent = `${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}`;
}

function renderBreakdownTimingTab() {
  const { run } = state.breakdown;
  const body = document.getElementById("brk-body");
  const missionTimings = run.missionTimings || [];
  const transitions = run.transitionTimings || [];
  let html = "";
  let transIdx = 0;
  let lastGroupId;
  let groupRows = "";
  let groupTotal = 0;
  let groupName = "";
  const flushGroup = () => {
    if (!groupName) return;
    html += `<div class="gfs-section">
      <h3>${esc(groupName)} <span class="gfs-task-pts">${fmtDuration(groupTotal)}</span></h3>
      <div class="gfs-task-list">${groupRows}</div>
    </div>`;
  };
  missionTimings.forEach((mt) => {
    if (lastGroupId !== undefined && mt.runGroupId !== lastGroupId) {
      flushGroup();
      if (transitions[transIdx]) {
        html += `<p class="empty-sub brk-transition-row">Operation time: ${fmtDuration(transitions[transIdx].durationMs)}</p>`;
        transIdx++;
      }
      groupRows = "";
      groupTotal = 0;
    }
    groupName = mt.runGroupName;
    groupTotal += mt.durationMs;
    groupRows += `<div class="gfs-task-row"><span class="gfs-task-name">${esc(mt.missionName)}</span><span class="gfs-task-pts">${fmtDuration(mt.durationMs)}</span></div>`;
    lastGroupId = mt.runGroupId;
  });
  flushGroup();
  const avgOpTime = transitions.length ? transitions.reduce((s, t) => s + t.durationMs, 0) / transitions.length : 0;
  body.className = "gfs-body";
  body.innerHTML = `<p class="empty-sub">Avg operation time: ${transitions.length ? fmtDuration(avgOpTime) : "—"}</p>`
    + (html || `<p class="empty-sub">No timing data recorded for this run.</p>`);
}

// ==========================================================
// ANALYSIS TAB — across every completed run, not just one
// ==========================================================
state.analysis = { subTab: "trend", expandedMissionIds: new Set() };

function renderAnalysisTab() {
  document.querySelectorAll(".analysis-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.analysis.subTab);
    btn.onclick = () => { state.analysis.subTab = btn.dataset.tab; renderAnalysisTab(); };
  });
  const trendBody = document.getElementById("analysis-trend-body");
  const missionsBody = document.getElementById("analysis-missions-body");
  if (state.analysis.subTab === "trend") {
    trendBody.hidden = false;
    missionsBody.hidden = true;
    renderScoreTrendChart();
  } else {
    trendBody.hidden = true;
    missionsBody.hidden = false;
    renderMissionsAnalysisTable();
  }
}

function fmtPct(x) { return x == null ? "—" : `${Math.round(x * 100)}%`; }
function fmtPPS(x) { return x == null ? "—" : x.toFixed(2); }

// A task/mission's "success rate" is its average earned points as a percent
// of max — this handles partial-credit tasks (number/choice) properly, not
// just plain achieved/not-achieved.
function computeMissionAnalytics() {
  const completed = state.runs.filter((r) => !r.inProgress);
  return state.missions.map((m) => {
    const max = missionMaxPoints(m);
    const scores = completed.map((r) => missionScoreForRun(m, r));
    const successRate = max > 0 && completed.length ? (scores.reduce((a, b) => a + b, 0) / completed.length) / max : null;
    const timings = completed.flatMap((r) => (r.missionTimings || []).filter((t) => t.missionId === m.id).map((t) => t.durationMs));
    const avgTimeMs = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;
    const avgPoints = completed.length ? scores.reduce((a, b) => a + b, 0) / completed.length : null;
    const pointsPerSec = avgTimeMs && avgPoints != null ? avgPoints / (avgTimeMs / 1000) : null;
    return { mission: m, successRate, avgTimeMs, pointsPerSec, order: m.order };
  });
}
function computeTaskAnalytics(mission) {
  const completed = state.runs.filter((r) => !r.inProgress);
  return visibleTasks(mission).map((t, idx) => {
    const max = taskMaxPoints(t);
    const scores = completed.map((r) => pointsFromRawTask(t, (r.rawScores || {})[t.id]));
    const successRate = max > 0 && completed.length ? (scores.reduce((a, b) => a + b, 0) / completed.length) / max : null;
    return { task: t, successRate, order: idx };
  });
}

function renderScoreTrendChart() {
  const container = document.getElementById("analysis-trend-body");
  const completed = state.runs.filter((r) => !r.inProgress).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (completed.length < 2) {
    container.innerHTML = `<p class="empty-sub">Need at least 2 completed game runs to show a trend.</p>`;
    return;
  }
  const scores = completed.map((r) => runTotal(r, state.missions));
  const maxScore = Math.max(...scores, 1);
  const W = 340, H = 200, padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const stepX = scores.length > 1 ? plotW / (scores.length - 1) : 0;
  const points = scores.map((s, i) => [padL + i * stepX, padT + plotH - (s / maxScore) * plotH]);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const dots = points.map((p, i) =>
    `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="var(--moss)" stroke="var(--paper)" stroke-width="1.5"><title>${esc(completed[i].label)}: ${scores[i]} pts</title></circle>`
  ).join("");
  const gridFracs = [0, 0.5, 1];
  const gridLines = gridFracs.map((f) => {
    const y = padT + plotH - f * plotH;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
  }).join("");
  const gridLabels = gridFracs.map((f) => {
    const y = padT + plotH - f * plotH;
    return `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--text-soft)">${Math.round(maxScore * f)}</text>`;
  }).join("");
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block;">
      ${gridLines}${gridLabels}
      <path d="${pathD}" fill="none" stroke="var(--moss)" stroke-width="2.5"/>
      ${dots}
    </svg>
    <p class="empty-sub" style="text-align:center;">${completed.length} completed runs &middot; tap a point for details</p>
  `;
}

// Same red-yellow-green palette as the XLSX export's conditional formatting,
// so the in-app view and the exported spreadsheet read the same way.
function heatColor(t) {
  t = t == null ? 0.5 : Math.max(0, Math.min(1, t));
  const red = [0xF8, 0x69, 0x6B], yellow = [0xFF, 0xEB, 0x84], green = [0x63, 0xBE, 0x7B];
  const [c1, c2, localT] = t < 0.5 ? [red, yellow, t / 0.5] : [yellow, green, (t - 0.5) / 0.5];
  const mix = (i) => Math.round(c1[i] + (c2[i] - c1[i]) * localT);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}
// Normalizes a value to 0 (worst) - 1 (best) relative to the min/max across
// every mission (or task) being shown — "invert" is for stats where lower is
// actually better (time taken).
function heatFrac(value, values, invert) {
  if (value == null) return null;
  const real = values.filter((v) => v != null);
  if (!real.length) return null;
  const min = Math.min(...real), max = Math.max(...real);
  if (min === max) return 0.5;
  const t = (value - min) / (max - min);
  return invert ? 1 - t : t;
}
function heatCellHTML(text, frac) {
  return frac == null
    ? `<td>${text}</td>`
    : `<td style="background:${heatColor(frac)}; color:#1a1a1a;">${text}</td>`;
}

function renderMissionsAnalysisTable() {
  const body = document.getElementById("analysis-missions-body");
  if (!state.runs.some((r) => !r.inProgress)) {
    body.innerHTML = `<p class="empty-sub">No completed game runs yet.</p>`;
    return;
  }
  const data = computeMissionAnalytics().sort((a, b) => a.order - b.order);
  const successVals = data.map((d) => d.successRate);
  const ppsVals = data.map((d) => d.pointsPerSec);
  const timeVals = data.map((d) => d.avgTimeMs);

  const rows = data.map(({ mission, successRate, pointsPerSec, avgTimeMs }) => {
    const expanded = state.analysis.expandedMissionIds.has(String(mission.id));
    let taskRowsHTML = "";
    if (expanded) {
      const allTaskRates = state.missions.flatMap((m) => computeTaskAnalytics(m).map((t) => t.successRate));
      const taskData = computeTaskAnalytics(mission).sort((a, b) => a.order - b.order);
      taskRowsHTML = taskData.length
        ? `<tr><td colspan="4" style="padding:0;">
             <table class="analysis-subtable">
               ${taskData.map(({ task, successRate: tsr }) =>
                 `<tr><td class="analysis-subtable-name">${esc(task.name)}</td>${heatCellHTML(fmtPct(tsr), heatFrac(tsr, allTaskRates, false))}</tr>`
               ).join("")}
             </table>
           </td></tr>`
        : `<tr><td colspan="4"><p class="empty-sub" style="margin:6px 0;">No tasks in this mission.</p></td></tr>`;
    }
    return `
      <tr class="analysis-mission-row" data-mid="${mission.id}">
        <td class="analysis-mission-name"><span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>${esc(mission.name)}</td>
        ${heatCellHTML(fmtPct(successRate), heatFrac(successRate, successVals, false))}
        ${heatCellHTML(fmtPPS(pointsPerSec), heatFrac(pointsPerSec, ppsVals, false))}
        ${heatCellHTML(avgTimeMs != null ? fmtDuration(avgTimeMs) : "—", heatFrac(avgTimeMs, timeVals, true))}
      </tr>
      ${taskRowsHTML}
    `;
  }).join("");

  body.innerHTML = `
    <table class="analysis-table">
      <thead><tr><th>Mission</th><th>Success</th><th>Pts/sec</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="empty-sub">Green = best, red = worst, relative to your other missions. Tap a mission to see its tasks.</p>
  `;
  body.querySelectorAll(".analysis-mission-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const mid = tr.dataset.mid;
      if (state.analysis.expandedMissionIds.has(mid)) state.analysis.expandedMissionIds.delete(mid);
      else state.analysis.expandedMissionIds.add(mid);
      renderMissionsAnalysisTable();
    });
  });
}

// ---- Scoresheet-style CSV export ----
function colLetter(n) {
  // 1-indexed spreadsheet column letters: 1 -> A, 26 -> Z, 27 -> AA, ...
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
// Shared by the CSV and XLSX exporters/importer. A "Number" task (e.g. up to
// 4 objects delivered) becomes one row per unit; a "Choice" task becomes one
// row per option. Each resulting row is a genuine binary flag — lossless,
// unlike a single row trying to represent a count or a selection.
function buildScoreRowDefs() {
  const sortedGroups = state.runGroups.slice().sort((a, b) => a.order - b.order);
  const groupNumberById = Object.fromEntries(sortedGroups.map((g, i) => [g.id, i + 1]));
  const groupsById = Object.fromEntries(sortedGroups.map((g) => [g.id, g]));

  const rows = [];
  state.missions.forEach((mission) => {
    const group = groupsById[mission.runGroupId];
    const runName = group ? group.name : "Unassigned";
    const runNum = group ? groupNumberById[group.id] : "";
    visibleTasks(mission).forEach((task) => {
      const base = { mission, task, runName, runNum };
      if (task.type === "number") {
        const max = task.max || 0;
        for (let unit = 1; unit <= max; unit++) {
          rows.push({ ...base, notes: `${task.name} (unit ${unit} of ${max})`, pts: task.pointsPerUnit || 1,
            flagged: (run) => (Number((run.rawScores || {})[task.id]) || 0) >= unit });
        }
      } else if (task.type === "choice") {
        (task.options || []).forEach((opt, idx) => {
          rows.push({ ...base, notes: `${task.name} (option: ${opt.label})`, pts: opt.points || 0,
            flagged: (run) => (run.rawScores || {})[task.id] === idx });
        });
      } else {
        rows.push({ ...base, notes: task.name, pts: taskMaxPoints(task),
          flagged: (run) => !!(run.rawScores || {})[task.id] });
      }
    });
  });
  return rows;
}

function buildScoresheetCSV(runs) {
  const rows = buildScoreRowDefs();

  // Run-flag columns start right after "M#,Official Name,Notes,Pts,Name,#"
  // (6 columns), so the first flag column is G, matching the template.
  const firstFlagCol = 7;
  const lastFlagCol = firstFlagCol + runs.length - 1;
  const flagRangeFor = (rowNum) => `${colLetter(firstFlagCol)}${rowNum}:${colLetter(lastFlagCol)}${rowNum}`;
  const bonusRowCount = 2; // Precision Token Points, Equipment Inspection
  const lastDataRow = rows.length + 1 + bonusRowCount; // +1 for header row
  const lastTaskRow = rows.length + 1; // last row that has a Success Rate formula
  const successRateColLetter = colLetter(lastFlagCol + 1);

  // Row 1: per-run total-score formulas (SUMPRODUCT of each row's points
  // against that run's flags) — matches the template exactly, these are
  // live formulas, not just the run's label as plain text.
  const headerRunCells = runs.map((r, i) => `=SUMPRODUCT($D2:$D${lastDataRow},${colLetter(firstFlagCol + i)}2:${colLetter(firstFlagCol + i)}${lastDataRow})`);
  const header = ["M#", "Official Name", "Task", "Pts", "Name", "#", ...headerRunCells, "Success Rate", "", `=AVERAGE(${successRateColLetter}2:${successRateColLetter}${lastTaskRow})`];
  const lines = [header.map(csvEscape).join(",")];

  rows.forEach((row, i) => {
    const { mission, notes, pts, runName, runNum, flagged } = row;
    const rowNum = i + 2; // +2: header is row 1, data starts at row 2
    const flags = runs.map((r) => (flagged(r) ? "1" : ""));
    // A real spreadsheet formula (not a pre-computed number) so it recalculates
    // if the flags are ever edited after export/import — matches the
    // template's own Success Rate formula pattern exactly.
    const successRateFormula = runs.length
      ? `=SUM(${flagRangeFor(rowNum)})/COUNTIF(${colLetter(firstFlagCol)}$1:${colLetter(lastFlagCol)}$1,">100")`
      : "";
    const rowVals = [mission.number ?? "", mission.name, notes, pts, runName, runNum, ...flags, successRateFormula];
    lines.push(rowVals.map(csvEscape).join(","));
  });

  const tokenRow = ["", "", "", 1, "Precision Token Points", "", ...runs.map((r) => String(precisionTokenBonus(r.precisionTokensRemaining ?? 0)))];
  lines.push(tokenRow.map(csvEscape).join(","));
  const inspectionRow = ["", "", "", 1, "Equipment Inspection", "", ...runs.map((r) => String(r.equipmentInspectionPassed ? EQUIPMENT_INSPECTION_BONUS : 0))];
  lines.push(inspectionRow.map(csvEscape).join(","));

  return lines.join("\n");
}

const RUNS_PER_SHEET = 10; // matches the template's fixed 10 run columns (G:P)

function sheetTitleForRuns(runsChunk, sheetIdx) {
  if (!runsChunk.length) return "Runs";
  const fmt = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}-${d.getDate()}`; };
  const times = runsChunk.map((r) => r.startedAt || 0);
  const lo = fmt(Math.min(...times)), hi = fmt(Math.max(...times));
  const label = lo === hi ? lo : `${lo}_${hi}`;
  return `Runs ${label}`.slice(0, 31); // Excel sheet name hard limit
}

function buildScoresheetSheet(wb, sheetName, rows, runsChunk) {
  const ws = wb.addWorksheet(sheetName);
  const firstFlagCol = 7; // G
  const lastFlagCol = firstFlagCol + RUNS_PER_SHEET - 1; // always P — fixed 10 columns
  const firstFlagLetter = colLetter(firstFlagCol);
  const lastFlagLetter = colLetter(lastFlagCol);
  const successRateCol = lastFlagCol + 1;
  const successRateLetter = colLetter(successRateCol);
  const bonusRowCount = 2;
  const lastDataRow = rows.length + 1 + bonusRowCount;
  const lastTaskRow = rows.length + 1;

  const headerLabels = ["M#", "Official Name", "Task", "Pts", "Name", "#"];
  headerLabels.forEach((label, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = label;
    cell.font = { bold: true };
  });
  for (let i = 0; i < RUNS_PER_SHEET; i++) {
    const col = firstFlagCol + i;
    const cell = ws.getCell(1, col);
    cell.value = { formula: `SUMPRODUCT($D2:$D${lastDataRow},${colLetter(col)}2:${colLetter(col)}${lastDataRow})` };
    cell.font = { bold: true, color: { argb: "FFFF0000" } };
  }
  const rateHeaderCell = ws.getCell(1, successRateCol);
  rateHeaderCell.value = "Success Rate";
  rateHeaderCell.font = { bold: true };
  rateHeaderCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } };
  const avgCell = ws.getCell(1, successRateCol + 2);
  avgCell.value = { formula: `AVERAGE(${successRateLetter}2:${successRateLetter}${lastTaskRow})` };
  avgCell.font = { bold: true, color: { argb: "FFFFFF00" } };
  avgCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
  avgCell.numFmt = "0%";

  rows.forEach((row, i) => {
    const { mission, notes, pts, runName, runNum, flagged } = row;
    const rowNum = i + 2;
    ws.getCell(rowNum, 1).value = mission.number ?? null;
    ws.getCell(rowNum, 2).value = mission.name;
    ws.getCell(rowNum, 3).value = notes;
    ws.getCell(rowNum, 4).value = pts;
    ws.getCell(rowNum, 5).value = runName;
    ws.getCell(rowNum, 6).value = runNum || null;
    for (let ci = 0; ci < RUNS_PER_SHEET; ci++) {
      const r = runsChunk[ci]; // undefined past the actual run count — leave blank
      ws.getCell(rowNum, firstFlagCol + ci).value = r && flagged(r) ? 1 : null;
    }
    const rateCell = ws.getCell(rowNum, successRateCol);
    rateCell.value = {
      formula: `SUM(${firstFlagLetter}${rowNum}:${lastFlagLetter}${rowNum})/COUNTIF(${firstFlagLetter}$1:${lastFlagLetter}$1,">100")`,
    };
    rateCell.numFmt = "0%";
  });

  [["Precision Token Points", (r) => precisionTokenBonus(r.precisionTokensRemaining ?? 0)],
   ["Equipment Inspection", (r) => (r.equipmentInspectionPassed ? EQUIPMENT_INSPECTION_BONUS : 0)]]
    .forEach(([label, valueFn], bi) => {
      const rowNum = lastTaskRow + 1 + bi;
      ws.getCell(rowNum, 4).value = 1;
      ws.getCell(rowNum, 5).value = label;
      for (let ci = 0; ci < RUNS_PER_SHEET; ci++) {
        const r = runsChunk[ci];
        ws.getCell(rowNum, firstFlagCol + ci).value = r ? valueFn(r) : null;
      }
    });

  // Category-row banding: light blue across A:SuccessRate for every task row
  // whose "#" (category number) is odd — matches the template exactly.
  ws.addConditionalFormatting({
    ref: `A2:${successRateLetter}${lastTaskRow}`,
    rules: [{
      type: "expression",
      formulae: ["ISODD($F2)"],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFCFE2F3" } } },
    }],
  });
  // Red-yellow-green heatmap on the Success Rate column.
  ws.addConditionalFormatting({
    ref: `${successRateLetter}2:${successRateLetter}${lastTaskRow}`,
    rules: [{
      type: "colorScale",
      cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }],
      color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }],
    }],
  });

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 20;
  ws.getColumn(4).width = 5;
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 5;
  for (let i = 0; i < RUNS_PER_SHEET; i++) ws.getColumn(firstFlagCol + i).width = 6;
  ws.getColumn(successRateCol).width = 8;
}

async function buildScoresheetXLSX(runs) {
  const rows = buildScoreRowDefs();
  const sortedRuns = runs.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const chunks = [];
  for (let i = 0; i < sortedRuns.length; i += RUNS_PER_SHEET) chunks.push(sortedRuns.slice(i, i + RUNS_PER_SHEET));
  if (!chunks.length) chunks.push([]); // still produce one (blank) sheet if there are zero runs

  const wb = new ExcelJS.Workbook();
  const usedNames = new Set();
  chunks.forEach((runsChunk, i) => {
    let name = sheetTitleForRuns(runsChunk, i);
    while (usedNames.has(name)) name = `${name.slice(0, 28)} ${i}`; // guard against duplicate sheet names
    usedNames.add(name);
    buildScoresheetSheet(wb, name, rows, runsChunk);
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf;
}

// Reads a scoresheet .xlsx in exactly the shape buildScoresheetXLSX produces:
// header row with M#/Official Name/Notes/Pts/Name/#, one column per run up to
// a "Success Rate" column, then two bonus rows (Precision Token Points,
// Equipment Inspection). Rows are matched back to real tasks by (mission
// name, task name); Number tasks are split into one row per unit
// ("Task (unit N of MAX)") and Choice tasks into one row per option
// ("Task (option: LABEL)") — this makes the round trip fully lossless for
// every task type, not just Yes/No.
async function importScoresheetXLSX(file) {
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  if (!wb.worksheets.length) throw new Error("No sheet found in that file.");

  const cellText = (row, col) => {
    const v = row.getCell(col).value;
    if (v && typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
    return String(v ?? "").trim();
  };
  const cellNumber = (row, col) => {
    const v = row.getCell(col).value;
    const n = v && typeof v === "object" && "result" in v ? v.result : v;
    return Number(n) || 0;
  };

  const taskLookup = new Map();
  state.missions.forEach((m) => {
    visibleTasks(m).forEach((t) => {
      taskLookup.set(`${(m.name || "").trim().toLowerCase()}|||${(t.name || "").trim().toLowerCase()}`, t);
    });
  });
  const unitPattern = /^(.*) \(unit (\d+) of \d+\)$/;
  const optionPattern = /^(.*) \(option: (.+)\)$/;

  const importedAt = Date.now();
  const todayStr = new Date(importedAt).toLocaleDateString();
  const newRuns = [];
  let unmatchedCount = 0;
  let sheetsUsed = 0;

  for (const ws of wb.worksheets) {
    const firstFlagCol = 7; // G
    const headerRow = ws.getRow(1);
    let successRateCol = null;
    for (let c = firstFlagCol; c <= ws.columnCount + 1; c++) {
      if (cellText(headerRow, c).toLowerCase() === "success rate") { successRateCol = c; break; }
    }
    if (!successRateCol) continue; // not a scoresheet-shaped sheet — skip it rather than failing the whole import
    const runCount = successRateCol - firstFlagCol;
    if (runCount <= 0) continue;
    sheetsUsed++;

    const taskGroups = new Map(); // task.id -> { task, subRows: [{ row, unit?, optionLabel? }] }
    let tokenRow = null, inspectionRow = null;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const nameColText = cellText(row, 5).toLowerCase();
      if (nameColText === "precision token points") { tokenRow = row; continue; }
      if (nameColText === "equipment inspection") { inspectionRow = row; continue; }
      const notes = cellText(row, 3);
      if (!notes) continue;
      const missionName = cellText(row, 2).toLowerCase();

      let baseTaskName = notes, unit = null, optionLabel = null;
      const unitMatch = notes.match(unitPattern);
      const optionMatch = notes.match(optionPattern);
      if (unitMatch) { baseTaskName = unitMatch[1]; unit = Number(unitMatch[2]); }
      else if (optionMatch) { baseTaskName = optionMatch[1]; optionLabel = optionMatch[2]; }

      const task = taskLookup.get(`${missionName}|||${baseTaskName.trim().toLowerCase()}`);
      if (!task) { unmatchedCount++; continue; }
      if (!taskGroups.has(task.id)) taskGroups.set(task.id, { task, subRows: [] });
      taskGroups.get(task.id).subRows.push({ row, unit, optionLabel });
    }

    for (let ci = 0; ci < runCount; ci++) {
      const col = firstFlagCol + ci;
      const rawScores = {};
      taskGroups.forEach(({ task, subRows }) => {
        if (task.type === "number") {
          const count = subRows.filter((sr) => cellNumber(sr.row, col) > 0).length;
          if (count > 0) rawScores[task.id] = count;
        } else if (task.type === "choice") {
          const hit = subRows.find((sr) => cellNumber(sr.row, col) > 0);
          if (hit) {
            const idx = (task.options || []).findIndex((o) => o.label === hit.optionLabel);
            if (idx >= 0) rawScores[task.id] = idx;
          }
        } else {
          if (cellNumber(subRows[0].row, col) > 0) rawScores[task.id] = true;
        }
      });
      const tokenBonusVal = tokenRow ? cellNumber(tokenRow, col) : 0;
      const inspectionVal = inspectionRow ? cellNumber(inspectionRow, col) : 0;
      // Skip fully-blank columns — these are unused padding slots (a sheet
      // always has 10 run columns even if fewer real runs filled it), not
      // actual runs, so don't manufacture an empty run for them.
      if (!Object.keys(rawScores).length && tokenBonusVal <= 0 && inspectionVal <= 0) continue;
      newRuns.push({
        id: crypto.randomUUID(),
        order: state.runs.length + newRuns.length,
        label: `Imported Run ${newRuns.length + 1}`,
        date: todayStr,
        startedAt: importedAt + newRuns.length,
        finishedAt: importedAt + newRuns.length,
        inProgress: false,
        precisionTokensRemaining: tokensFromPrecisionBonus(tokenBonusVal),
        equipmentInspectionPassed: inspectionVal > 0,
        rawScores,
        totalTimeMs: 0,
        missionTimings: [],
        transitionTimings: [],
        notes: "Imported from scoresheet XLSX",
      });
    }
  }
  if (!sheetsUsed) throw new Error('Could not find a "Success Rate" column on any sheet — this doesn\'t look like a BARP scoresheet export.');
  for (const run of newRuns) await dbPut("runs", run);
  await loadRuns();
  return { importedCount: newRuns.length, unmatchedCount };
}

document.getElementById("btn-export-runs-csv").addEventListener("click", () => {
  const completedRuns = state.runs.filter((r) => !r.inProgress).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!completedRuns.length) { alert("No completed runs yet."); return; }
  const toLocalInput = (ts) => {
    const d = new Date(ts);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const earliest = (completedRuns[0].startedAt || Date.now()) - 60000;
  const latest = (completedRuns[completedRuns.length - 1].startedAt || Date.now()) + 60000;
  openModal(`
    <h2>Export scoresheet</h2>
    <p class="empty-sub">Choose a date/time range — every completed run started in that window becomes one column.</p>
    <div class="field"><label>From</label><input type="datetime-local" id="export-from" class="text-input" value="${toLocalInput(earliest)}"></div>
    <div class="field"><label>To</label><input type="datetime-local" id="export-to" class="text-input" value="${toLocalInput(latest)}"></div>
    <p class="empty-sub" id="export-run-count"></p>
    <div class="modal-actions" style="gap:6px;">
      <button class="btn btn-ghost btn-sm" id="m-cancel" type="button" style="flex:1; padding:10px 4px;">Cancel</button>
      <button class="btn btn-ghost btn-sm" id="m-export-csv" type="button" style="flex:1; padding:10px 4px;">CSV</button>
      <button class="btn btn-primary btn-sm" id="m-export-xlsx" type="button" style="flex:1; padding:10px 4px;">XLSX</button>
    </div>
  `);
  function inRangeRuns() {
    const fromVal = document.getElementById("export-from").value;
    const toVal = document.getElementById("export-to").value;
    const from = fromVal ? new Date(fromVal).getTime() : -Infinity;
    const to = toVal ? new Date(toVal).getTime() : Infinity;
    return completedRuns.filter((r) => { const t = r.startedAt || 0; return t >= from && t <= to; });
  }
  function updateCount() {
    const n = inRangeRuns().length;
    document.getElementById("export-run-count").textContent = `${n} run${n === 1 ? "" : "s"} in this range.`;
  }
  document.getElementById("export-from").addEventListener("change", updateCount);
  document.getElementById("export-to").addEventListener("change", updateCount);
  updateCount();
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-export-csv").addEventListener("click", () => {
    const runs = inRangeRuns();
    if (!runs.length) { alert("No runs in that range."); return; }
    if (!state.missions.some((m) => visibleTasks(m).length)) { alert("Add missions and tasks in Settings first."); return; }
    const csv = buildScoresheetCSV(runs);
    closeModal();
    download(`barp-scoresheet-${Date.now()}.csv`, csv, "text/csv");
  });
  document.getElementById("m-export-xlsx").addEventListener("click", async () => {
    const runs = inRangeRuns();
    if (!runs.length) { alert("No runs in that range."); return; }
    if (!state.missions.some((m) => visibleTasks(m).length)) { alert("Add missions and tasks in Settings first."); return; }
    if (typeof ExcelJS === "undefined") { alert("Couldn't load the Excel export library — check your internet connection and try again."); return; }
    const btn = document.getElementById("m-export-xlsx");
    btn.disabled = true; btn.textContent = "Building…";
    try {
      const buf = await buildScoresheetXLSX(runs);
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `barp-scoresheet-${Date.now()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      closeModal();
    } catch (e) {
      showErrorBanner(`XLSX export failed: ${e.name} — ${e.message}`);
      btn.disabled = false; btn.textContent = "XLSX";
    }
  });
});

document.getElementById("btn-import-runs-xlsx").addEventListener("click", () => document.getElementById("file-import-runs-xlsx").click());
document.getElementById("file-import-runs-xlsx").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (typeof ExcelJS === "undefined") { alert("Couldn't load the Excel library — check your internet connection and try again."); return; }
  if (!state.missions.some((m) => visibleTasks(m).length)) { alert("Add missions and tasks in Settings first, so imported scores have something to match against."); return; }
  try {
    const result = await importScoresheetXLSX(file);
    let msg = `Imported ${result.importedCount} run${result.importedCount === 1 ? "" : "s"}.`;
    if (result.unmatchedCount) msg += ` ${result.unmatchedCount} row${result.unmatchedCount === 1 ? "" : "s"} in the file didn't match any mission/task in Settings and were skipped.`;
    alert(msg);
  } catch (err) {
    showErrorBanner(`Import failed: ${err.name} — ${err.message}`);
  }
});

// ==========================================================
// BACKUP
// ==========================================================
document.getElementById("btn-recently-deleted").addEventListener("click", () => openRecentlyDeletedModal());
document.getElementById("btn-export-backup").addEventListener("click", async () => {
  const data = {
    version: 2,
    exportedAt: Date.now(),
    attachments: await dbGetAll("attachments"),
    entries: await dbGetAll("entries"),
    missions: await dbGetAll("missions"),
    runs: await dbGetAll("runs"),
    meta: await dbGetAll("meta"),
    runGroups: await dbGetAll("runGroups"),
  };
  download(`BARP-backups/barp-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), "application/json");
});

document.getElementById("btn-import-backup").addEventListener("click", () => document.getElementById("file-import-backup").click());
document.getElementById("btn-reset-db").addEventListener("click", async () => {
  if (state.firebaseUser) {
    setSyncStatus("Syncing before reset…");
    try {
      await performFirestoreSync();
      setSyncStatus("Connected");
      if (!confirm("Everything on this device has just been synced to your team's cloud database. Reset local data now? It'll pull back down automatically the next time this device signs in.")) return;
    } catch (e) {
      setSyncStatus("Sync failed — will retry on the next change.");
      if (!confirm(`Couldn't confirm everything is synced (${e.message}). If you reset now, anything not already synced could be lost for good. Reset anyway?`)) return;
    }
  } else {
    if (!confirm("This clears everything stored on this device. You're not signed in, so nothing will pull back down automatically — sign in first if you want your data to come back afterward. Reset anyway?")) return;
  }
  resetLocalDatabase();
});
document.getElementById("file-import-backup").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!confirm("This replaces everything currently stored on this device with the backup file. Continue?")) return;
  try {
    const data = JSON.parse(await file.text());
    await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta"); await dbClear("runGroups");
    for (const a of data.attachments || []) await dbPut("attachments", a);
    for (const en of data.entries || []) await dbPut("entries", en);
    for (const m of data.missions || []) await dbPut("missions", m);
    for (const r of data.runs || []) await dbPut("runs", r);
    for (const meta of data.meta || []) await dbPut("meta", meta);
    for (const g of data.runGroups || []) await dbPut("runGroups", g);
    await initAll();
    alert("Backup restored.");
  } catch (err) {
    alert("Couldn't read that backup file: " + err.message);
  }
});

// ---------- Firebase sign-in + Firestore sync ----------
// Firebase Auth handles the whole Google sign-in flow itself (popup, token,
// persistence) — unlike the old hand-rolled Google Identity Services setup,
// it persists sign-in across reloads on its own (stored in IndexedDB by the
// SDK), so there's no more manual silent-reissue logic needed here.
state.firebaseUser = null;
const FIRESTORE_COLLECTIONS = ["attachments", "entries", "runGroups", "missions", "runs"];
let firestoreListenersStarted = false;

function initFirebaseAuth() {
  if (!window.firebaseAuth) {
    window.addEventListener("firebase-ready", initFirebaseAuth, { once: true });
    return;
  }
  window.firebaseFns.onAuthStateChanged(window.firebaseAuth, (user) => {
    state.firebaseUser = user;
    renderGoogleSignInStatus();
    if (user && !firestoreListenersStarted) {
      firestoreListenersStarted = true;
      startFirestoreListeners();
      purgeOldTrash(); // re-run now that state.firebaseUser is actually set, so the Firestore-side purge (which was skipped at page load, before sign-in resolved) gets a chance to run
    }
  });
}
function renderGoogleSignInStatus() {
  const statusEl = document.getElementById("google-signin-status");
  const signInBtn = document.getElementById("btn-google-signin");
  const signOutBtn = document.getElementById("btn-google-signout");
  const syncEl = document.getElementById("drive-sync-status");
  const signedIn = !!state.firebaseUser;
  if (statusEl) statusEl.textContent = signedIn ? `Signed in as ${state.firebaseUser.displayName || state.firebaseUser.email}.` : "Not signed in.";
  if (signInBtn) signInBtn.hidden = signedIn;
  if (signOutBtn) signOutBtn.hidden = !signedIn;
  if (syncEl) syncEl.hidden = !signedIn;
}
document.getElementById("btn-google-signin").addEventListener("click", async () => {
  if (!window.firebaseAuth) { showErrorBanner("Sign-in isn't ready yet — check your internet connection and try again."); return; }
  try {
    await window.firebaseFns.signInWithPopup(window.firebaseAuth, new window.firebaseFns.GoogleAuthProvider());
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      showErrorBanner(`Sign-in failed: ${e.message}`);
    }
  }
});
document.getElementById("btn-google-signout").addEventListener("click", () => {
  openModal(`
    <h2>Sign out?</h2>
    <p class="empty-sub">You'll need to sign in again to keep syncing with the team — that may ask for 2-step verification again depending on your account.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-danger" id="m-confirm-signout" type="button">Sign Out</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-confirm-signout").addEventListener("click", async () => {
    closeModal();
    if (window.firebaseAuth) await window.firebaseFns.signOut(window.firebaseAuth);
  });
});

// ---- Firestore sync ----
// Each record type is its own Firestore collection, one document per record,
// keyed by the same id already used locally (UUIDs going forward). Pushing a
// change is just "set this exact document" — safe to repeat, never
// duplicates. Pulling happens continuously via live listeners below, not on
// a schedule: a teammate's change shows up automatically, no manual refresh.
//
// Known limit worth knowing: Firestore rejects any single document over 1MB.
// Attachment/entry records carry a base64 photo, which is compressed on
// capture (900px, quality 0.72) and normally stays well under that — but an
// unusually large photo could occasionally fail to sync even though it still
// saved fine locally. Worth revisiting with Firebase Storage for photos
// specifically if that ever actually happens in practice.
let driveSyncInFlight = false;
let driveSyncQueued = false;
function setSyncStatus(text) {
  const el = document.getElementById("drive-sync-status");
  if (el) el.textContent = text;
}
function syncToTeamDrive() {
  if (!state.firebaseUser) return; // not signed in — nothing to do
  if (driveSyncInFlight) { driveSyncQueued = true; return; }
  driveSyncInFlight = true;
  setSyncStatus("Syncing…");
  performFirestoreSync()
    .then(() => setSyncStatus("Connected"))
    .catch((e) => { setSyncStatus("Sync failed — will retry on the next change."); showErrorBanner(`Sync failed: ${e.message}`); })
    .finally(() => {
      driveSyncInFlight = false;
      if (driveSyncQueued) { driveSyncQueued = false; syncToTeamDrive(); }
    });
}
async function performFirestoreSync() {
  const { collection, doc, setDoc } = window.firebaseFns;
  const db = window.firebaseDb;
  const writes = [];
  for (const storeName of FIRESTORE_COLLECTIONS) {
    const records = await dbGetAll(storeName);
    for (const rec of records) {
      writes.push(setDoc(doc(collection(db, storeName), String(rec.id)), rec));
    }
  }
  await Promise.all(writes);
}
// Live listeners: a teammate's change lands here automatically, no polling.
// This also fires once immediately with everything already in the
// collection (Firestore's normal snapshot behavior), which is what pulls in
// a brand-new device's very first sync from the team's existing data.
function startFirestoreListeners() {
  const { collection, onSnapshot } = window.firebaseFns;
  const db = window.firebaseDb;
  setSyncStatus("Connecting…");
  FIRESTORE_COLLECTIONS.forEach((storeName) => {
    onSnapshot(collection(db, storeName), async (snapshot) => {
      let changed = false;
      for (const change of snapshot.docChanges()) {
        if (change.type === "removed") continue; // deletes are soft-deletes stored as normal docs, not real Firestore removals
        await dbPut(storeName, change.doc.data());
        changed = true;
      }
      if (changed) await refreshAfterRemoteChange(storeName);
      setSyncStatus("Connected");
    }, (e) => { setSyncStatus("Sync failed — will retry on the next change."); showErrorBanner(`Team sync listener failed: ${e.message}`); });
  });
}
async function refreshAfterRemoteChange(storeName) {
  if (storeName === "attachments") { await loadAttachments(); }
  else if (storeName === "entries") { renderAttachmentChips(); await renderEntryList(); await renderIterationTotal(); renderAttachmentsSetup(); }
  else if (storeName === "runGroups") { await loadRunGroups(); await loadMissions(); }
  else if (storeName === "missions") { await loadMissions(); renderRunGroups(); }
  else if (storeName === "runs") { await loadRuns(); }
}

// ---------- Init ----------
async function purgeOldTrash() {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - THIRTY_DAYS;
  const isOld = (x) => x.deleted && x.deletedAt && x.deletedAt < cutoff;
  // Best-effort: also remove the record from the shared Firestore database,
  // not just locally — otherwise a live listener would just pull it right
  // back down the next time this device (or a teammate's) reconnects.
  async function purgeFromFirestore(storeName, id) {
    if (!state.firebaseUser || !window.firebaseDb) return;
    try {
      const { doc, deleteDoc, collection } = window.firebaseFns;
      await deleteDoc(doc(collection(window.firebaseDb, storeName), String(id)));
    } catch (e) { /* best-effort — local purge still happened, will retry next launch */ }
  }

  for (const e of await dbGetAll("entries")) if (isOld(e)) { await dbDelete("entries", e.id); await purgeFromFirestore("entries", e.id); }
  for (const a of await dbGetAll("attachments")) if (isOld(a)) { await dbDelete("attachments", a.id); await purgeFromFirestore("attachments", a.id); }
  for (const g of await dbGetAll("runGroups")) if (isOld(g)) { await dbDelete("runGroups", g.id); await purgeFromFirestore("runGroups", g.id); }
  for (const r of await dbGetAll("runs")) if (isOld(r)) { await dbDelete("runs", r.id); await purgeFromFirestore("runs", r.id); }
  for (const m of await dbGetAll("missions")) {
    if (isOld(m)) { await dbDelete("missions", m.id); await purgeFromFirestore("missions", m.id); continue; }
    const keptTasks = (m.tasks || []).filter((t) => !isOld(t));
    if (keptTasks.length !== (m.tasks || []).length) {
      m.tasks = keptTasks;
      await dbPut("missions", m);
      if (state.firebaseUser) { try { await window.firebaseFns.setDoc(window.firebaseFns.doc(window.firebaseFns.collection(window.firebaseDb, "missions"), String(m.id)), m); } catch (e) {} }
    }
  }
}
const equipmentInspectionInput = document.getElementById("input-skip-equipment-inspection");
equipmentInspectionInput.addEventListener("change", async () => {
  state.skipEquipmentInspectionAsk = equipmentInspectionInput.checked;
  await dbPut("meta", { key: "skipEquipmentInspectionAsk", value: state.skipEquipmentInspectionAsk });
});
async function loadEquipmentInspectionSetting() {
  const rec = await dbGet("meta", "skipEquipmentInspectionAsk");
  state.skipEquipmentInspectionAsk = rec?.value ?? true;
  equipmentInspectionInput.checked = state.skipEquipmentInspectionAsk;
}
const keepGoingAfterBuzzerInput = document.getElementById("input-keep-going-after-buzzer");
keepGoingAfterBuzzerInput.addEventListener("change", async () => {
  state.keepGoingAfterBuzzer = keepGoingAfterBuzzerInput.checked;
  await dbPut("meta", { key: "keepGoingAfterBuzzer", value: state.keepGoingAfterBuzzer });
});
async function loadKeepGoingAfterBuzzerSetting() {
  const rec = await dbGet("meta", "keepGoingAfterBuzzer");
  state.keepGoingAfterBuzzer = rec?.value ?? false;
  keepGoingAfterBuzzerInput.checked = state.keepGoingAfterBuzzer;
}
const interactiveScoringInput = document.getElementById("input-interactive-scoring");
interactiveScoringInput.addEventListener("change", async () => {
  state.interactiveScoringEnabled = interactiveScoringInput.checked;
  await dbPut("meta", { key: "interactiveScoringEnabled", value: state.interactiveScoringEnabled });
});
async function loadInteractiveScoringSetting() {
  const rec = await dbGet("meta", "interactiveScoringEnabled");
  state.interactiveScoringEnabled = rec?.value ?? true;
  interactiveScoringInput.checked = state.interactiveScoringEnabled;
}
const interactiveIterationsInput = document.getElementById("input-interactive-iterations");
interactiveIterationsInput.addEventListener("change", async () => {
  state.interactiveIterationsEnabled = interactiveIterationsInput.checked;
  await dbPut("meta", { key: "interactiveIterationsEnabled", value: state.interactiveIterationsEnabled });
});
async function loadInteractiveIterationsSetting() {
  const rec = await dbGet("meta", "interactiveIterationsEnabled");
  state.interactiveIterationsEnabled = rec?.value ?? false;
  interactiveIterationsInput.checked = state.interactiveIterationsEnabled;
}

async function initAll() {
  preloadAllSounds(); // fire-and-forget, decoding well ahead of any run starting
  initFirebaseAuth(); // fire-and-forget, waits for the Firebase module script if needed
  await purgeOldTrash();
  await loadAttachments();
  await loadMissions();
  await loadRunGroups();
  await loadRuns();
  await loadEquipmentInspectionSetting();
  await loadKeepGoingAfterBuzzerSetting();
  await loadInteractiveScoringSetting();
  await loadInteractiveIterationsSetting();
  renderGoogleSignInStatus();
  document.getElementById("log-empty-state").hidden = state.attachments.length === 0 ? false : true;
}
initAll();
