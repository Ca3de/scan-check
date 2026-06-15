// ==UserScript==
// @name         FCLM Work Breakdown
// @namespace    https://github.com/Ca3de/scan-check
// @version      1.1.0
// @description  Shows percentage breakdown of work by size (Small/Medium/Large/HeavyBulky) and top processors per category on FCLM function rollup pages
// @author       Ca3de
// @match        https://fclm-portal.amazon.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'fclm-work-breakdown-panel';
  const STYLE_ID = 'fclm-work-breakdown-style';

  let darkMode = localStorage.getItem('wb-dark-mode') !== 'false';

  function computeTotalColumns(row) {
    let total = 0;
    for (const cell of row.querySelectorAll('th, td')) {
      total += parseInt(cell.getAttribute('colspan')) || 1;
    }
    return total;
  }

  function findUnitColumns(headerRows) {
    const columns = {
      login: -1,
      name: -1,
      categories: {}
    };

    if (!headerRows || headerRows.length === 0) return null;

    const totalCols = computeTotalColumns(headerRows[0]);
    if (totalCols < 5) return null;

    const grid = [];
    const cellSpans = [];

    for (let r = 0; r < headerRows.length; r++) {
      grid[r] = new Array(totalCols).fill('');
      cellSpans[r] = new Array(totalCols).fill(false);
    }

    for (let r = 0; r < headerRows.length; r++) {
      const cells = headerRows[r].querySelectorAll('th, td');
      let col = 0;
      for (const cell of cells) {
        while (col < totalCols && cellSpans[r][col]) col++;
        if (col >= totalCols) break;

        const text = cell.textContent.trim();
        const colspan = parseInt(cell.getAttribute('colspan')) || 1;
        const rowspan = parseInt(cell.getAttribute('rowspan')) || 1;

        for (let dr = 0; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) {
            if (r + dr < headerRows.length && col + dc < totalCols) {
              grid[r + dr][col + dc] = text;
              if (dr > 0) cellSpans[r + dr][col + dc] = true;
            }
          }
        }
        col += colspan;
      }
    }

    for (let c = 0; c < totalCols; c++) {
      for (let r = 0; r < grid.length; r++) {
        const lower = grid[r][c].toLowerCase();
        if (lower === 'login') columns.login = c;
        if (lower === 'name') columns.name = c;
      }
    }

    const sizeGroups = {};
    for (let r = 0; r < grid.length; r++) {
      let c = 0;
      while (c < totalCols) {
        const text = grid[r][c];
        const match = text.match(/EACH[- ]?(Small|Medium|Large|HeavyBulky|Total)/i);
        if (match) {
          const size = match[1];
          const start = c;
          let end = c;
          while (end + 1 < totalCols && grid[r][end + 1] === text) end++;
          if (!sizeGroups[size]) {
            sizeGroups[size] = { start, end };
          }
          c = end + 1;
        } else {
          c++;
        }
      }
    }

    if (Object.keys(sizeGroups).length === 0) return null;

    const lastRow = grid[grid.length - 1];
    for (let c = 0; c < totalCols; c++) {
      if (lastRow[c].toUpperCase() === 'UNIT') {
        for (const [size, range] of Object.entries(sizeGroups)) {
          if (size === 'Total') continue;
          if (c >= range.start && c <= range.end) {
            columns.categories[size] = c;
            break;
          }
        }
      }
    }

    if (Object.keys(columns.categories).length === 0) {
      for (const [size, range] of Object.entries(sizeGroups)) {
        if (size === 'Total') continue;
        columns.categories[size] = range.start;
      }
    }

    return Object.keys(columns.categories).length > 0 ? columns : null;
  }

  function parseTable(table) {
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return null;

    const headerRows = Array.from(thead.querySelectorAll('tr'));
    const dataRows = Array.from(tbody.querySelectorAll('tr'));

    if (headerRows.length === 0 || dataRows.length === 0) return null;

    const columns = findUnitColumns(headerRows);
    if (!columns) return null;

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

      if (columns.name >= 0 && columns.name < cells.length) {
        const nameCell = cells[columns.name];
        const nameLink = nameCell?.querySelector('a');
        worker.name = nameLink ? nameLink.textContent.trim() : nameCell?.textContent?.trim() || '';
      }

      if (columns.login >= 0 && columns.login < cells.length) {
        worker.login = cells[columns.login]?.textContent?.trim() || '';
      }

      let hasAnyUnits = false;
      for (const [size, colIdx] of Object.entries(columns.categories)) {
        if (colIdx < cells.length) {
          const val = parseFloat(cells[colIdx]?.textContent?.trim()) || 0;
          worker.units[size] = val;
          categoryTotals[size] += val;
          if (val > 0) hasAnyUnits = true;
        }
      }

      if (hasAnyUnits) workers.push(worker);
    }

    const grandTotal = Object.values(categoryTotals).reduce((s, v) => s + v, 0);
    if (grandTotal === 0) return null;

    const breakdown = [];
    for (const size of Object.keys(columns.categories)) {
      const total = categoryTotals[size];
      const pct = ((total / grandTotal) * 100).toFixed(1);

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
    const caption = table.querySelector('caption');
    if (caption) {
      const text = caption.textContent.trim();
      const match = text.match(/^(.+?)\s*\[\d+\]/);
      if (match) return match[1].trim();
      const short = text.split('\n')[0].trim();
      if (short.length > 0 && short.length < 100) return short;
    }
    let el = table;
    for (let depth = 0; depth < 5 && el; depth++) {
      let prev = el.previousElementSibling;
      for (let i = 0; i < 8 && prev; i++) {
        const text = prev.textContent.trim();
        if (text.length < 200 && /\[\d+\]/.test(text)) {
          return text.replace(/\s*\[\d+\].*/, '').trim();
        }
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return 'Unknown';
  }

  function getStyles() {
    const d = darkMode;
    return `
      #${PANEL_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 320px;
        background: ${d ? '#1a1a2e' : '#ffffff'};
        border-radius: 8px;
        box-shadow: 0 4px 20px ${d ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.15)'};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: ${d ? '#fff' : '#1a1a2e'};
        z-index: 999999;
        overflow: hidden;
      }
      #${PANEL_ID}.minimized .wb-body { display: none; }
      #${PANEL_ID}.minimized { width: auto; }
      .wb-header {
        background: ${d ? '#16213e' : '#e8eaf0'};
        padding: 10px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: move;
      }
      .wb-title { font-size: 13px; font-weight: 600; flex-grow: 1; }
      .wb-close, .wb-refresh, .wb-theme {
        background: none; border: none; color: ${d ? '#888' : '#666'}; cursor: pointer;
        font-size: 14px; padding: 0 4px;
      }
      .wb-close:hover, .wb-refresh:hover, .wb-theme:hover { color: ${d ? '#fff' : '#000'}; }
      .wb-body { padding: 12px; max-height: 70vh; overflow-y: auto; }
      .wb-section { margin-bottom: 16px; }
      .wb-section:last-child { margin-bottom: 0; }
      .wb-section-title { font-size: 13px; font-weight: 600; color: #ff9900; margin-bottom: 4px; }
      .wb-total { font-size: 10px; color: ${d ? '#888' : '#777'}; margin-bottom: 8px; }
      .wb-bars { margin-bottom: 8px; }
      .wb-bar-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .wb-bar-label { font-size: 11px; width: 75px; color: ${d ? '#ccc' : '#444'}; }
      .wb-bar-track { flex: 1; height: 14px; background: ${d ? '#0f0f1a' : '#e0e0e0'}; border-radius: 3px; overflow: hidden; }
      .wb-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
      .wb-bar-pct { font-size: 11px; width: 40px; text-align: right; font-weight: 600; }
      .wb-bar-count { font-size: 10px; color: ${d ? '#666' : '#888'}; width: 55px; text-align: right; }
      .wb-top-title { font-size: 10px; color: ${d ? '#888' : '#777'}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
      .wb-top-list { background: ${d ? '#0f0f1a' : '#f0f1f3'}; border-radius: 4px; padding: 6px 8px; }
      .wb-top-item { font-size: 11px; padding: 2px 0; display: flex; gap: 6px; }
      .wb-top-cat { font-weight: 600; width: 75px; }
      .wb-top-name { color: ${d ? '#fff' : '#1a1a2e'}; flex: 1; }
      .wb-top-units { color: ${d ? '#666' : '#888'}; }
      .wb-empty { text-align: center; color: ${d ? '#666' : '#999'}; font-size: 12px; padding: 20px 0; }
    `;
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
        <button class="wb-theme" id="wb-theme" title="Toggle light/dark mode">${darkMode ? '☀' : '☾'}</button>
        <button class="wb-refresh" id="wb-refresh" title="Refresh">↻</button>
        <button class="wb-close" id="wb-close" title="Minimize">_</button>
      </div>
      <div class="wb-body" id="wb-body">${html || '<div class="wb-empty">No unit data found on this page</div>'}</div>
    `;

    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = getStyles();

    document.body.appendChild(panel);

    document.getElementById('wb-close').addEventListener('click', () => {
      panel.classList.toggle('minimized');
    });

    document.getElementById('wb-refresh').addEventListener('click', () => {
      analyze();
    });

    document.getElementById('wb-theme').addEventListener('click', () => {
      darkMode = !darkMode;
      localStorage.setItem('wb-dark-mode', darkMode);
      styleEl.textContent = getStyles();
      document.getElementById('wb-theme').textContent = darkMode ? '☀' : '☾';
    });

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
    const seenTotals = new Set();

    for (const table of tables) {
      if (table.querySelector('table')) continue;

      const data = parseTable(table);
      if (data) {
        const key = data.grandTotal + '-' + data.workerCount;
        if (seenTotals.has(key)) continue;
        seenTotals.add(key);

        const name = findSectionName(table);
        sections.push({ name, data });
      }
    }

    createPanel(sections);
  }

  function init() {
    if (document.querySelector('table')) {
      analyze();
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1000));
  }

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
