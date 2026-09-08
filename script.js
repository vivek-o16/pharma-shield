/* =========================================================
   PHARMA SHIELD — application logic
   No backend. Reads ./drugAlerts.json (real CDSCO-derived
   dataset). Uses localStorage for search history only
   (no personal data is stored).
   ========================================================= */

(() => {
  "use strict";

  const DATA_URL = "./drugAlerts.json";
  const HISTORY_KEY = "pharmaShieldSearchHistory";
  const MAX_HISTORY = 8;
  const TESSERACT_SRC = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  /** Minimal embedded fallback so the page still works if opened as a
   *  file:// URL and fetch() is blocked. Uses the SAME field shape as
   *  the real dataset so rendering code never has to branch on it.
   *  The authoritative dataset always lives in ./drugAlerts.json. */
  const FALLBACK_DATA = {
    isDemoData: true,
    datasetName: "Pharma Shield (fallback sample)",
    lastUpdated: "2026-August",
    records: [
      {
        id: "PS-fallback-1",
        medicineName: "Paracetamol Tablets I.P. 500mg",
        batchNumber: "ABC123",
        manufacturingDate: "Jan-2026",
        expiryDate: "Dec-2027",
        manufacturer: "Sundeep Pharmaceuticals Pvt. Ltd.",
        reason: "Disintegration",
        drawnBy: "Drugs Inspector",
        reportedBy: "State Drug Testing Laboratory",
        category: "NSQ",
        alertMonth: "June",
        alertYear: 2026,
        sourceFile: "Fallback sample record — not a live CDSCO feed",
        sourceYear: 2026
      }
    ]
  };

  let DB = { records: [], lastUpdated: null, isDemoData: true };
  let searchIndex = []; // precomputed compact fields for fast search

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHTML(str) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(str ?? "").replace(/[&<>"']/g, (c) => map[c]);
  }

  function normalizeCompact(str) {
    return String(str ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function normalizeWords(str) {
    return String(str ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function normalizeDisplay(str) {
    return String(str ?? "").trim().replace(/\s+/g, " ");
  }

  function monthIndex(name) {
    const i = MONTHS.findIndex(
      (m) => m.toLowerCase() === String(name || "").toLowerCase()
    );
    return i === -1 ? 0 : i;
  }

  function formatAlertPeriod(record) {
    if (!record) return "—";
    const month = record.alertMonth;
    const year = record.alertYear;
    if (!month && !year) return "—";
    return [month, year].filter(Boolean).join(" ");
  }

  function alertSortKey(record) {
    const y = Number(record.alertYear) || 0;
    const m = monthIndex(record.alertMonth);
    return y * 100 + m;
  }

  function categoryInfo(rawCategory) {
    const c = String(rawCategory || "").trim().toUpperCase();
    if (c === "NSQ") {
      return { key: "NSQ", label: "NSQ — Not of Standard Quality", emoji: "🔴", css: "nsq" };
    }
    if (c) {
      return { key: "ALERTED", label: `ALERTED — ${escapeHTML(rawCategory)}`, emoji: "🟠", css: "alerted" };
    }
    return { key: "ALERTED", label: "ALERTED — Quality Alert", emoji: "🟠", css: "alerted" };
  }

  /* ---------------- Data loading ---------------- */

  async function loadDrugData() {
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Bad response " + res.status);

      const json = await res.json();

      if (!Array.isArray(json.records)) {
        throw new Error("Malformed dataset");
      }

      DB = json;
    } catch (err) {
      console.error("Pharma Shield: could not load the authoritative dataset.", err);
      DB = FALLBACK_DATA;
      showToast("Live dataset could not be loaded — showing a fallback sample.", "history");
    }

    buildSearchIndex();
    updateStatistics();
    renderRecentAlerts();
    renderAnalytics();
    renderHistoricalDatabase();
  }

  function buildSearchIndex() {
    searchIndex = (DB.records || []).map((r) => ({
      record: r,
      nameCompact: normalizeCompact(r.medicineName),
      nameWords: normalizeWords(r.medicineName),
      batchCompact: normalizeCompact(r.batchNumber),
      manufacturerCompact: normalizeCompact(r.manufacturer)
    }));
  }

  /* ---------------- Search logic ---------------- */

  function findExactMatch(nameCompact, batchCompact) {
    if (!batchCompact) return null;

    const hit = searchIndex.find((row) => {
      if (!row.batchCompact || row.batchCompact !== batchCompact) return false;
      if (!nameCompact) return true;
      return row.nameCompact.includes(nameCompact) || nameCompact.includes(row.nameCompact);
    });

    return hit ? hit.record : null;
  }

  function findMedicineAlerts(nameCompact, nameWords) {
    if (!nameCompact) return [];

    return searchIndex
      .filter((row) => {
        if (!row.nameCompact) return false;
        if (row.nameCompact.includes(nameCompact) || nameCompact.includes(row.nameCompact)) {
          return true;
        }
        // multi-word partial match, e.g. "paracetamol 500" -> matches
        // "Paracetamol Tablets I.P. 500mg"
        if (nameWords.length > 1) {
          return nameWords.every((w) => row.nameCompact.includes(normalizeCompact(w)));
        }
        return false;
      })
      .map((row) => row.record);
  }

  function findManufacturerAlerts(nameCompact) {
    if (!nameCompact || nameCompact.length < 3) return [];
    return searchIndex
      .filter((row) => row.manufacturerCompact && row.manufacturerCompact.includes(nameCompact))
      .map((row) => row.record);
  }

  function searchDrug(nameRaw, batchRaw) {
    const nameDisplay = normalizeDisplay(nameRaw);
    const batchDisplay = normalizeDisplay(batchRaw);

    const nameCompact = normalizeCompact(nameRaw);
    const batchCompact = normalizeCompact(batchRaw);
    const nameWords = normalizeWords(nameRaw);

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
    const medicineMatches = findMedicineAlerts(nameCompact, nameWords);

    if (medicineMatches.length > 0) {
      return { type: "history", records: medicineMatches, nameDisplay, batchDisplay };
    }

    // Fall back to manufacturer-name search.
    const manufacturerMatches = findManufacturerAlerts(nameCompact);

    if (manufacturerMatches.length > 0) {
      return {
        type: "manufacturer",
        records: manufacturerMatches,
        nameDisplay,
        batchDisplay
      };
    }

    return { type: "clear", nameDisplay, batchDisplay, batchChecked: false };
  }

  /* ---------------- Autocomplete ---------------- */

  function getSuggestions(queryRaw, limit = 7) {
    const q = normalizeCompact(queryRaw);
    if (q.length < 2) return [];

    const seen = new Set();
    const out = [];

    for (const row of searchIndex) {
      if (!row.nameCompact.includes(q)) continue;
      const display = normalizeDisplay(row.record.medicineName);
      const key = display.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(display);
      if (out.length >= limit) break;
    }

    return out;
  }

  function initAutocomplete() {
    const input = el("#medicine-name");
    const list = el("#medicine-suggestions");
    if (!input || !list) return;

    function render(items) {
      if (!items.length) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }
      list.innerHTML = items
        .map((name) => `<li role="option" tabindex="-1">${escapeHTML(name)}</li>`)
        .join("");
      list.hidden = false;
    }

    input.addEventListener("input", () => {
      render(getSuggestions(input.value));
    });

    input.addEventListener("focus", () => {
      if (input.value.trim().length >= 2) render(getSuggestions(input.value));
    });

    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      input.value = li.textContent;
      list.hidden = true;
      input.focus();
    });

    document.addEventListener("click", (e) => {
      if (e.target !== input && !list.contains(e.target)) {
        list.hidden = true;
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") list.hidden = true;
    });
  }

  /* ---------------- Rendering: result cards ---------------- */

  function fieldRow(label, value, mono = false) {
    return `<div class="result-field"><dt>${escapeHTML(label)}</dt><dd${mono ? ' class="mono"' : ""}>${escapeHTML(value || "—")}</dd></div>`;
  }

  function renderAlertResult(record) {
    const cat = categoryInfo(record.category);
    return `
      <article class="result-card status-alert" role="alert">
        <span class="result-badge">${cat.emoji} ${cat.key} FOUND</span>

        <p class="result-message">
          This medicine/batch matches a CDSCO quality-alert record in the Pharma Shield dataset.
        </p>

        <dl class="result-grid">
          ${fieldRow("Drug name", record.medicineName)}
          ${fieldRow("Batch number", record.batchNumber, true)}
          ${fieldRow("Manufacturer", record.manufacturer)}
          ${fieldRow("Report type", record.category)}
          ${fieldRow("Reason / test failure", record.reason)}
          ${fieldRow("Month/Year of report", formatAlertPeriod(record))}
          ${fieldRow("Manufacturing date", record.manufacturingDate)}
          ${fieldRow("Expiry date", record.expiryDate)}
          ${fieldRow("Drawn by", record.drawnBy)}
          ${fieldRow("Reported by", record.reportedBy)}
          ${fieldRow("Source", record.sourceFile ? "CDSCO Drug Quality Alert" : "—")}
        </dl>

        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
          <a class="btn btn-outline" href="https://cdsco.gov.in" target="_blank" rel="noopener noreferrer">Verify on CDSCO ↗</a>
        </div>

        ${DB.isDemoData ? '<p class="result-note">This result is based on fallback sample data, not the live dataset.</p>' : ""}
      </article>`;
  }

  function renderPartialMatch(records, batchDisplay, title, introText) {
    const sorted = [...records].sort((a, b) => alertSortKey(b) - alertSortKey(a));

    const rows = sorted
      .map((r) => {
        const cat = categoryInfo(r.category);
        return `
        <div class="result-field">
          <dt>${escapeHTML(r.medicineName)}</dt>
          <dd class="mono">
            Batch ${escapeHTML(r.batchNumber)} &middot; ${escapeHTML(formatAlertPeriod(r))} &middot; ${cat.emoji} ${escapeHTML(cat.key)}
            <br><span class="dim">${escapeHTML(r.manufacturer || "Manufacturer not listed")}</span>
          </dd>
        </div>`;
      })
      .join("");

    return `
      <article class="result-card status-history" role="alert">
        <span class="result-badge">🟠 ${escapeHTML(title)}</span>
        <p class="result-message">${introText}</p>
        <dl class="result-grid">${rows}</dl>
        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
        </div>
        ${DB.isDemoData ? '<p class="result-note">This result is based on fallback sample data, not the live dataset.</p>' : ""}
      </article>`;
  }

  function renderNoAlertResult(nameDisplay, batchDisplay, batchChecked = false) {
    const message =
      batchChecked && batchDisplay
        ? `No matching CDSCO quality-alert record was found for this exact batch in the Pharma Shield database${nameDisplay ? ` (${escapeHTML(nameDisplay)})` : ""}.`
        : `No matching CDSCO quality-alert record was found in the Pharma Shield database${nameDisplay ? ` for “${escapeHTML(nameDisplay)}”` : ""}.`;

    return `
      <article class="result-card status-clear">
        <span class="result-badge">🟢 NO MATCHING ALERT FOUND</span>
        <p class="result-message">${message}</p>
        <p class="result-note">
          No matching record was found in the Pharma Shield database. This does <strong>NOT</strong> certify
          that the medicine is safe, genuine, approved, or of standard quality. Try checking the spelling,
          or search using the exact batch number. Always verify through official CDSCO sources.
        </p>
        <div class="result-actions">
          <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
        </div>
      </article>`;
  }

  function renderEmptyResult() {
    return `
      <article class="result-card status-neutral">
        <span class="result-badge status-badge--neutral">⚪ NOT CHECKED</span>
        <p class="result-message">Enter a medicine name or batch number above to run a check.</p>
      </article>`;
  }

  function renderResult(outcome) {
    const container = el("#result-container");
    let html = "";
    let status = "CLEAR";

    if (outcome.type === "alert") {
      html = renderAlertResult(outcome.record);
      status = categoryInfo(outcome.record.category).key;
    } else if (outcome.type === "history") {
      html = renderPartialMatch(
        outcome.records,
        outcome.batchDisplay,
        "Alert history found for this medicine",
        `Records exist for this medicine name in the dataset${outcome.batchDisplay ? "" : " (no batch number was entered, so the exact batch could not be confirmed)"}.`
      );
      status = "HISTORY";
    } else if (outcome.type === "manufacturer") {
      html = renderPartialMatch(
        outcome.records,
        outcome.batchDisplay,
        "Records found for this manufacturer",
        `No medicine name matched directly, but this manufacturer has quality-alert records in the dataset.`
      );
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

    if (status === "NSQ" || status === "ALERTED") {
      showToast(`${status} alert found for this medicine/batch.`, "alert");
    } else if (status === "HISTORY") {
      showToast("This medicine has alert history in the dataset.", "history");
    } else {
      showToast("No matching alert found.", "clear");
    }

    return status;
  }

  /* ---------------- Statistics ---------------- */

  function updateStatistics() {
    const records = DB.records || [];

    const nsq = records.filter((r) => (r.category || "").toUpperCase() === "NSQ").length;

    const manufacturers = new Set(
      records
        .map((r) => (r.manufacturer || "").trim().toLowerCase())
        .filter((m) => m && m !== "under investigation")
    ).size;

    setText("#stat-total", records.length.toLocaleString("en-IN"));
    setText("#stat-nsq", nsq.toLocaleString("en-IN"));
    setText("#stat-manufacturers", manufacturers.toLocaleString("en-IN"));
    setText("#stat-updated", DB.lastUpdated || "—");
  }

  function setText(sel, value) {
    const node = el(sel);
    if (node) node.textContent = value;
  }

  /* ---------------- Analytics dashboard ---------------- */

  function renderAnalytics() {
    const records = DB.records || [];
    if (!records.length) return;

    renderYearChart(records);
    renderCategorySplit(records);
    renderTopManufacturers(records);
    renderTopReasons(records);
  }

  function renderYearChart(records) {
    const host = el("#chart-years");
    if (!host) return;

    const counts = new Map();
    records.forEach((r) => {
      const y = r.alertYear;
      if (!y) return;
      counts.set(y, (counts.get(y) || 0) + 1);
    });

    const years = [...counts.keys()].sort((a, b) => a - b);
    const max = Math.max(...counts.values(), 1);

    host.innerHTML = years
      .map((y) => {
        const count = counts.get(y);
        const pct = Math.max(6, Math.round((count / max) * 100));
        return `
        <div class="bar-col" title="${y}: ${count} records">
          <div class="bar-track"><div class="bar-fill" style="height:${pct}%"></div></div>
          <span class="bar-count">${count}</span>
          <span class="bar-label">${y}</span>
        </div>`;
      })
      .join("");
  }

  function renderCategorySplit(records) {
    const host = el("#chart-category-split");
    if (!host) return;

    const nsq = records.filter((r) => (r.category || "").toUpperCase() === "NSQ").length;
    const other = records.length - nsq;
    const total = records.length || 1;
    const nsqPct = Math.round((nsq / total) * 100);
    const otherPct = 100 - nsqPct;

    host.innerHTML = `
      <div class="split-bar">
        <div class="split-seg split-seg--nsq" style="width:${nsqPct}%" title="NSQ: ${nsq}"></div>
        <div class="split-seg split-seg--alerted" style="width:${otherPct}%" title="Other alerts: ${other}"></div>
      </div>
      <div class="split-legend">
        <span><i class="dot dot--nsq"></i> NSQ — ${nsq.toLocaleString("en-IN")} (${nsqPct}%)</span>
        <span><i class="dot dot--alerted"></i> Other alerts — ${other.toLocaleString("en-IN")} (${otherPct}%)</span>
      </div>`;
  }

  function renderRankedBars(hostSel, entries) {
    const host = el(hostSel);
    if (!host) return;
    if (!entries.length) {
      host.innerHTML = `<p class="analytics-empty">Not enough data.</p>`;
      return;
    }
    const max = entries[0][1];
    host.innerHTML = entries
      .map(
        ([label, count]) => `
      <div class="rank-row">
        <span class="rank-label" title="${escapeHTML(label)}">${escapeHTML(label)}</span>
        <div class="rank-track"><div class="rank-fill" style="width:${Math.max(6, Math.round((count / max) * 100))}%"></div></div>
        <span class="rank-count">${count}</span>
      </div>`
      )
      .join("");
  }

  function renderTopManufacturers(records) {
    const counts = new Map();
    records.forEach((r) => {
      const m = (r.manufacturer || "").trim();
      if (!m || m.toLowerCase() === "under investigation") return;
      const short = m.length > 42 ? m.slice(0, 39) + "…" : m;
      counts.set(short, (counts.get(short) || 0) + 1);
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    renderRankedBars("#chart-manufacturers", top);
  }

  function renderTopReasons(records) {
    const counts = new Map();
    records.forEach((r) => {
      const reason = (r.reason || "").trim();
      if (!reason) return;
      counts.set(reason, (counts.get(reason) || 0) + 1);
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    renderRankedBars("#chart-reasons", top);
  }

  function renderHistoricalDatabase() {
    const records = DB.records || [];
    const years = [...new Set(records.map((r) => r.alertYear).filter(Boolean))].sort();
    const nsq = records.filter((r) => (r.category || "").toUpperCase() === "NSQ").length;
    const alerted = records.length - nsq;

    setText("#hist-years", years.length ? `${years[0]}–${years[years.length - 1]}` : "—");
    setText("#hist-total", records.length.toLocaleString("en-IN"));
    setText("#hist-nsq", nsq.toLocaleString("en-IN"));
    setText("#hist-alerted", alerted.toLocaleString("en-IN"));
    setText("#hist-coverage-note", DB.coverage || "");
  }

  /* ---------------- Recent alerts ---------------- */

  function renderRecentAlerts() {
    const grid = el("#recent-grid");
    if (!grid) return;

    const sorted = [...DB.records].sort((a, b) => alertSortKey(b) - alertSortKey(a)).slice(0, 6);

    if (sorted.length === 0) {
      grid.innerHTML = `<p>No records available in the current dataset.</p>`;
      return;
    }

    grid.innerHTML = sorted
      .map((r) => {
        const cat = categoryInfo(r.category);
        return `
      <div class="recent-card recent-card--${cat.css}">
        <span class="recent-tag recent-tag--${cat.css}">${cat.emoji} ${escapeHTML(cat.key)}</span>
        <h4>${escapeHTML(r.medicineName)}</h4>
        <p class="recent-meta">Batch <span class="batch">${escapeHTML(r.batchNumber)}</span></p>
        <p class="recent-meta">${escapeHTML(r.manufacturer || "Manufacturer not listed")}</p>
        <p class="recent-meta">Alerted ${escapeHTML(formatAlertPeriod(r))}</p>

        <button class="recent-view" type="button" data-view-id="${escapeHTML(r.id)}" aria-expanded="false">
          <span class="details-label">View details</span>
        </button>

        <div class="details-body" id="details-${escapeHTML(r.id)}">
          <dl class="result-grid" style="margin-top:14px;padding-top:14px;">
            ${fieldRow("Reason for alert", r.reason)}
            ${fieldRow("Manufacturing date", r.manufacturingDate)}
            ${fieldRow("Expiry date", r.expiryDate)}
            ${fieldRow("Drawn by", r.drawnBy)}
          </dl>
        </div>
      </div>`;
      })
      .join("");

    els("[data-view-id]", grid).forEach((btn) => {
      btn.addEventListener("click", () => {
        const body = el("#details-" + CSS.escape(btn.dataset.viewId));
        const isOpen = body.classList.toggle("open");
        btn.setAttribute("aria-expanded", String(isOpen));
        el(".details-label", btn).textContent = isOpen ? "Hide details" : "View details";
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
      (h) =>
        !(
          normalizeCompact(h.name) === normalizeCompact(entry.name) &&
          normalizeCompact(h.batch) === normalizeCompact(entry.batch)
        )
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
    const suggestions = el("#medicine-suggestions");
    if (suggestions) suggestions.hidden = true;

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
          ts: Date.now()
        });
      }
    }, 400);
  }

  /* ---------------- OCR / Medicine scanner ---------------- */

  let tesseractLoadPromise = null;

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoadPromise) return tesseractLoadPromise;

    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_SRC;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load OCR library"));
      document.head.appendChild(script);
    });

    return tesseractLoadPromise;
  }

  function parseOcrText(text) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // --- batch number: look for explicit "Batch/B.No" labels first ---
    let batch = "";
    let batchConfident = false;
    const batchLabelRe = /(?:b\.?\s*no\.?|batch\s*no\.?|batch\s*number|batch)\s*[:\-]?\s*([A-Z0-9\-\/]{3,15})/i;
    for (const line of lines) {
      const m = line.match(batchLabelRe);
      if (m) {
        batch = m[1].toUpperCase();
        batchConfident = true;
        break;
      }
    }
    if (!batch) {
      // fallback: a standalone alphanumeric token mixing letters+digits
      const tokenRe = /\b(?=[A-Z0-9]{4,12}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,12}\b/;
      for (const line of lines) {
        const m = line.toUpperCase().match(tokenRe);
        if (m) {
          batch = m[0];
          break;
        }
      }
    }

    // --- medicine name: skip common non-name lines, prefer an early
    //     line with letters that isn't a label line ---
    const skipRe = /^(mfg|mfd|exp|batch|b\.?no|mrp|price|net|qty|composition|storage|dosage|store|schedule|marketed|distributed)/i;
    let medicineName = "";
    for (const line of lines) {
      if (skipRe.test(line)) continue;
      if (!/[a-zA-Z]{3,}/.test(line)) continue;
      medicineName = line;
      break;
    }

    const nameConfident = medicineName.length >= 4 && medicineName.length <= 60;

    return {
      medicineName,
      batchNumber: batch,
      confident: batchConfident && nameConfident,
      rawText: text
    };
  }

  function initScanner() {
    const openBtn = el("#scan-open-btn");
    const panel = el("#scan-panel");
    const closeBtn = el("#scan-close-btn");
    const fileInput = el("#scan-file-input");
    const dropzone = el("#scan-dropzone");
    const preview = el("#scan-preview");
    const previewImg = el("#scan-preview-img");
    const statusEl = el("#scan-status");
    const verifyBlock = el("#scan-verify");
    const nameField = el("#scan-name-field");
    const batchField = el("#scan-batch-field");
    const confidenceNote = el("#scan-confidence-note");
    const useBtn = el("#scan-use-btn");
    const rescanBtn = el("#scan-rescan-btn");

    if (!openBtn || !panel) return;

    function reset() {
      preview.hidden = true;
      verifyBlock.hidden = true;
      statusEl.hidden = true;
      statusEl.textContent = "";
      fileInput.value = "";
    }

    openBtn.addEventListener("click", () => {
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    closeBtn.addEventListener("click", () => {
      panel.hidden = true;
      reset();
    });

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      handleImage(file);
    });

    async function handleImage(file) {
      verifyBlock.hidden = true;
      preview.hidden = false;
      previewImg.src = URL.createObjectURL(file);

      statusEl.hidden = false;
      statusEl.className = "scan-status scan-status--busy";
      statusEl.textContent = "Loading scanner…";

      try {
        await loadTesseract();

        statusEl.textContent = "Scanning medicine package…";

        const { data } = await window.Tesseract.recognize(file, "eng", {
          logger: (m) => {
            if (m.status === "recognizing text" && typeof m.progress === "number") {
              statusEl.textContent = `Scanning medicine package… ${Math.round(m.progress * 100)}%`;
            }
          }
        });

        const parsed = parseOcrText(data.text || "");

        statusEl.hidden = true;
        verifyBlock.hidden = false;
        nameField.value = parsed.medicineName;
        batchField.value = parsed.batchNumber;

        confidenceNote.textContent = parsed.confident
          ? "Text was detected clearly. Please double-check before searching."
          : "OCR confidence is low — please verify or correct these fields before searching.";
        confidenceNote.className = parsed.confident
          ? "scan-confidence scan-confidence--ok"
          : "scan-confidence scan-confidence--low";
      } catch (err) {
        console.error("Pharma Shield OCR error:", err);
        statusEl.className = "scan-status scan-status--error";
        statusEl.textContent = "Scanning failed. Please try a clearer photo, or enter the details manually below.";
        verifyBlock.hidden = false;
        nameField.value = "";
        batchField.value = "";
        confidenceNote.textContent = "OCR failed — please enter the medicine name and batch number manually.";
        confidenceNote.className = "scan-confidence scan-confidence--low";
      }
    }

    rescanBtn.addEventListener("click", () => {
      reset();
      fileInput.click();
    });

    useBtn.addEventListener("click", () => {
      el("#medicine-name").value = nameField.value;
      el("#batch-number").value = batchField.value;
      panel.hidden = true;
      reset();
      el("#search-form").scrollIntoView({ behavior: "smooth", block: "start" });
      runSearch();
    });
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
    if (!form) return;
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

    const clearBtn = el("#history-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearSearchHistory);
  }

  /* ---------------- Init ---------------- */

  document.addEventListener("DOMContentLoaded", async () => {
    initNav();
    initSearchForm();
    initAutocomplete();
    initScanner();
    initFeedbackForm();
    renderSearchHistory();

    const container = el("#result-container");
    if (container) {
      container.innerHTML = renderEmptyResult();
      container.hidden = false;
    }

    await loadDrugData();
  });
})();
