// FCLM AA lookup content script.
// Receives a lookup request from the background service worker, fetches the
// employee timeDetails page (which accepts login, badge, or empl id as the
// `employeeId` query parameter), and scrapes the Employee Info box.

(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const FIELD_LABELS = {
    login: ['login', 'user id', 'alias'],
    employeeId: ['empl id', 'employee id', 'emp id'],
    badge: ['badge', 'badge id'],
    name: ['name', 'employee name', 'full name'],
    status: ['status'],
    agency: ['agency'],
    shift: ['shift'],
    deptId: ['dept id', 'department id'],
    location: ['location'],
    manager: ['manager']
  };

  function buildUrl(idValue, warehouseId) {
    const params = new URLSearchParams({
      warehouseId: warehouseId || 'IND8',
      employeeId: idValue
    });
    return `https://fclm-portal.amazon.com/employee/timeDetails?${params.toString()}`;
  }

  function normalizeLabel(text) {
    return (text || '').replace(/[: ]/g, '').trim().toLowerCase();
  }

  function matchFieldKey(label) {
    const norm = normalizeLabel(label);
    for (const [key, aliases] of Object.entries(FIELD_LABELS)) {
      if (aliases.includes(norm)) return key;
    }
    return null;
  }

  // The Employee Info box renders as label/value pairs. The exact markup
  // varies (table cells, dt/dd, divs), so walk the box and pair adjacent
  // bold/strong/th-style label nodes with their following text.
  function scrapeEmployeeInfo(doc) {
    const result = {};

    // Strategy 1: find an "Employee Info" section header, then pair labels
    // (b/strong/th/dt) inside it with the next text node.
    const headers = Array.from(doc.querySelectorAll('h1,h2,h3,h4,th,td,div,span,b,strong'));
    const empInfoHeader = headers.find(el =>
      /^\s*employee\s*info\s*$/i.test(el.textContent || '')
    );

    let scope = empInfoHeader ? empInfoHeader.closest('table, section, div, fieldset') : doc.body;
    if (!scope) scope = doc.body;

    // Pair adjacent label-like elements with their value.
    const labelNodes = scope.querySelectorAll('b, strong, th, dt, .label');
    labelNodes.forEach(labelEl => {
      const key = matchFieldKey(labelEl.textContent);
      if (!key || result[key]) return;

      let value = '';

      // Same row in a table: take the next td.
      const tr = labelEl.closest('tr');
      if (tr) {
        const cells = Array.from(tr.children);
        const idx = cells.findIndex(c => c.contains(labelEl));
        for (let i = idx + 1; i < cells.length; i++) {
          const txt = (cells[i].textContent || '').trim();
          if (txt) { value = txt; break; }
        }
      }

      // dl/dt/dd pairing.
      if (!value && labelEl.tagName === 'DT' && labelEl.nextElementSibling?.tagName === 'DD') {
        value = (labelEl.nextElementSibling.textContent || '').trim();
      }

      // Inline pairing: parent contains "Label: Value" — strip the label text.
      if (!value && labelEl.parentElement) {
        const parentText = (labelEl.parentElement.textContent || '').trim();
        const labelText = (labelEl.textContent || '').trim();
        if (parentText.startsWith(labelText)) {
          const remainder = parentText.slice(labelText.length).replace(/^[:\s ]+/, '').trim();
          // Avoid pulling in the next label by cutting at two consecutive newlines or another known label.
          value = remainder.split(/\n\s*\n/)[0].split(/\s{3,}/)[0].trim();
        }
      }

      // Sibling text node.
      if (!value && labelEl.nextSibling && labelEl.nextSibling.nodeType === 3) {
        value = (labelEl.nextSibling.textContent || '').replace(/^[:\s ]+/, '').trim();
      }

      if (value) result[key] = value;
    });

    return result;
  }

  function scrapeNameFallback(doc) {
    // Try the page <title> — often "Employee Time Details: Lastname, Firstname"
    const title = (doc.querySelector('title')?.textContent || '').trim();
    const titleMatch = title.match(/[-:]\s*([A-Za-z][A-Za-z'\-]+\s*,\s*[A-Za-z][A-Za-z'\- ]+)\s*$/);
    if (titleMatch) return titleMatch[1].trim();

    // Try a prominent header that looks like "Lastname, Firstname".
    const headers = doc.querySelectorAll('h1, h2, h3, .employee-name');
    for (const h of headers) {
      const t = (h.textContent || '').trim();
      if (/^[A-Za-z][A-Za-z'\-]+\s*,\s*[A-Za-z][A-Za-z'\- ]+$/.test(t)) return t;
    }
    return '';
  }

  async function lookupOne(idValue, warehouseId) {
    const url = buildUrl(idValue, warehouseId);
    let resp;
    try {
      resp = await fetch(url, { credentials: 'include' });
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}`, input: idValue };
    }
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, input: idValue };
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Detect "no employee found" pages — heuristics.
    const bodyText = (doc.body?.textContent || '').toLowerCase();
    if (/no\s+employee\s+found|invalid\s+employee|not\s+found/.test(bodyText) && !/login/.test(bodyText.slice(0, 4000))) {
      return { ok: false, error: 'Employee not found', input: idValue };
    }

    const fields = scrapeEmployeeInfo(doc);
    if (!fields.name) {
      const fallback = scrapeNameFallback(doc);
      if (fallback) fields.name = fallback;
    }

    if (!fields.login && !fields.employeeId && !fields.badge) {
      return { ok: false, error: 'Could not parse Employee Info — page layout may have changed', input: idValue };
    }

    return { ok: true, input: idValue, fields };
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'aaLookup') {
      lookupOne(message.idValue, message.warehouseId)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message, input: message.idValue }));
      return true;
    }
    if (message?.action === 'aaLookupPing') {
      sendResponse({ ok: true });
      return false;
    }
  });
})();
