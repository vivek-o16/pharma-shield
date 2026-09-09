/* =========================================================
   PHARMA SHIELD — Prohibited Drugs page
   Reads ./bannedDrugs.json (Section 26A dataset, 444 entries).
   Independent of script.js / drugAlerts.json — this page does
   not touch or depend on the main drug-alert search logic.
   ========================================================= */

(() => {
  "use strict";

  const DATA_URL = "./bannedDrugs.json";
  const PAGE_SIZE = 15;

  let ALL_ENTRIES = [];
  let FILTERED = [];
  let currentPage = 1;

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHTML(str) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(str ?? "").replace(/[&<>"']/g, (c) => map[c]);
  }

  function normalizeSearch(str) {
    return String(str ?? "").toLowerCase().trim();
  }

  /* ---------------- Data loading ---------------- */

  async function loadBannedDrugs() {
    const tbody = el("#prohibited-tbody");

    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("Bad response " + res.status);

      const json = await res.json();

      if (!Array.isArray(json.entries)) {
        throw new Error("Malformed prohibited-drugs dataset");
      }

      ALL_ENTRIES = json.entries;
      renderDocumentNotes(json.documentNotes);
    } catch (err) {
      console.error("Pharma Shield: could not load bannedDrugs.json.", err);
      tbody.innerHTML = `<tr><td colspan="5" class="prohibited-loading">Prohibited-drug dataset could not be loaded. Please refresh the page.</td></tr>`;
      el("#prohibited-total").textContent = "0";
      el("#prohibited-count").textContent = "Showing 0 of 0 entries";
      return;
    }

    FILTERED = ALL_ENTRIES;
    el("#prohibited-total").textContent = String(ALL_ENTRIES.length);
    currentPage = 1;
    renderTable();
  }

  function renderDocumentNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return;

    const wrap = el("#prohibited-notes-wrap");
    const list = el("#prohibited-notes-list");

    list.innerHTML = notes
      .map((n) => `<li>${escapeHTML(n)}</li>`)
      .join("");

    wrap.hidden = false;
  }

  /* ---------------- Search ---------------- */

  function matchesQuery(entry, query) {
    if (!query) return true;

    const haystacks = [
      entry.drugName,
      entry.notification,
      Array.isArray(entry.notificationDates) ? entry.notificationDates.join(" ") : "",
      entry.details
    ];

    return haystacks.some((h) => normalizeSearch(h).includes(query));
  }

  function runSearch(rawQuery) {
    const query = normalizeSearch(rawQuery);

    FILTERED = query
      ? ALL_ENTRIES.filter((e) => matchesQuery(e, query))
      : ALL_ENTRIES;

    currentPage = 1;
    renderTable();
  }

  /* ---------------- Table rendering ---------------- */

  function renderRow(entry) {
    const dates = Array.isArray(entry.notificationDates) && entry.notificationDates.length
      ? entry.notificationDates.join(", ")
      : "—";

    return `
      <tr>
        <td class="col-sr">${escapeHTML(entry.srNo)}</td>
        <td class="col-drug">${escapeHTML(entry.drugName || "—")}</td>
        <td class="col-notif">${escapeHTML(entry.notification || "—")}</td>
        <td class="col-date">${escapeHTML(dates)}</td>
        <td class="col-details">${escapeHTML(entry.details || "—")}</td>
      </tr>`;
  }

  function renderTable() {
    const tbody = el("#prohibited-tbody");
    const countLabel = el("#prohibited-count");

    if (!FILTERED.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="prohibited-loading">No prohibited-drug entries match this search.</td></tr>`;
      countLabel.textContent = "Showing 0 of " + ALL_ENTRIES.length + " entries";
      renderPagination();
      return;
    }

    const totalPages = Math.max(1, Math.ceil(FILTERED.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);

    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, FILTERED.length);
    const pageItems = FILTERED.slice(start, end);

    tbody.innerHTML = pageItems.map(renderRow).join("");

    const totalLabel = FILTERED.length === ALL_ENTRIES.length
      ? `${ALL_ENTRIES.length} entries`
      : `${FILTERED.length} of ${ALL_ENTRIES.length} entries`;

    countLabel.textContent = `Showing ${start + 1}–${end} of ${totalLabel}`;

    renderPagination();
  }

  /* ---------------- Pagination ---------------- */

  function buildPageList(current, total) {
    const pages = [];
    const add = (p) => pages.push(p);

    if (total <= 7) {
      for (let i = 1; i <= total; i++) add(i);
      return pages;
    }

    add(1);
    if (current > 3) add("…");

    const from = Math.max(2, current - 1);
    const to = Math.min(total - 1, current + 1);
    for (let i = from; i <= to; i++) add(i);

    if (current < total - 2) add("…");
    add(total);

    return pages;
  }

  function renderPagination() {
    const nav = el("#prohibited-pagination");
    const totalPages = Math.max(1, Math.ceil(FILTERED.length / PAGE_SIZE));

    if (totalPages <= 1) {
      nav.innerHTML = "";
      return;
    }

    const pages = buildPageList(currentPage, totalPages);

    const pageButtons = pages
      .map((p) => {
        if (p === "…") return `<span class="page-ellipsis">…</span>`;
        const active = p === currentPage ? " is-active" : "";
        return `<button type="button" class="page-btn${active}" data-page="${p}">${p}</button>`;
      })
      .join("");

    nav.innerHTML = `
      <button type="button" class="page-btn page-nav" id="page-prev" ${currentPage === 1 ? "disabled" : ""}>← Previous</button>
      <div class="page-numbers">${pageButtons}</div>
      <button type="button" class="page-btn page-nav" id="page-next" ${currentPage === totalPages ? "disabled" : ""}>Next →</button>
    `;

    const prevBtn = el("#page-prev");
    const nextBtn = el("#page-next");

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (currentPage > 1) {
          currentPage -= 1;
          renderTable();
          scrollToTableTop();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (currentPage < totalPages) {
          currentPage += 1;
          renderTable();
          scrollToTableTop();
        }
      });
    }

    els(".page-btn[data-page]", nav).forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = Number(btn.dataset.page);
        if (p && p !== currentPage) {
          currentPage = p;
          renderTable();
          scrollToTableTop();
        }
      });
    });
  }

  function scrollToTableTop() {
    const wrap = el(".prohibited-table-wrap");
    if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------- Search input ---------------- */

  function initSearch() {
    const input = el("#prohibited-search");
    input.addEventListener("input", (e) => runSearch(e.target.value));
  }

  /* ---------------- Nav (mobile toggle) ---------------- */

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
  }

  /* ---------------- Init ---------------- */

  document.addEventListener("DOMContentLoaded", async () => {
    initNav();
    initSearch();
    await loadBannedDrugs();
  });
})();
