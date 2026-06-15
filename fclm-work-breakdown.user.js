// ==UserScript==
// @name         FCLM Work Breakdown
// @namespace    https://github.com/Ca3de/scan-check
// @version      1.0.0
// @description  Shows percentage breakdown of work by size (Small/Medium/Large/HeavyBulky) and top processors per category on FCLM function rollup pages
// @author       Ca3de
// @match        https://fclm-portal.amazon.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'fclm-work-breakdown-panel';

  function findUnitColumns(headerRows) {
    // Find column indices for EACH-Small UNIT, EACH-Medium UNIT, etc.
    // The header typically has two rows:
    //   Row 1: grouped headers (EachStowed spanning multiple cols)
    //   Row 2: UNIT / UPH sub-headers
    // We need to find columns labeled "UNIT" under each EACH-{size} group

    const columns = {
      login: -1,
      name: -1,
      categories: {} // { 'Small': unitColIndex, 'Medium': unitColIndex, ... }
    };

    if (!headerRows || headerRows.length === 0) return null;

    // Strategy: scan ALL header cells across all rows to build a column map
    // Track which "EACH-{Size}" group we're in, then find UNIT columns within it
    const firstRow = headerRows[0];
    const allCells = firstRow.querySelectorAll('th, td');

    // Build a flat column map accounting for colspans
    let colPosition = 0;
    const colMap = []; // [{text, startCol, endCol}]

    for (const cell of allCells) {
      const text = cell.textContent.trim();
      const colspan = parseInt(cell.getAttribute('colspan')) || 1;
      colMap.push({ text, startCol: colPosition, endCol: colPosition + colspan - 1 });

      // Find login and name columns
      const lower = text.toLowerCase();
      if (lower === 'login') columns.login = colPosition;
      if (lower === 'name') columns.name = colPosition;

      colPosition += colspan;
    }

    // Find EACH-{Size} groups from first header row
    const sizeGroups = {}; // { 'Small': {start, end}, ... }
    for (const entry of colMap) {
      const match = entry.text.match(/EACH[- ]?(Small|Medium|Large|HeavyBulky|Total)/i);
      if (match) {
        const size = match[1];
        sizeGroups[size] = { start: entry.startCol, end: entry.endCol };
      }
    }

    // If no EACH groups found in first row, try looking for them differently
    if (Object.keys(sizeGroups).length === 0) return null;

    // Now find UNIT columns in the second header row
    if (headerRows.length >= 2) {
      const secondRow = headerRows[1];
      const subCells = secondRow.querySelectorAll('th, td');
      let subCol = 0;

      // Account for cells that span from the first row
      // The second row starts where first-row cells with rowspan=1 left gaps
      // Simpler approach: count through second row cells and match to column positions

      // First, figure out which columns are NOT covered by rowspan from first row
      const coveredByRowspan = new Set();
      for (const cell of allCells) {
        const rowspan = parseInt(cell.getAttribute('rowspan')) || 1;
        if (rowspan > 1) {
          const colspan = parseInt(cell.getAttribute('colspan')) || 1;
          const startCol = colMap.find(e => e.text === cell.textContent.trim())?.startCol;
          if (startCol !== undefined) {
            for (let c = startCol; c < startCol + colspan; c++) {
              coveredByRowspan.add(c);
            }
          }
        }
      }

      // Map second row cells to actual column positions
      let actualCol = 0;
      for (const cell of subCells) {
        // Skip columns covered by rowspan from first row
        while (coveredByRowspan.has(actualCol)) actualCol++;

        const text = cell.textContent.trim().toUpperCase();
        const colspan = parseInt(cell.getAttribute('colspan')) || 1;

        if (text === 'UNIT') {
          // Which size group does this UNIT column belong to?
          for (const [size, range] of Object.entries(sizeGroups)) {
            if (size === 'Total') continue;
            if (actualCol >= range.start && actualCol <= range.end) {
              columns.categories[size] = actualCol;
              break;
            }
          }
        }

        actualCol += colspan;
      }
    }

    // If we couldn't find UNIT sub-columns, try using the EACH group start columns directly
    // (some tables may not have UNIT/UPH split)
    if (Object.keys(columns.categories).length === 0) {
      for (const [size, range] of Object.entries(sizeGroups)) {
        if (size === 'Total') continue;
        columns.categories[size] = range.start;
      }
    }

    return Object.keys(columns.categories).length > 0 ? columns : null;
  }

  function parseTable(table) {
    const rows = table.querySelectorAll('tr');
    if (rows.length < 3) return null;

    // Find header rows (rows with th elements or header-like td)
    const headerRows = [];
    const dataRows = [];
    let totalRow = null;

    for (const row of rows) {
      const ths = row.querySelectorAll('th');
      const tds = row.querySelectorAll('td');

      if (ths.length > 0) {
        headerRows.push(row);
      } else if (tds.length > 0) {
        const firstCell = tds[0]?.textContent?.trim();
        if (firstCell === 'Total') {
          totalRow = row;
        } else if (firstCell === 'AMZN' || firstCell === 'TEMP') {
          dataRows.push(row);
        }
      }
    }

    if (headerRows.length === 0 || dataRows.length === 0) return null;

    const columns = findUnitColumns(headerRows);
    if (!columns) return null;

    // Parse data rows
    const workers = [];
    const categoryTotals = {};

    for (const size of Object.keys(columns.categories)) {
      categoryTotals[size] = 0;
    }

    for (const row of dataRows) {
      const cells = row.querySelectorAll('td');
      const worker = {
        name: '',
        login: '',
        units: {}
      };

      // Get name
      if (columns.name >= 0 && columns.name < cells.length) {
        const nameCell = cells[columns.name];
        const nameLink = nameCell?.querySelector('a');
        worker.name = nameLink ? nameLink.textContent.trim() : nameCell?.textContent?.trim() || '';
      }

      // Get login
      if (columns.login >= 0 && columns.login < cells.length) {
        worker.login = cells[columns.login]?.textContent?.trim() || '';
      }

      // Get units per category
      for (const [size, colIdx] of Object.entries(columns.categories)) {
        if (colIdx < cells.length) {
          const val = parseFloat(cells[colIdx]?.textContent?.trim()) || 0;
          worker.units[size] = val;
          categoryTotals[size] += val;
        }
      }

      workers.push(worker);
    }

    // Calculate grand total
    const grandTotal = Object.values(categoryTotals).reduce((s, v) => s + v, 0);
    if (grandTotal === 0) return null;

    // Calculate percentages and find top processors
    const breakdown = [];
    for (const size of Object.keys(columns.categories)) {
      const total = categoryTotals[size];
      const pct = ((total / grandTotal) * 100).toFixed(1);

      // Find top processor
      let topWorker = { name: '-', login: '-', units: 0 };
      for (const w of workers) {
        if ((w.units[size] || 0) > topWorker.units) {
          topWorker = { name: w.name, login: w.login, units: w.units[size] };
        }
      }

      breakdown.push({ size, total, pct, topWorker });
    }

    return { breakdown, grandTotal, workerCount: workers.length };
  }

  function findSectionName(table) {
    // Look for section header before the table (e.g., "Stow C Returns [4300006823]")
    let prev = table.previousElementSibling;
    for (let i = 0; i < 5 && prev; i++) {
      const text = prev.textContent.trim();
      if (text.includes('[') && /\[\d+\]/.test(text)) {
        return text.replace(/\s*\[\d+\].*/, '').trim();
      }
      prev = prev.previousElementSibling;
    }
    // Check table itself
    const text = table.textContent;
    const match = text.match(/([A-Za-z_ ]+)\s*\[\d+\]/);
    return match ? match[1].trim() : 'Unknown';
  }

  function createPanel(sections) {
    let existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    const colors = {
      Small: '#3b82f6',
      Medium: '#f59e0b',
      Large: '#ef4444',
      HeavyBulky: '#8b5cf6'
    };

    let html = '';
    for (const section of sections) {
      html += `<div class="wb-section">
        <div class="wb-section-title">${section.name}</div>
        <div class="wb-total">${section.data.grandTotal.toLocaleString()} total units | ${section.data.workerCount} workers</div>
        <div class="wb-bars">`;

      for (const item of section.data.breakdown) {
        if (item.total === 0) continue;
        const color = colors[item.size] || '#666';
        html += `<div class="wb-bar-row">
          <div class="wb-bar-label">${item.size}</div>
          <div class="wb-bar-track">
            <div class="wb-bar-fill" style="width:${item.pct}%;background:${color}"></div>
          </div>
          <div class="wb-bar-pct">${item.pct}%</div>
          <div class="wb-bar-count">(${item.total.toLocaleString()})</div>
        </div>`;
      }

      html += `</div><div class="wb-top-title">Top Processors</div><div class="wb-top-list">`;

      for (const item of section.data.breakdown) {
        if (item.total === 0 || item.topWorker.units === 0) continue;
        const color = colors[item.size] || '#666';
        html += `<div class="wb-top-item">
          <span class="wb-top-cat" style="color:${color}">${item.size}:</span>
          <span class="wb-top-name">${item.topWorker.login || item.topWorker.name}</span>
          <span class="wb-top-units">(${item.topWorker.units.toLocaleString()})</span>
        </div>`;
      }

      html += `</div></div>`;
    }

    panel.innerHTML = `
      <div class="wb-header">
        <span class="wb-title">Work Breakdown</span>
        <button class="wb-refresh" id="wb-refresh" title="Refresh">↻</button>
        <button class="wb-close" id="wb-close" title="Minimize">_</button>
      </div>
      <div class="wb-body" id="wb-body">${html || '<div class="wb-empty">No unit data found on this page</div>'}</div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 320px;
        background: #1a1a2e;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #fff;
        z-index: 999999;
        overflow: hidden;
      }
      #${PANEL_ID}.minimized .wb-body { display: none; }
      #${PANEL_ID}.minimized { width: auto; }
      .wb-header {
        background: #16213e;
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: move;
      }
      .wb-title { font-size: 13px; font-weight: 600; flex-grow: 1; }
      .wb-close, .wb-refresh {
        background: none; border: none; color: #888; cursor: pointer;
        font-size: 14px; padding: 0 4px;
      }
      .wb-close:hover, .wb-refresh:hover { color: #fff; }
      .wb-body { padding: 12px; max-height: 70vh; overflow-y: auto; }
      .wb-section { margin-bottom: 16px; }
      .wb-section:last-child { margin-bottom: 0; }
      .wb-section-title { font-size: 13px; font-weight: 600; color: #ff9900; margin-bottom: 4px; }
      .wb-total { font-size: 10px; color: #888; margin-bottom: 8px; }
      .wb-bars { margin-bottom: 8px; }
      .wb-bar-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .wb-bar-label { font-size: 11px; width: 75px; color: #ccc; }
      .wb-bar-track { flex: 1; height: 14px; background: #0f0f1a; border-radius: 3px; overflow: hidden; }
      .wb-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
      .wb-bar-pct { font-size: 11px; width: 40px; text-align: right; font-weight: 600; }
      .wb-bar-count { font-size: 10px; color: #666; width: 55px; text-align: right; }
      .wb-top-title { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
      .wb-top-list { background: #0f0f1a; border-radius: 4px; padding: 6px 8px; }
      .wb-top-item { font-size: 11px; padding: 2px 0; display: flex; gap: 6px; }
      .wb-top-cat { font-weight: 600; width: 75px; }
      .wb-top-name { color: #fff; flex: 1; }
      .wb-top-units { color: #666; }
      .wb-empty { text-align: center; color: #666; font-size: 12px; padding: 20px 0; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    // Minimize toggle
    document.getElementById('wb-close').addEventListener('click', () => {
      panel.classList.toggle('minimized');
    });

    // Refresh
    document.getElementById('wb-refresh').addEventListener('click', () => {
      analyze();
    });

    // Draggable
    const header = panel.querySelector('.wb-header');
    let dragging = false, ox, oy;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function analyze() {
    const tables = document.querySelectorAll('table');
    const sections = [];

    for (const table of tables) {
      // Skip tables that are just wrappers
      if (table.querySelector('table')) continue;

      const data = parseTable(table);
      if (data) {
        const name = findSectionName(table);
        sections.push({ name, data });
      }
    }

    createPanel(sections);
  }

  // Run analysis after page load, with retries for dynamic content
  function init() {
    // Only run on pages that look like function rollup reports
    if (document.querySelector('table')) {
      analyze();
    }
  }

  // Wait for page to be ready
  if (document.readyState === 'complete') {
    setTimeout(init, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1000));
  }

  // Re-analyze when page content changes (FCLM loads data dynamically)
  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(() => {
      if (document.querySelector('table') && !document.getElementById(PANEL_ID)) {
        analyze();
      }
    }, 2000);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
