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
    if (window.__refreshAlertFilterYears) window.__refreshAlertFilterYears();
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

  /* ---------------- Month / year report filter ---------------- */

  function initAlertFilter() {
    const monthSelect = el("#alert-month");
    const yearSelect = el("#alert-year");
    const filterBtn = el("#alert-filter-btn");
    const clearBtn = el("#alert-filter-clear");
    const status = el("#alert-filter-status");
    const container = el("#result-container");
    if (!monthSelect || !yearSelect || !filterBtn || !clearBtn || !status || !container) return;

    MONTHS.forEach((month) => {
      const option = document.createElement("option");
      option.value = month;
      option.textContent = month;
      monthSelect.appendChild(option);
    });

    function populateYears() {
      const years = [...new Set((DB.records || []).map((r) => String(r.alertYear || "")).filter(Boolean))]
        .sort((a, b) => Number(a) - Number(b));
      yearSelect.innerHTML = '<option value="">Select year</option>';
      years.forEach((year) => {
        const option = document.createElement("option");
        option.value = year;
        option.textContent = year;
        yearSelect.appendChild(option);
      });
    }

    function applyFilter() {
      const month = monthSelect.value;
      const year = yearSelect.value;
      if (!month || !year) {
        status.textContent = "Select both a month and year.";
        status.className = "alert-filter-status is-error";
        return;
      }

      const matches = (DB.records || []).filter((record) =>
        String(record.alertMonth || "").trim().toLowerCase() === month.trim().toLowerCase() &&
        String(record.alertYear || "").trim() === String(year).trim()
      );

      if (!matches.length) {
        status.textContent = `No reports found for ${month} ${year}.`;
        status.className = "alert-filter-status is-error";
        container.innerHTML = `
          <article class="result-card status-clear">
            <span class="result-badge">🟢 NO REPORTS FOUND</span>
            <p class="result-message">No CDSCO quality-alert reports were found for ${escapeHTML(month)} ${escapeHTML(year)}.</p>
            <p class="result-note">Try another month and year. The filter uses the report month and year stored in the Pharma Shield dataset.</p>
          </article>`;
        container.hidden = false;
        container.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      const sorted = [...matches].sort((a, b) => {
        const am = normalizeDisplay(a.medicineName);
        const bm = normalizeDisplay(b.medicineName);
        return am.localeCompare(bm);
      });

      const rows = sorted.map((record) => {
        const cat = categoryInfo(record.category);
        return `
          <div class="result-field">
            <dt>${escapeHTML(record.medicineName || "Medicine name not listed")}</dt>
            <dd>
              Batch ${escapeHTML(record.batchNumber || "—")} &middot; ${cat.emoji} ${escapeHTML(cat.key)}
              <br><span class="dim">${escapeHTML(record.manufacturer || "Manufacturer not listed")}</span>
            </dd>
          </div>`;
      }).join("");

      container.innerHTML = `
        <article class="result-card status-history" role="region" aria-label="${escapeHTML(month)} ${escapeHTML(year)} reports">
          <span class="result-badge">📋 REPORT HISTORY</span>
          <p class="result-message">Showing <strong>${matches.length}</strong> CDSCO quality-alert report${matches.length === 1 ? "" : "s"} for ${escapeHTML(month)} ${escapeHTML(year)}.</p>
          <dl class="result-grid">${rows}</dl>
          <div class="result-actions">
            <button class="btn btn-outline" type="button" data-print>🖨 Print result</button>
          </div>
        </article>`;
      container.hidden = false;
      status.textContent = `Showing ${matches.length} report${matches.length === 1 ? "" : "s"} for ${month} ${year}.`;
      status.className = "alert-filter-status is-active";
      container.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function clearFilter() {
      monthSelect.value = "";
      yearSelect.value = "";
      status.textContent = "";
      status.className = "alert-filter-status";
      container.innerHTML = renderEmptyResult();
      container.hidden = false;
    }

    filterBtn.addEventListener("click", applyFilter);
    clearBtn.addEventListener("click", clearFilter);

    populateYears();
    window.__refreshAlertFilterYears = populateYears;
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

  /* ---------------- OCR image preprocessing ----------------
     All client-side, canvas-based. The ORIGINAL uploaded image is
     never altered — preprocessing produces a separate canvas that is
     handed to Tesseract only. The preview keeps showing the original.
     --------------------------------------------------------- */

  const OCR_MIN_WIDTH = 1300;   // upscale small photos to at least this width
  const OCR_MAX_DIM = 2200;     // never process anything larger than this
  const OCR_MEDIAN_PIXEL_LIMIT = 3000000; // skip median denoise above this size

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read the selected image."));
      };
      img.src = url;
    });
  }

  /** Mild 3x3 median filter — removes speckle/JPEG noise without
   *  smearing printed characters. */
  function medianFilter3(src, w, h) {
    const out = new Uint8ClampedArray(src.length);
    out.set(src);
    const win = new Uint8Array(9);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = (y + dy) * w + x;
          win[k++] = src[row - 1];
          win[k++] = src[row];
          win[k++] = src[row + 1];
        }
        // insertion sort on 9 values
        for (let i = 1; i < 9; i++) {
          const v = win[i];
          let j = i - 1;
          while (j >= 0 && win[j] > v) {
            win[j + 1] = win[j];
            j--;
          }
          win[j + 1] = v;
        }
        out[y * w + x] = win[4];
      }
    }
    return out;
  }

  /** Percentile-based contrast stretch. Deliberately conservative
   *  (1st/99th percentile) so faint small print is lifted but not
   *  clipped away. */
  function contrastStretch(src) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < src.length; i++) hist[src[i]]++;

    const total = src.length;
    const cut = Math.max(1, Math.floor(total * 0.01));

    let lo = 0;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= cut) { lo = v; break; }
    }

    let hi = 255;
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= cut) { hi = v; break; }
    }

    if (hi - lo < 25) return src; // almost flat image — leave it alone

    const lut = new Uint8ClampedArray(256);
    const range = hi - lo;
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) / range) * 255)));
    }

    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i++) out[i] = lut[src[i]];
    return out;
  }

  /** Light unsharp mask (3x3 box blur based). `amount` kept low so
   *  thin printed strokes get crisper without ringing. */
  function unsharpMask(src, w, h, amount) {
    const blur = new Uint8ClampedArray(src.length);
    blur.set(src);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const c = y * w + x;
        const sum =
          src[c - w - 1] + src[c - w] + src[c - w + 1] +
          src[c - 1] + src[c] + src[c + 1] +
          src[c + w - 1] + src[c + w] + src[c + w + 1];
        blur[c] = (sum / 9) | 0;
      }
    }

    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = Math.max(0, Math.min(255, src[i] + amount * (src[i] - blur[i])));
    }
    return out;
  }

  /** Returns a canvas containing an upscaled, grayscale, denoised,
   *  contrast-stretched, lightly sharpened version of the image. */
  function preprocessToCanvas(img) {
    const natW = img.naturalWidth || img.width;
    const natH = img.naturalHeight || img.height;
    if (!natW || !natH) return null;

    let scale = 1;
    if (natW < OCR_MIN_WIDTH) scale = OCR_MIN_WIDTH / natW;
    if (Math.max(natW, natH) * scale > OCR_MAX_DIM) {
      scale = OCR_MAX_DIM / Math.max(natW, natH);
    }

    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h);
    } catch (err) {
      return canvas; // cannot read pixels — hand over the plain resized canvas
    }

    const px = imageData.data;
    const n = w * h;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
    }

    let work = n <= OCR_MEDIAN_PIXEL_LIMIT ? medianFilter3(gray, w, h) : gray;
    work = contrastStretch(work);
    work = unsharpMask(work, w, h, 0.35);

    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = work[i];
      px[p] = v;
      px[p + 1] = v;
      px[p + 2] = v;
      px[p + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    return canvas;
  }

  /* ---------------- OCR text interpretation ---------------- */

  /** Lines that are labels/legal text, never the product name. */
  const OCR_LABEL_RE = new RegExp(
    "^\\s*(?:" +
    "m\\.?f\\.?[gd]\\.?|mfg|mfd|manufacturing|manufactured|marketed|mktd|distributed|" +
    "exp|expy|expiry|expires|use\\s*before|best\\s*before|" +
    "b\\.?\\s*no|bno|batch|lot|" +
    "m\\.?r\\.?p|mrp|price|rs\\.?|inr|" +
    "net\\s*(?:qty|wt|weight|quantity)|qty|quantity|" +
    "composition|contains|each\\b|ingredients|" +
    "storage|store|keep|protect|" +
    "dosage|dose|direction|directions|indications|" +
    "schedule|caution|warning|read\\b|not\\s+to\\b|to\\s+be\\s+sold|" +
    "prescription|physician|doctor|" +
    "regd|reg\\.?\\s*no|gst|licence|license|lic\\.?\\s*no|" +
    "address|customer|consumer|care|help(?:line)?|" +
    "www|https?|tel|ph\\.?\\s*no|phone|mobile|email|" +
    "made\\s+in|import|imported" +
    ")\\b", "i"
  );

  /** Company / address vocabulary — strong signal that a line is NOT
   *  the product name. */
  const OCR_COMPANY_RE = new RegExp(
    "\\b(?:pvt|private|ltd|limited|llp|inc|corp|company|" +
    "pharma|pharmaceutical|pharmaceuticals|pharmaceutics|" +
    "laboratory|laboratories|labs?|healthcare|health\\s*care|remedies|" +
    "biotech|biotec|lifesciences|life\\s*sciences|formulations|" +
    "industries|industry|enterprises|organics|chemicals|" +
    "unit|plot|road|street|nagar|village|dist|district|taluka|" +
    "estate|sez|works|factory|india|state|pin|gmp|iso" +
    ")\\b", "i"
  );

  /** Recognised pharmaceutical dosage forms. */
  const OCR_DOSAGE_FORM_RE = new RegExp(
    "\\b(?:tablets?|tabs?|capsules?|caps?|syrup|syrups|suspension|" +
    "injection|injections|inj|infusion|cream|ointment|gel|jelly|" +
    "drops?|solution|powder|sachet|granules|lotion|spray|inhaler|" +
    "emulsion|elixir|pessary|suppositor(?:y|ies)|dispersible|" +
    "mouthwash|shampoo|paste|patch|vial|ampoule" +
    ")\\b", "i"
  );

  const OCR_STRENGTH_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|µg|gm?|ml|iu|%)\b/i;
  const OCR_PHARMACOPOEIA_RE = /\b(?:i\.?\s*p\.?|b\.?\s*p\.?|u\.?\s*s\.?\s*p\.?)\b/i;

  /** Batch labels, tolerant of the OCR errors these labels usually
   *  pick up (0/O, 1/I, spaced-out letters, B.No -> 8.No). */
  const OCR_BATCH_LABEL_RE = new RegExp(
    "(?:" +
    "[b8]\\s*a\\s*t\\s*[c(]\\s*[hn]|" +      // BATCH, 8ATCH, BATCN
    "[b8]\\s*\\.?\\s*[n]\\s*[o0]|" +          // B.No, BNO, 8 NO
    "[b8]\\s*t\\s*[c(]\\s*[hn]|" +            // BTCH
    "[l1|]\\s*[o0]\\s*t" +                    // LOT, L0T, 1OT
    ")" +
    "\\s*(?:n\\s*[o0]\\.?|number|#)?" +
    "[\\s:.\\-–=]{0,4}" +
    "([A-Z0-9][A-Z0-9\\-\\/]{2,14})",
    "i"
  );

  const OCR_MONTH_TOKEN_RE = /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i;

  /** Rejects tokens that are obviously an expiry/MFG date, an MRP,
   *  a strength, or a phone number rather than a batch code. */
  function isImplausibleBatch(token) {
    if (!token) return true;
    const t = String(token).toUpperCase().trim();

    if (t.length < 3 || t.length > 15) return true;
    if (!/[A-Z0-9]/.test(t)) return true;
    if (/^(?:NO|NA|N\/A|NIL|MFG|MFD|EXP|MRP|BATCH|LOT|RS|INR)$/.test(t)) return true;

    // month names => date, not a batch
    if (OCR_MONTH_TOKEN_RE.test(t)) return true;

    // dd/mm/yyyy, mm-yy, mm/yyyy style dates
    if (/^\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return true;
    if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return true;

    // a strength value
    if (/^\d+(?:\.\d+)?(?:MG|MCG|UG|G|GM|ML|IU|%)$/.test(t)) return true;

    // money / MRP
    if (/^(?:RS|INR|₹)/.test(t)) return true;
    if (/^\d+\.\d{2}$/.test(t)) return true;

    // long digit runs => phone / licence / barcode
    const digitsOnly = t.replace(/\D/g, "");
    if (/^\d+$/.test(t) && t.length >= 8) return true;
    if (digitsOnly.length >= 10) return true;

    // a bare 4-digit year
    if (/^(?:19|20)\d{2}$/.test(t)) return true;

    return false;
  }

  /** Scores how likely a line is to be the medicine/product name. */
  function scoreMedicineNameLine(rawLine, position, totalLines) {
    const line = String(rawLine || "").trim();
    if (line.length < 3 || line.length > 70) return -100;

    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const digits = (line.match(/[0-9]/g) || []).length;
    const symbols = (line.match(/[^A-Za-z0-9\s.,()\-\/®™+]/g) || []).length;

    if (letters < 3) return -100;
    if (OCR_LABEL_RE.test(line)) return -100;

    let score = 0;

    // product-shaped signals
    if (OCR_DOSAGE_FORM_RE.test(line)) score += 40;
    if (OCR_STRENGTH_RE.test(line)) score += 22;
    if (OCR_PHARMACOPOEIA_RE.test(line)) score += 16;
    if (/[®™]/.test(line)) score += 12;

    // a mostly-alphabetic line reads like a name
    const letterRatio = letters / line.length;
    if (letterRatio > 0.65) score += 16;
    else if (letterRatio > 0.45) score += 6;
    else score -= 14;

    // good name length band
    const words = line.split(/\s+/).filter(Boolean).length;
    if (line.length >= 5 && line.length <= 45) score += 12;
    if (words >= 1 && words <= 6) score += 8;
    else if (words > 8) score -= 12;

    // brand names are usually set in caps or title case
    if (/^[A-Z][A-Za-z]/.test(line)) score += 6;
    if (/^[A-Z0-9\s.\-]+$/.test(line) && letters >= 4) score += 8;

    // company / address / marketing text is not the product name
    if (OCR_COMPANY_RE.test(line)) score -= 45;
    if (/\b(?:by|for)\s*[:\-]?\s*$/i.test(line)) score -= 20;

    // number-heavy or symbol-heavy lines are packaging noise
    if (digits > letters) score -= 30;
    score -= symbols * 3;

    // product names sit in the upper part of a pack, but this is only
    // a nudge — never the deciding factor (the old code used position
    // alone, which is exactly what went wrong).
    if (totalLines > 1) {
      const rel = position / totalLines;
      if (rel <= 0.35) score += 10;
      else if (rel <= 0.6) score += 4;
      else score -= 4;
    }

    return score;
  }

  /* ---- database-aware correction (read-only use of the loaded data) ---- */

  function ocrLevenshtein(a, b, cap) {
    const la = a.length;
    const lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    if (typeof cap === "number" && Math.abs(la - lb) > cap) return cap + 1;

    let prev = new Array(lb + 1);
    let cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;

    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (typeof cap === "number" && rowMin > cap) return cap + 1;
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[lb];
  }

  function ocrSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const max = Math.max(a.length, b.length);
    const cap = Math.ceil(max * 0.45);
    const dist = ocrLevenshtein(a, b, cap);
    if (dist > cap) return 0;
    return 1 - dist / max;
  }

  /** Generic pharmaceutical vocabulary. These words appear in almost
   *  every product name, so they must never be what makes two names
   *  "match" — otherwise any tablet would match any other tablet. */
  const OCR_GENERIC_TOKENS = new Set([
    "tablet", "tablets", "capsule", "capsules", "syrup", "syrups",
    "suspension", "injection", "injections", "infusion", "cream",
    "ointment", "solution", "powder", "granules", "drops", "lotion",
    "spray", "inhaler", "emulsion", "elixir", "sachet", "vial",
    "ampoule", "pessary", "suppository", "suppositories",
    "sodium", "calcium", "potassium", "magnesium", "aluminium",
    "hydrochloride", "hydrochlorid", "sulphate", "sulfate", "phosphate",
    "citrate", "maleate", "tartrate", "acetate", "fumarate", "succinate",
    "besylate", "mesylate", "dihydrate", "monohydrate", "trihydrate",
    "gastro", "resistant", "coated", "uncoated", "film", "dispersible",
    "extended", "prolonged", "sustained", "release", "modified",
    "oral", "sterile", "aqueous", "topical", "ophthalmic", "compound"
  ]);

  /** Common OCR character confusions, folded before comparing. */
  function ocrFold(str) {
    return normalizeCompact(str)
      .replace(/0/g, "o")
      .replace(/1/g, "l")
      .replace(/5/g, "s")
      .replace(/8/g, "b")
      .replace(/2/g, "z");
  }

  /**
   * Tries to map a noisy OCR string onto a medicine name that already
   * exists in the loaded dataset. Never fabricates a name and never
   * writes to the dataset — it only reuses an existing spelling when
   * the match is strong enough.
   */
  function matchNameAgainstDatabase(candidate) {
    const raw = String(candidate || "").trim();
    if (raw.length < 4 || !Array.isArray(searchIndex) || !searchIndex.length) {
      return null;
    }

    const candCompact = normalizeCompact(raw);
    const candFold = ocrFold(raw);
    if (candCompact.length < 4) return null;

    // Distinctive tokens only — the active-ingredient / brand words.
    // Generic words ("tablets", "sodium", …) are deliberately excluded.
    const candTokens = normalizeWords(raw).filter(
      (w) => w.length >= 6 && !OCR_GENERIC_TOKENS.has(w)
    );

    let best = null;

    for (const row of searchIndex) {
      if (!row.nameCompact || row.nameCompact.length < 4) continue;
      const dbName = row.record && row.record.medicineName;
      if (!dbName) continue;

      const dbFold = ocrFold(row.nameCompact);
      let sim = 0;

      // whole-string similarity
      sim = Math.max(sim, ocrSimilarity(candFold, dbFold));

      // containment (OCR caught only part of the pack name)
      if (candFold.length >= 6 && dbFold.includes(candFold)) {
        sim = Math.max(sim, 0.9);
      } else if (dbFold.length >= 6 && candFold.includes(dbFold)) {
        sim = Math.max(sim, 0.88);
      }

      // token-level: "PARACETAM0L" vs "Paracetamol Tablets I.P. 500mg"
      if (candTokens.length) {
        const dbTokens = (row.nameWords || []).filter(
          (w) => w.length >= 6 && !OCR_GENERIC_TOKENS.has(w)
        );
        for (const ct of candTokens) {
          const ctFold = ocrFold(ct);
          for (const dt of dbTokens) {
            const tokenSim = ocrSimilarity(ctFold, ocrFold(dt));
            if (tokenSim >= 0.82) sim = Math.max(sim, 0.8 + (tokenSim - 0.82));
          }
        }
      }

      if (sim > 0 && (!best || sim > best.similarity)) {
        best = { name: dbName, similarity: sim };
      }
    }

    if (best && best.similarity >= 0.74) return best;
    return null;
  }

  /**
   * Interprets raw OCR text. Returns the best medicine name and batch
   * number it can justify, plus a confidence flag. Both values always
   * stay editable by the user.
   */
  function parseOcrText(text, meanConfidence) {
    const rawText = String(text || "");
    const lines = rawText
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length > 1);

    /* ---- batch number ---- */
    let batch = "";
    let batchConfident = false;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(OCR_BATCH_LABEL_RE);
      if (m && m[1] && !isImplausibleBatch(m[1])) {
        batch = m[1].toUpperCase().replace(/[^A-Z0-9\-\/]/g, "");
        batchConfident = true;
        break;
      }
      // label present but the value spilled onto the next line
      if (!batch && /(?:[b8]\s*a\s*t\s*[c(]\s*[hn]|[b8]\s*\.?\s*n\s*[o0]|[l1]\s*[o0]\s*t)\s*(?:n\s*[o0]\.?)?\s*[:.\-–=]?\s*$/i.test(lines[i])) {
        const next = (lines[i + 1] || "").toUpperCase();
        const cand = (next.match(/^[A-Z0-9][A-Z0-9\-\/]{2,14}/) || [])[0];
        if (cand && !isImplausibleBatch(cand)) {
          batch = cand;
          batchConfident = true;
          break;
        }
      }
    }

    /* ---- medicine name ---- */
    let bestLine = "";
    let bestScore = -Infinity;

    lines.forEach((line, idx) => {
      const s = scoreMedicineNameLine(line, idx, lines.length);
      if (s > bestScore) {
        bestScore = s;
        bestLine = line;
      }
    });

    if (!batch) {
      // No label found. Fall back to an alphanumeric token that mixes
      // letters and digits and does not look like a date/price/strength.
      // Real batch codes are digit-dense, so a long mostly-alphabetic
      // token (e.g. an OCR-mangled product name) is rejected.
      const tokenRe = /\b(?=[A-Z0-9\-\/]{4,14}\b)(?=[A-Z0-9\-\/]*[0-9])(?=[A-Z0-9\-\/]*[A-Z])[A-Z0-9\-\/]{4,14}\b/g;
      outer:
      for (const line of lines) {
        // never harvest the line we believe is the product name
        if (line === bestLine) continue;

        const upper = line.toUpperCase();
        // skip lines that are clearly about price/expiry/manufacturing
        if (/\b(?:MRP|PRICE|RS|INR|EXP|EXPIRY|MFG|MFD)\b/.test(upper) &&
            !/(?:BATCH|B\.?\s*NO|LOT)/.test(upper)) {
          continue;
        }
        let m;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(upper)) !== null) {
          const token = m[0];
          if (isImplausibleBatch(token)) continue;

          const digitCount = (token.match(/[0-9]/g) || []).length;
          // a single stray digit inside a long word is OCR noise, not a batch
          if (digitCount < 2 && token.length > 8) continue;
          if (OCR_DOSAGE_FORM_RE.test(token)) continue;

          batch = token;
          break outer;
        }
      }
    }

    // tidy the chosen line: drop leading/trailing punctuation noise
    let medicineName = bestLine
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[^A-Za-z0-9%)\]]+$/, "")
      .trim();

    let dbMatch = matchNameAgainstDatabase(medicineName);

    // If the winning line is weak or unmatched, try every other line —
    // the product name may have been mangled on the line we picked.
    if (!dbMatch || bestScore < 25) {
      let altBest = dbMatch;
      for (const line of lines) {
        if (OCR_LABEL_RE.test(line)) continue;
        const m = matchNameAgainstDatabase(line);
        if (m && (!altBest || m.similarity > altBest.similarity)) {
          altBest = m;
        }
      }
      if (altBest && (!dbMatch || altBest.similarity > dbMatch.similarity)) {
        dbMatch = altBest;
      }
    }

    let nameFromDatabase = false;
    if (dbMatch && dbMatch.similarity >= 0.74) {
      // reuse the spelling that already exists in the loaded dataset
      medicineName = dbMatch.name;
      nameFromDatabase = true;
    }

    const nameLooksUsable = medicineName.length >= 4 && medicineName.length <= 70;
    const strongLine = bestScore >= 35;
    const ocrQualityOk = typeof meanConfidence !== "number" || meanConfidence >= 70;

    const confident =
      nameLooksUsable &&
      !!batch &&
      batchConfident &&
      ocrQualityOk &&
      (nameFromDatabase || strongLine);

    return {
      medicineName,
      batchNumber: batch,
      confident,
      nameFromDatabase,
      nameScore: bestScore,
      batchConfident,
      meanConfidence: typeof meanConfidence === "number" ? meanConfidence : null,
      rawText
    };
  }

  /* ---------------- OCR runner ---------------- */

  /**
   * Candidate attempts, cheapest/most-likely first. PSM 3 (automatic)
   * is Tesseract's own default and handles the mixed layout of a
   * medicine pack far better than a forced uniform-block mode.
   *   3  = fully automatic page segmentation
   *   4  = single column of text of variable sizes
   *   11 = sparse text, find as much as possible in no particular order
   */
  const OCR_ATTEMPTS = [
    { psm: "3", useOriginal: false, label: "auto layout" },
    { psm: "11", useOriginal: false, label: "sparse text" },
    { psm: "4", useOriginal: false, label: "single column" },
    { psm: "3", useOriginal: true, label: "unprocessed image" }
  ];

  /** Ranks one OCR attempt. Higher is better. */
  function scoreOcrAttempt(parsed, data) {
    let score = 0;
    if (parsed.confident) score += 100;
    if (parsed.nameFromDatabase) score += 60;
    if (parsed.batchConfident) score += 30;
    if (parsed.medicineName) score += 10;
    if (parsed.batchNumber) score += 10;
    if (parsed.nameScore > 0) score += Math.min(30, parsed.nameScore / 4);
    if (data && typeof data.confidence === "number") score += data.confidence / 5;

    // reward readable output: a garbled pass produces few real words
    const words = (parsed.rawText.match(/\b[A-Za-z]{3,}\b/g) || []).length;
    score += Math.min(25, words);
    return score;
  }

  /** Merges the fields of a weaker attempt into the winner. */
  function mergeOcrResults(winner, other) {
    if (!other) return winner;
    if (!winner.medicineName && other.medicineName) {
      winner.medicineName = other.medicineName;
      winner.nameFromDatabase = other.nameFromDatabase;
    }
    if (!winner.batchNumber && other.batchNumber) {
      winner.batchNumber = other.batchNumber;
      winner.batchConfident = other.batchConfident;
    }
    return winner;
  }

  /**
   * Tries several page-segmentation modes and keeps the best result.
   * Stops early as soon as an attempt is confident, so a clear photo
   * still finishes in roughly one pass.
   */
  async function runOcr(processedSource, originalSource, onProgress, onStage) {
    const T = window.Tesseract;
    const attempts = [];

    if (T && typeof T.createWorker === "function") {
      let worker = null;
      try {
        worker = await T.createWorker("eng", 1, {
          logger: (m) => {
            if (m && m.status === "recognizing text" && typeof m.progress === "number") {
              onProgress(m.progress);
            }
          }
        });

        await worker.setParameters({
          preserve_interword_spaces: "1",
          user_defined_dpi: "300"
        });

        let best = null;
        let bestScore = -Infinity;

        for (let i = 0; i < OCR_ATTEMPTS.length; i++) {
          const attempt = OCR_ATTEMPTS[i];
          const source = attempt.useOriginal ? originalSource : processedSource;
          if (!source) continue;

          if (onStage) onStage(attempt.label, i + 1, OCR_ATTEMPTS.length);

          await worker.setParameters({ tessedit_pageseg_mode: attempt.psm });

          let data;
          try {
            const res = await worker.recognize(source);
            data = res && res.data ? res.data : null;
          } catch (attemptErr) {
            console.warn("Pharma Shield: OCR attempt failed (" + attempt.label + ")", attemptErr);
            continue;
          }
          if (!data) continue;

          const parsed = parseOcrText(data.text || "", data.confidence);
          parsed.attemptLabel = attempt.label;
          const score = scoreOcrAttempt(parsed, data);
          attempts.push({ parsed, score });

          if (score > bestScore) {
            bestScore = score;
            best = parsed;
          }

          // good enough — don't burn time on the remaining modes
          if (parsed.confident) break;
        }

        await worker.terminate();
        worker = null;

        if (best) {
          for (const a of attempts) {
            if (a.parsed !== best) mergeOcrResults(best, a.parsed);
          }
          best.allAttempts = attempts.map((a) => ({
            label: a.parsed.attemptLabel,
            score: Math.round(a.score),
            text: a.parsed.rawText
          }));
          return best;
        }
      } catch (err) {
        if (worker) {
          try { await worker.terminate(); } catch (e) { /* ignore */ }
        }
        console.warn("Pharma Shield: OCR worker path failed, using basic recognize().", err);
      }
    }

    // Fallback: the simple API, Tesseract's own default segmentation.
    const { data } = await T.recognize(processedSource || originalSource, "eng", {
      logger: (m) => {
        if (m && m.status === "recognizing text" && typeof m.progress === "number") {
          onProgress(m.progress);
        }
      }
    });
    const parsed = parseOcrText((data && data.text) || "", data && data.confidence);
    parsed.allAttempts = [{ label: "default", score: 0, text: parsed.rawText }];
    return parsed;
  }

  /** Builds (once) the collapsible panel that shows exactly what the
   *  scanner read. Created in JS so index.html stays untouched. */
  function ensureRawTextPanel(verifyBlock) {
    let box = el("#scan-raw-details");
    if (box) return box;

    box = document.createElement("details");
    box.id = "scan-raw-details";
    box.className = "scan-raw-details";

    const summary = document.createElement("summary");
    summary.textContent = "Show what the scanner actually read";
    box.appendChild(summary);

    const pre = document.createElement("pre");
    pre.id = "scan-raw-text";
    pre.className = "scan-raw-text";
    box.appendChild(pre);

    verifyBlock.appendChild(box);
    return box;
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

    let previewUrl = null;

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

      // preview always shows the ORIGINAL, untouched image
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      previewImg.src = previewUrl;

      statusEl.hidden = false;
      statusEl.className = "scan-status scan-status--busy";
      statusEl.textContent = "Loading scanner…";

      try {
        await loadTesseract();

        statusEl.textContent = "Preparing image…";

        // Build the enhanced copy that Tesseract will read. The original
        // is kept as a second candidate — sometimes preprocessing hurts.
        let ocrSource = null;
        let loaded = null;
        try {
          loaded = await loadImageElement(file);
          ocrSource = preprocessToCanvas(loaded.img);
        } catch (prepErr) {
          console.warn("Pharma Shield: preprocessing skipped.", prepErr);
        }

        statusEl.textContent = "Reading medicine package…";

        let stageLabel = "";
        const parsed = await runOcr(
          ocrSource || file,
          file,
          (progress) => {
            const pct = Math.round(progress * 100);
            statusEl.textContent = stageLabel
              ? `Reading medicine package (${stageLabel})… ${pct}%`
              : `Reading medicine package… ${pct}%`;
          },
          (label) => { stageLabel = label; }
        );

        if (loaded && loaded.url) URL.revokeObjectURL(loaded.url);

        statusEl.hidden = true;
        verifyBlock.hidden = false;
        nameField.value = parsed.medicineName;
        batchField.value = parsed.batchNumber;

        let noteText;
        let noteClass;

        if (parsed.confident) {
          noteText = parsed.nameFromDatabase
            ? "Text was read clearly and the medicine name matched an existing record. OCR is never 100% accurate — please confirm both fields before searching."
            : "Text was read clearly. OCR is never 100% accurate — please confirm both fields before searching.";
          noteClass = "scan-confidence scan-confidence--ok";
        } else if (parsed.medicineName || parsed.batchNumber) {
          noteText = "Please check or edit the extracted medicine name and batch number before searching.";
          noteClass = "scan-confidence scan-confidence--low";
        } else {
          noteText = "Nothing readable was extracted. Please check or edit the medicine name and batch number before searching, or try a sharper, well-lit photo.";
          noteClass = "scan-confidence scan-confidence--low";
        }

        confidenceNote.textContent = noteText;
        confidenceNote.className = noteClass;

        // Diagnostic view: exactly what each pass read.
        ensureRawTextPanel(verifyBlock);
        const rawPre = el("#scan-raw-text");
        if (rawPre) {
          const attempts = parsed.allAttempts || [
            { label: "default", score: 0, text: parsed.rawText }
          ];
          rawPre.textContent = attempts
            .map((a) => `--- pass: ${a.label} (score ${a.score}) ---\n${(a.text || "").trim() || "(nothing read)"}`)
            .join("\n\n");
        }
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
    initAlertFilter();
    renderSearchHistory();

    const container = el("#result-container");
    if (container) {
      container.innerHTML = renderEmptyResult();
      container.hidden = false;
    }

    await loadDrugData();
  });
})();
