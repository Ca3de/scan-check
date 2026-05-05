// FCLM employee lookup — runs inside the sidebar page.
// The HTML fetch is delegated to the background, which executes it inside
// an FCLM tab via chrome.scripting.executeScript. Parsing happens here
// because the sidebar has DOMParser.

(function (global) {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // Aliases are stored pre-normalized (lowercase, no whitespace/colons)
  // so they match whatever normalizeLabel() produces from page text.
  const RAW_LABELS = {
    login: ['login', 'user id', 'alias'],
    employeeId: ['empl id', 'employee id', 'emp id', 'empid', 'emplid'],
    badge: ['badge', 'badge id', 'badgeid'],
    name: ['name', 'employee name', 'full name'],
    status: ['status'],
    agency: ['agency'],
    shift: ['shift'],
    deptId: ['dept id', 'department id', 'deptid'],
    location: ['location'],
    manager: ['manager']
  };

  function normalizeLabel(text) {
    return (text || '').replace(/[: \t\n\r]/g, '').toLowerCase();
  }

  // Build the actual lookup table with normalized aliases.
  const FIELD_LABELS = Object.fromEntries(
    Object.entries(RAW_LABELS).map(([k, v]) => [k, v.map(normalizeLabel)])
  );

  const LABEL_TAGS = new Set(['B', 'STRONG', 'TH', 'DT', 'LABEL']);
  const BLOCK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);

  function buildUrl(idValue, warehouseId) {
    const params = new URLSearchParams({
      warehouseId: warehouseId || 'IND8',
      employeeId: idValue
    });
    return `https://fclm-portal.amazon.com/employee/timeDetails?${params.toString()}`;
  }

  function matchFieldKey(label) {
    const norm = normalizeLabel(label);
    if (!norm) return null;
    for (const [key, aliases] of Object.entries(FIELD_LABELS)) {
      if (aliases.includes(norm)) return key;
    }
    return null;
  }

  function isLabelLikeElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!LABEL_TAGS.has(el.tagName)) return false;
    return matchFieldKey(el.textContent) !== null;
  }

  // Extract the value that follows a label element. Walk forward through
  // siblings, accumulating text until we hit a block boundary (BR/DIV/etc.)
  // or another label element, or a too-long run that suggests we walked into
  // an unrelated section. The result is trimmed and de-colonned.
  function extractValueAfter(labelEl) {
    // Definition list: <dt>Label</dt> ... <dd>Value</dd> — the <dd> *is*
    // the value, not a block boundary.
    if (labelEl.tagName === 'DT') {
      let s = labelEl.nextElementSibling;
      while (s && s.tagName !== 'DD' && !isLabelLikeElement(s)) {
        s = s.nextElementSibling;
      }
      if (s && s.tagName === 'DD') {
        let v = (s.textContent || '').trim().replace(/\s+/g, ' ');
        if (v.length > 200) v = v.slice(0, 200);
        return v;
      }
      return '';
    }

    let text = '';
    let node = labelEl.nextSibling;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (BLOCK_TAGS.has(tag)) break;
        if (isLabelLikeElement(node)) break;
        // Inline element like <span>, <a>, <em>: include its text.
        text += node.textContent || '';
      } else if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || '';
      }
      node = node.nextSibling;
    }
    text = text.replace(/^[:\s]+/, '').replace(/\s+$/, '');
    text = text.replace(/\s+/g, ' ');
    if (text.length > 200) text = text.slice(0, 200);
    return text;
  }

  // If the label sits in its own table cell, the value is in the next cell.
  function extractValueFromAdjacentCell(labelEl) {
    const ownCell = labelEl.closest('td, th');
    if (!ownCell) return '';
    // Only treat label as "owning" the cell if the cell text matches the
    // label text closely (no extra inline value).
    const cellText = (ownCell.textContent || '').trim();
    const labelText = (labelEl.textContent || '').trim().replace(/[: ]+$/, '');
    if (cellText.replace(/[: ]+$/, '').trim() !== labelText) return '';
    let sib = ownCell.nextElementSibling;
    while (sib && !/^(TD|TH)$/.test(sib.tagName)) sib = sib.nextElementSibling;
    if (!sib) return '';
    let val = (sib.textContent || '').trim();
    val = val.replace(/\s+/g, ' ');
    if (val.length > 200) val = val.slice(0, 200);
    return val;
  }

  function scrapeEmployeeInfo(doc) {
    const result = {};
    const labelNodes = doc.querySelectorAll('b, strong, th, dt, label');

    labelNodes.forEach(el => {
      const key = matchFieldKey(el.textContent);
      if (!key || result[key]) return;

      let value = extractValueFromAdjacentCell(el);
      if (!value) value = extractValueAfter(el);

      // Reject obvious garbage: if the value contains another known label
      // word, we walked too far.
      if (value) {
        const lower = ' ' + value.toLowerCase() + ' ';
        const containsAnotherLabel = Object.values(FIELD_LABELS).some(aliases =>
          aliases.some(a => lower.includes(' ' + a + ' '))
        );
        if (containsAnotherLabel) return;
        result[key] = value;
      }
    });

    return result;
  }

  // The empDetailCard title renders as "Lastname,Firstname (login)" inside
  // a .fold-control span. Strip the trailing "(login)" to get the name.
  function scrapeNameFallback(doc) {
    const card = doc.querySelector('.empDetailCard .fold-control, .empDetailCard .title');
    if (card) {
      const raw = (card.textContent || '').trim().replace(/\s+/g, ' ');
      const m = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (m && /,/.test(m[1])) return m[1].trim();
      if (/,/.test(raw)) return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    }
    // Photo alt attribute is also "Lastname,Firstname".
    const photo = doc.querySelector('.badgePhoto img[alt]');
    if (photo) {
      const alt = (photo.getAttribute('alt') || '').trim();
      if (/,/.test(alt)) return alt;
    }
    const title = (doc.querySelector('title')?.textContent || '').trim();
    const titleMatch = title.match(/[-:]\s*([A-Za-z][A-Za-z'\-]+\s*,\s*[A-Za-z][A-Za-z'\- ]+)\s*$/);
    if (titleMatch) return titleMatch[1].trim();
    return '';
  }

  // Detect the FCLM login redirect / unauth response.
  function looksLikeAuthPage(doc, finalUrl) {
    if (/\/login|\/auth|midway/i.test(finalUrl)) return true;
    const t = (doc.querySelector('title')?.textContent || '').toLowerCase();
    if (/sign in|midway|login/.test(t)) return true;
    return false;
  }

  function sendBg(message) {
    return new Promise((resolve, reject) => {
      try {
        const cb = (resp) => {
          const err = api.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        };
        const ret = api.runtime.sendMessage(message, cb);
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function lookup(idValue, warehouseId) {
    const url = buildUrl(idValue, warehouseId);
    let resp;
    try {
      resp = await sendBg({ action: 'fclmFetch', url });
    } catch (err) {
      return { ok: false, error: `Background error: ${err.message}`, input: idValue };
    }
    if (!resp) {
      return { ok: false, error: 'No response from background', input: idValue };
    }
    if (!resp.ok) {
      return { ok: false, error: resp.error || `HTTP ${resp.status || '?'}`, input: idValue };
    }
    const html = resp.html || '';
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (looksLikeAuthPage(doc, resp.finalUrl || url)) {
      return { ok: false, error: 'Not logged in to FCLM — open fclm-portal.amazon.com and sign in', input: idValue };
    }

    const bodyText = (doc.body?.textContent || '').toLowerCase().slice(0, 4000);
    if (/no\s+employee\s+found|invalid\s+employee|employee\s+does\s+not\s+exist/.test(bodyText)) {
      return { ok: false, error: 'Employee not found', input: idValue };
    }

    const fields = scrapeEmployeeInfo(doc);
    if (!fields.name) {
      const nm = scrapeNameFallback(doc);
      if (nm) fields.name = nm;
    }

    if (!fields.login && !fields.employeeId && !fields.badge) {
      return { ok: false, error: 'Could not parse Employee Info — page layout may have changed', input: idValue };
    }

    return { ok: true, input: idValue, fields };
  }

  // ============== Name search ==============

  function buildSearchUrl(term, warehouseId) {
    const params = new URLSearchParams({
      term,
      warehouseId: warehouseId || 'IND8',
      startHourIntraday1: '0',
      startMinuteIntraday1: '0',
      startHourIntraday2: '0',
      startMinuteIntraday2: '0',
      startHourIntraday3: '18',
      startMinuteIntraday3: '0',
      startHourIntraday4: '6',
      startMinuteIntraday4: '0'
    });
    return `https://fclm-portal.amazon.com/search?${params.toString()}`;
  }

  function getTableHeaderTexts(table) {
    const thead = table.querySelector('thead');
    if (thead) {
      const cells = thead.querySelectorAll('th, td');
      if (cells.length) return Array.from(cells).map(c => (c.textContent || '').trim());
    }
    const firstRow = table.querySelector('tr');
    if (!firstRow) return [];
    return Array.from(firstRow.querySelectorAll('th, td')).map(c => (c.textContent || '').trim());
  }

  function parseSearchResults(doc) {
    const tables = Array.from(doc.querySelectorAll('table'));
    const all = [];
    for (const table of tables) {
      const headers = getTableHeaderTexts(table);
      if (!headers.length) continue;
      const headerKeys = headers.map(h => matchFieldKey(h));
      const knownCount = headerKeys.filter(k => !!k).length;
      if (knownCount < 2) continue;

      const tbody = table.querySelector('tbody') || table;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const skipFirst = !table.querySelector('thead');

      for (let i = skipFirst ? 1 : 0; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td, th'));
        if (!cells.length) continue;
        const obj = {};
        headerKeys.forEach((key, idx) => {
          if (!key || !cells[idx]) return;
          const text = (cells[idx].textContent || '').trim().replace(/\s+/g, ' ');
          if (text) obj[key] = text;
        });
        // Pull login/employeeId from any timeDetails link in the row.
        const link = rows[i].querySelector('a[href*="/employee/timeDetails"]');
        if (link) {
          const m = (link.getAttribute('href') || '').match(/employeeId=([^&]+)/);
          if (m) {
            const v = decodeURIComponent(m[1]);
            if (/^\d+$/.test(v) && !obj.employeeId) obj.employeeId = v;
            else if (/^[a-z][a-z0-9._-]*$/i.test(v) && !obj.login) obj.login = v;
          }
        }
        if (obj.name || obj.login || obj.employeeId || obj.badge) all.push(obj);
      }
      if (all.length) return all;
    }

    // Fallback: scrape any timeDetails links on the page.
    const links = Array.from(doc.querySelectorAll('a[href*="/employee/timeDetails"]'));
    const seen = new Set();
    for (const a of links) {
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      const m = (a.getAttribute('href') || '').match(/employeeId=([^&]+)/);
      if (!m) continue;
      const v = decodeURIComponent(m[1]);
      if (seen.has(v)) continue;
      seen.add(v);
      const obj = {};
      if (/,/.test(text)) obj.name = text;
      if (/^\d+$/.test(v)) obj.employeeId = v;
      else if (/^[a-z][a-z0-9._-]*$/i.test(v)) obj.login = v;
      if (Object.keys(obj).length) all.push(obj);
    }
    return all;
  }

  async function searchByName(term, warehouseId) {
    const url = buildSearchUrl(term, warehouseId);
    let resp;
    try {
      resp = await sendBg({ action: 'fclmFetch', url });
    } catch (err) {
      return { ok: false, error: `Background error: ${err.message}`, term };
    }
    if (!resp || !resp.ok) {
      return { ok: false, error: resp?.error || `HTTP ${resp?.status || '?'}`, term };
    }
    const doc = new DOMParser().parseFromString(resp.html || '', 'text/html');
    if (looksLikeAuthPage(doc, resp.finalUrl || url)) {
      return { ok: false, error: 'Not logged in to FCLM — open fclm-portal.amazon.com and sign in', term };
    }
    const matches = parseSearchResults(doc);
    return { ok: true, term, matches };
  }

  // Heuristic: does this look like a free-text name (vs. login/badge/empl id)?
  // - Pure digits → ID
  // - Lowercase login-shape (e.g. "oladeisr") → ID
  // - Anything else with letters (commas, spaces, leading uppercase) → name
  function looksLikeName(input) {
    const v = (input || '').trim();
    if (!v) return false;
    if (/^\d+$/.test(v)) return false;
    if (/^[a-z][a-z0-9._-]{2,15}$/.test(v)) return false;
    return /[A-Za-z]/.test(v);
  }

  global.FCLM = { lookup, searchByName, looksLikeName };
})(window);
