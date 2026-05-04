// FCLM employee lookup — runs inside the sidebar page.
// `host_permissions` covers fclm-portal.amazon.com, so fetch sends cookies.

(function (global) {
  'use strict';

  const FIELD_LABELS = {
    login: ['login', 'user id', 'alias'],
    employeeId: ['empl id', 'employee id', 'emp id', 'empid'],
    badge: ['badge', 'badge id', 'badgeid'],
    name: ['name', 'employee name', 'full name'],
    status: ['status'],
    agency: ['agency'],
    shift: ['shift'],
    deptId: ['dept id', 'department id', 'deptid'],
    location: ['location'],
    manager: ['manager']
  };

  const LABEL_TAGS = new Set(['B', 'STRONG', 'TH', 'DT', 'LABEL']);
  const BLOCK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);

  function buildUrl(idValue, warehouseId) {
    const params = new URLSearchParams({
      warehouseId: warehouseId || 'IND8',
      employeeId: idValue
    });
    return `https://fclm-portal.amazon.com/employee/timeDetails?${params.toString()}`;
  }

  function normalizeLabel(text) {
    return (text || '').replace(/[: \t\n\r]/g, '').toLowerCase();
  }

  function matchFieldKey(label) {
    const norm = normalizeLabel(label);
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

  async function lookup(idValue, warehouseId) {
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

    if (looksLikeAuthPage(doc, resp.url)) {
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

  global.FCLM = { lookup };
})(window);
