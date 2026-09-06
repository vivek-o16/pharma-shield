/* =========================================================
   PHARMA SHIELD — application logic
   No backend. Reads data/drugAlerts.json. Uses localStorage
   for search history only (no personal data is stored).
   ========================================================= */

(() => {
  "use strict";

  const DATA_URL = "./drugAlerts.json";
  const HISTORY_KEY = "pharmaShieldSearchHistory";
  const MAX_HISTORY = 8;

  /** Minimal embedded fallback so the demo still works if the page is
   *  opened directly as a file:// URL and fetch() is blocked by the
   *  browser. The authoritative dataset always lives in data/drugAlerts.json. */
  const FALLBACK_DATA = {
    isDemoData: true,
    demoNotice: "Fallback sample used because data/drugAlerts.json could not be loaded.",
    lastUpdated: "2026-08-15",
    records: [
      {
        id: 1, medicineName: "Paracetamol 500mg", genericName: "Paracetamol",
        dosage: "500 mg Tablet", batchNumber: "ABC123",
        manufacturer: "Sundeep Pharmaceuticals Pvt. Ltd.", category: "NSQ",
        reason: "Failed disintegration test", alertDate: "2026-06-12",
        uses: "Used to relieve mild to moderate pain and reduce fever.",
        therapeuticCategory: "Analgesic / Antipyretic", source: "CDSCO (Demo)", status: "ALERT"
      }
    ]
  };

  let DB = { records: [], lastUpdated: null, isDemoData: true };

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHTML(str) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(str ?? "").replace(/[&<>"']/g, (c) => map[c]);
  }

  function normalizeCompact(str) {
    return String(str ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function normalizeDisplay(str) {
    return String(str ?? "").trim().replace(/\s+/g, " ");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  /* ---------------- Data loading ---------------- */

  async function loadDrugData() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Bad response " + res.status);
      const json = await res.json();
      if (!Array.isArray(json.records)) throw new Error("Malformed dataset");
      DB = json;
    } catch (err) {
      console.error("Pharma Shield: could not load the authoritative dataset.", err);
      DB = { records: [], lastUpdated: null, isDemoData: false, loadError: true };
      showToast("Drug database could not be loaded. Please refresh the page.", "history");
    }
    updateStatistics();
    renderRecentAlerts();
  }

  /* ---------------- Search logic ---------------- */

  function findExactMatch(nameCompact, batchCompact) {
    if (!batchCompact) return null;

    return DB.records.find((r) => {
      const rName = normalizeCompact(r.medicineName);
      const rBatch = normalizeCompact(r.batchNumber);

      if (!rBatch) return false;
      if (nameCompact && !rName) return false;

      const nameHit = nameCompact
        ? (rName.includes(nameCompact) || nameCompact.includes(rName))
        : true;

      return nameHit && rBatch === batchCompact;
    }) || null;
  }

  function findMedicineAlerts(nameCompact) {
    if (!nameCompact) return [];

    return DB.records.filter((r) => {
      const rName = normalizeCompact(r.medicineName);

      if (!rName) return false;

      return rName.includes(nameCompact) || nameCompact.includes(rName);
    });
  }

  function searchDrug(nameRaw, batchRaw) {
    const nameDisplay = normalizeDisplay(nameRaw);
    const batchDisplay = normalizeDisplay(batchRaw);
    const nameCompact = normalizeCompact(nameRaw);
    const batchCompact = normalizeCompact(batchRaw);

    if (!nameCompact && !batchCompact) {
      return { type: "empty" };
    }

    // If a batch number is entered, check ONLY that exact batch.
    // Never show alert history for other batches.
    if (batchCompact) {
      const exact = findExactMatch(nameCompact, batchCompact);
      if (exact) {
        return { type: "alert", record: exact, nameDisplay, batchDisplay };
      }

      return { type: "clear", nameDisplay, batchDisplay, batchChecked: true };
    }

    // No batch entered: medicine-only searches may show alert history.
    const medicineMatches = findMedicineAlerts(nameCompact);
    if (medicineMatches.length > 0) {
      return { type: "history", records: medicineMatches, nameDisplay, batchDisplay };
    }

    return { type: "clear", nameDisplay, batchDisplay, batchChecked: false };
  }

  /* ---------------- Rendering ---------------- */

  function fieldRow(label, value, mono = false) {
    return `<div class="result-field"><dt>${escapeHTML(label)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHTML(value || "—")}</dd></div>`;
  }

  function renderAlertResult(record) {
    return `
      <article class="result-card status-alert" role="alert">
        <span class="result-badge">⚠️ Alert found</span>
        <p class="result-message">This medicine/batch has been reported in a CDSCO quality alert.</p>
        <dl class="result-grid">
          ${fieldRow("Medicine name", record.medicineName)}
          ${fieldRow("Generic name", record.genericName)}
          ${fieldRow("Batch number", record.batchNumber, true)}
          ${fieldRow("Manufacturer", record.manufacturer)}
          ${fieldRow("Category", record.category)}
          ${fieldRow("Alert date", formatDate(record.alertDate))}
          ${fieldRow("Reason for alert", record.reason)}
          ${fieldRow("Medicine use", record.uses)}
        </dl>
        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
        </div>
        ${DB.isDemoData ? '<p class="result-note">This result is based on demo sample data included with the project, not a live CDSCO feed.</p>' : ""}
      </article>`;
  }

  function renderPartialMatch(records, batchDisplay) {
    const rows = records
      .map(
        (r) => `
        <div class="result-field">
          <dt>${escapeHTML(r.medicineName)}</dt>
          <dd class="mono">Batch ${escapeHTML(r.batchNumber)} &middot; ${escapeHTML(formatDate(r.alertDate))}</dd>
        </div>`
      )
      .join("");

    return `
      <article class="result-card status-history" role="alert">
        <span class="result-badge">⚠️ Medicine alert history found</span>
        <p class="result-message">An alert exists for this medicine, but ${batchDisplay ? "the entered batch number was not found in the available records." : "no batch number was entered, so the exact batch could not be confirmed."}</p>
        <dl class="result-grid">${rows}</dl>
        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
        </div>
        ${DB.isDemoData ? '<p class="result-note">This result is based on demo sample data included with the project, not a live CDSCO feed.</p>' : ""}
      </article>`;
  }

  function renderNoAlertResult(nameDisplay, batchDisplay, batchChecked = false) {
    const target = [
      nameDisplay ? `for “${escapeHTML(nameDisplay)}”` : "",
      batchChecked && batchDisplay ? `batch “${escapeHTML(batchDisplay)}”` : ""
    ].filter(Boolean).join(" — ");

    const message = batchChecked && batchDisplay
      ? `No matching CDSCO quality alert was found for this exact batch in the available dataset${nameDisplay ? ` (${escapeHTML(nameDisplay)})` : ""}.`
      : `No matching CDSCO quality alert was found in the available dataset${target ? ` ${target}` : ""}.`;

    return `
      <article class="result-card status-clear">
        <span class="result-badge">✓ No alert found for this batch</span>
        <p class="result-message">${message}</p>
        <p class="result-note">No alert found only means that no matching record was found for the entered batch in the available dataset. This does not guarantee the medicine is safe, genuine or free from quality issues.</p>
        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
        </div>
      </article>`;
  }

  function renderResult(outcome) {
    const container = el("#result-container");
    let html = "";
    let status = "CLEAR";

    if (outcome.type === "alert") {
      html = renderAlertResult(outcome.record);
      status = "ALERT";
    } else if (outcome.type === "history") {
      html = renderPartialMatch(outcome.records, outcome.batchDisplay);
      status = "HISTORY";
    } else if (outcome.type === "clear") {
      html = renderNoAlertResult(outcome.nameDisplay, outcome.batchDisplay, outcome.batchChecked);
      status = "CLEAR";
    } else {
      showToast("Enter a medicine name or batch number to check.", "history");
      return;
    }

    container.innerHTML = html;
    container.hidden = false;
    container.scrollIntoView({ behavior: "smooth", block: "start" });

    const printBtn = el("[data-print]", container);
    if (printBtn) printBtn.addEventListener("click", () => window.print());

    if (status === "ALERT") showToast("Alert found for this medicine/batch.", "alert");
    if (status === "HISTORY") showToast("This medicine has alert history in the dataset.", "history");
    if (status === "CLEAR") showToast("No matching alert found.", "clear");

    return status;
  }

  /* ---------------- Statistics ---------------- */

  function updateStatistics() {
    const records = DB.records || [];
    const nsq = records.filter((r) => (r.category || "").toUpperCase() === "NSQ").length;
  const alerted = records.filter((r) => {
  const category = (r.category || "").toUpperCase();
  return category === "NSQ" || category === "SPURIOUS";
}).length;
    const manufacturers = new Set(records.map((r) => (r.manufacturer || "").trim().toLowerCase())).size;

    setText("#stat-total", records.length);
    setText("#stat-nsq", nsq);
    setText("#stat-alert", alerted);
    setText("#stat-manufacturers", manufacturers);
    setText("#stat-updated", DB.lastUpdated ? formatDate(DB.lastUpdated) : "—");
  }

  function setText(sel, value) {
    const node = el(sel);
    if (node) node.textContent = value;
  }

  /* ---------------- Recent alerts ---------------- */

  function renderRecentAlerts() {
    const grid = el("#recent-grid");
    if (!grid) return;
    const sorted = [...DB.records].sort((a, b) => new Date(b.alertDate) - new Date(a.alertDate)).slice(0, 6);

    if (sorted.length === 0) {
      grid.innerHTML = `<p>No records available in the current dataset.</p>`;
      return;
    }

    grid.innerHTML = sorted
      .map(
        (r) => `
      <div class="recent-card ${<div class="recent-card ${
  ["NSQ", "SPURIOUS"].includes((r.category || "").toUpperCase())
    ? "category-alert"
    : ""
}"> ? "category-alert" : ""}">
        <span class="recent-tag">${escapeHTML(r.category || "Alert")}</span>
        <h4>${escapeHTML(r.medicineName)}</h4>
        <p class="recent-meta">Batch <span class="batch">${escapeHTML(r.batchNumber)}</span> &middot; ${escapeHTML(r.manufacturer)}</p>
        <p class="recent-meta">Alerted ${escapeHTML(formatDate(r.alertDate))}</p>
        <button class="recent-view" type="button" data-view-id="${r.id}">
          <span class="details-label">View details</span>
        </button>
        <div class="details-body" id="details-${r.id}">
          <dl class="result-grid" style="margin-top:14px;padding-top:14px;">
            ${fieldRow("Generic name", r.genericName)}
            ${fieldRow("Reason for alert", r.reason)}
            ${fieldRow("Medicine use", r.uses)}
          </dl>
        </div>
      </div>`
      )
      .join("");

    els("[data-view-id]", grid).forEach((btn) => {
      btn.addEventListener("click", () => {
        const body = el("#details-" + btn.dataset.viewId);
        const isOpen = body.classList.toggle("open");
        btn.setAttribute("aria-expanded", String(isOpen));
        const label = el(".details-label", btn);
        label.textContent = isOpen ? "Hide details" : "View details";
      });
    });
  }

  /* ---------------- Search history (localStorage) ---------------- */

  function loadSearchHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveSearchHistory(entry) {
    let history = loadSearchHistory();
    history = history.filter(
      (h) => !(normalizeCompact(h.name) === normalizeCompact(entry.name) && normalizeCompact(h.batch) === normalizeCompact(entry.batch))
    );
    history.unshift(entry);
    history = history.slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderSearchHistory();
  }

  function renderSearchHistory() {
    const strip = el("#history-strip");
    const wrap = el("#history-pills");
    const history = loadSearchHistory();

    if (!history.length) {
      strip.hidden = true;
      return;
    }

    strip.hidden = false;
    wrap.innerHTML = history
      .map(
        (h, i) => `
      <button class="history-pill" type="button" data-history-index="${i}">
        <span class="dot dot--${h.status}"></span>
        ${escapeHTML(h.name || h.batch || "search")}
      </button>`
      )
      .join("");

    els("[data-history-index]", wrap).forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = history[Number(btn.dataset.historyIndex)];
        el("#medicine-name").value = entry.name || "";
        el("#batch-number").value = entry.batch || "";
        runSearch();
      });
    });
  }

  function clearSearchHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderSearchHistory();
    showToast("Search history cleared.", "clear");
  }

  /* ---------------- Toasts ---------------- */

  function showToast(message, kind = "clear") {
    const region = el("#toast-region");
    const toast = document.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("toast-leaving");
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  /* ---------------- Search flow ---------------- */

  function runSearch() {
    const nameInput = el("#medicine-name").value;
    const batchInput = el("#batch-number").value;
    const btn = el("#check-btn");

    btn.classList.add("is-loading");
    btn.disabled = true;

    // Small delay purely for a professional "checking" feel — this is a
    // local, synchronous lookup, so the delay is intentionally short.
    setTimeout(() => {
      const outcome = searchDrug(nameInput, batchInput);
      const status = renderResult(outcome);
      btn.classList.remove("is-loading");
      btn.disabled = false;

      if (status && (normalizeCompact(nameInput) || normalizeCompact(batchInput))) {
        saveSearchHistory({
          name: normalizeDisplay(nameInput),
          batch: normalizeDisplay(batchInput),
          status,
          ts: Date.now(),
        });
      }
    }, 450);
  }

  /* ---------------- Navigation & misc UI ---------------- */

  function initNav() {
    const toggle = el("#nav-toggle");
    const nav = el("#main-nav");

    toggle.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("mobile-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    els("[data-nav]", nav).forEach((link) => {
      link.addEventListener("click", () => {
        nav.classList.remove("mobile-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });

    const sections = els("main section[id]");
    const navLinks = els("[data-nav]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navLinks.forEach((l) => l.classList.remove("active"));
            const active = navLinks.find((l) => l.getAttribute("href") === "#" + entry.target.id);
            if (active) active.classList.add("active");
          }
        });
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    sections.forEach((s) => observer.observe(s));
  }

  function initFeedbackForm() {
    const form = el("#feedback-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      showToast("Thanks — your feedback was captured for this demo.", "clear");
      form.reset();
    });
  }

  function initSearchForm() {
    const form = el("#search-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      runSearch();
    });
  }

  /* ---------------- Init ---------------- */

  document.addEventListener("DOMContentLoaded", async () => {
    initNav();
    initSearchForm();
    initFeedbackForm();
    renderSearchHistory();
    await loadDrugData();
  });
})();
