// Sidebar UI controller. All FCLM fetching/parsing happens here via FCLM.lookup().

(function () {
  'use strict';

  const FIELD_LABELS = {
    login: 'Login',
    badge: 'Badge',
    employeeId: 'Empl ID',
    name: 'Name',
    status: 'Status',
    manager: 'Manager',
    shift: 'Shift',
    deptId: 'Dept ID',
    location: 'Location',
    agency: 'Agency'
  };

  const RECENT_KEY = 'aaLookup.recent';
  const SETTINGS_KEY = 'aaLookup.settings';
  const MAX_RECENT = 50;
  const REQUEST_DELAY_MS = 400;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_CACHE_ENTRIES = 1000;

  // ---------- in-memory cache ----------
  const cache = new Map();

  function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
    return e.value;
  }

  function cacheSet(key, value) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, ts: Date.now() });
  }

  async function lookupCached(idValue, warehouseId, useCache = true) {
    const k = `lookup::${warehouseId}::${idValue}`;
    if (useCache) {
      const hit = cacheGet(k);
      if (hit) return { ...hit, cached: true };
    }
    const res = await window.FCLM.lookup(idValue, warehouseId);
    if (res.ok) cacheSet(k, res);
    return res;
  }

  async function searchCached(term, warehouseId, useCache = true) {
    const k = `search::${warehouseId}::${term.toLowerCase()}`;
    if (useCache) {
      const hit = cacheGet(k);
      if (hit) return { ...hit, cached: true };
    }
    const res = await window.FCLM.searchByName(term, warehouseId);
    if (res.ok) cacheSet(k, res);
    return res;
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'recent') renderRecent();
    });
  });

  // ---------- settings persistence ----------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function saveSettings(patch) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  }

  const warehouseInput = document.getElementById('warehouseId');
  const settings = loadSettings();
  if (settings.warehouseId) warehouseInput.value = settings.warehouseId;
  warehouseInput.addEventListener('change', () => {
    saveSettings({ warehouseId: warehouseInput.value.trim() || 'IND8' });
  });
  function getWarehouse() { return (warehouseInput.value || 'IND8').trim(); }

  document.querySelectorAll('fieldset.output-fields').forEach(fs => {
    const tabId = fs.closest('.tab-panel').id;
    const stored = settings[`fields.${tabId}`];
    if (stored && Array.isArray(stored)) {
      fs.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = stored.includes(cb.dataset.field);
      });
    }
    fs.addEventListener('change', () => {
      const fields = Array.from(fs.querySelectorAll('input[type=checkbox]:checked'))
        .map(cb => cb.dataset.field);
      saveSettings({ [`fields.${tabId}`]: fields });
    });
  });

  function selectedFields(panelId) {
    return Array.from(document.querySelectorAll(`#${panelId} fieldset.output-fields input[type=checkbox]:checked`))
      .map(cb => cb.dataset.field);
  }

  // ---------- single lookup ----------
  const singleInput = document.getElementById('single-input-value');
  const singleInputType = document.getElementById('single-input-type');
  const singleResult = document.getElementById('single-result');
  const singleBtn = document.getElementById('single-lookup-btn');
  const matchesContainer = document.getElementById('single-matches');
  const matchListEl = document.getElementById('match-list');
  const matchesCountEl = document.getElementById('matches-count');

  function clearMatches() {
    matchListEl.innerHTML = '';
    matchesContainer.classList.add('hidden');
    matchesCountEl.textContent = '0 matches';
  }

  function shouldSearchByName(value) {
    const explicit = singleInputType.value;
    if (explicit === 'name') return true;
    if (explicit === 'auto') return window.FCLM.looksLikeName(value);
    return false;
  }

  async function doSingleLookup() {
    const value = singleInput.value.trim();
    if (!value) { renderError(singleResult, 'Enter or scan a value'); return; }
    singleBtn.disabled = true;
    clearMatches();
    singleResult.className = 'result';
    singleResult.textContent = shouldSearchByName(value) ? 'Searching...' : 'Looking up...';

    try {
      if (shouldSearchByName(value)) {
        await runNameSearch(value);
      } else {
        await runIdLookup(value);
      }
    } finally {
      singleBtn.disabled = false;
      singleInput.select();
    }
  }

  async function runIdLookup(value) {
    let resp;
    try {
      resp = await lookupCached(value, getWarehouse(), true);
    } catch (err) {
      renderError(singleResult, err.message);
      return;
    }
    if (!resp?.ok) {
      renderError(singleResult, resp?.error || 'Lookup failed');
      pushRecent({ input: value, error: resp?.error || 'Lookup failed' });
      return;
    }
    renderFields(singleResult, resp.fields, selectedFields('tab-single'), resp.cached);
    pushRecent({ input: value, fields: resp.fields, cached: !!resp.cached });
  }

  async function runNameSearch(term) {
    let resp;
    try {
      resp = await searchCached(term, getWarehouse(), true);
    } catch (err) {
      renderError(singleResult, err.message);
      return;
    }
    if (!resp?.ok) {
      renderError(singleResult, resp?.error || 'Search failed');
      pushRecent({ input: term, error: resp?.error || 'Search failed' });
      return;
    }
    const matches = resp.matches || [];
    if (!matches.length) {
      renderError(singleResult, 'No matches');
      pushRecent({ input: term, error: 'No matches' });
      return;
    }

    // Single match → behave like a regular lookup, enriching with full fields.
    if (matches.length === 1) {
      singleResult.className = 'result';
      singleResult.textContent = 'Loading details...';
      const id = matches[0].login || matches[0].employeeId || matches[0].badge;
      if (id) {
        const detail = await lookupCached(id, getWarehouse(), true);
        if (detail?.ok) {
          renderFields(singleResult, detail.fields, selectedFields('tab-single'), detail.cached);
          pushRecent({ input: term, fields: detail.fields, cached: !!detail.cached });
          return;
        }
      }
      // Fall back: just show what the search row gave us.
      renderFields(singleResult, matches[0], selectedFields('tab-single'), false);
      pushRecent({ input: term, fields: matches[0] });
      return;
    }

    // Multiple matches → show the list with filters.
    singleResult.className = 'result';
    singleResult.textContent = `${matches.length} matches — filter below`;
    renderMatches(matches);
    pushRecent({ input: term, matchCount: matches.length });
  }

  function renderMatches(matches) {
    matchListEl.innerHTML = '';
    matchesCountEl.textContent = `${matches.length} matches`;
    matchesContainer.classList.remove('hidden');
    const fields = selectedFields('tab-single');
    matches.forEach(m => {
      const div = document.createElement('div');
      div.className = 'match-item';
      div.dataset.name = (m.name || '').toLowerCase();
      div.dataset.manager = (m.manager || '').toLowerCase();
      div.dataset.shift = (m.shift || '').toLowerCase();
      div.dataset.status = (m.status || '').toLowerCase();
      fields.forEach(key => {
        const v = m[key];
        if (!v) return;
        const row = document.createElement('div');
        row.className = 'match-row';
        const lbl = document.createElement('span');
        lbl.className = 'field-label';
        lbl.textContent = FIELD_LABELS[key] || key;
        const val = document.createElement('span');
        val.className = 'field-value';
        val.textContent = v;
        row.appendChild(lbl); row.appendChild(val);
        div.appendChild(row);
      });
      // Always show name + manager + shift + status if available, even if not selected,
      // so the filters work meaningfully.
      ['name', 'manager', 'shift', 'status'].forEach(key => {
        if (fields.includes(key) || !m[key]) return;
        const row = document.createElement('div');
        row.className = 'match-row';
        const lbl = document.createElement('span');
        lbl.className = 'field-label';
        lbl.textContent = FIELD_LABELS[key];
        const val = document.createElement('span');
        val.className = 'field-value';
        val.textContent = m[key];
        row.appendChild(lbl); row.appendChild(val);
        div.appendChild(row);
      });
      matchListEl.appendChild(div);
    });
    applyMatchFilters();
  }

  function applyMatchFilters() {
    const f = {
      name: (document.getElementById('filter-name').value || '').trim().toLowerCase(),
      manager: (document.getElementById('filter-manager').value || '').trim().toLowerCase(),
      shift: (document.getElementById('filter-shift').value || '').trim().toLowerCase(),
      status: (document.getElementById('filter-status').value || '').trim().toLowerCase()
    };
    let visible = 0;
    matchListEl.querySelectorAll('.match-item').forEach(el => {
      const hide =
        (f.name && !el.dataset.name.includes(f.name)) ||
        (f.manager && !el.dataset.manager.includes(f.manager)) ||
        (f.shift && !el.dataset.shift.includes(f.shift)) ||
        (f.status && !el.dataset.status.includes(f.status));
      el.classList.toggle('hidden-by-filter', !!hide);
      if (!hide) visible += 1;
    });
    const total = matchListEl.children.length;
    matchesCountEl.textContent = visible === total
      ? `${total} matches`
      : `${visible} of ${total} matches`;
  }

  ['filter-name', 'filter-manager', 'filter-shift', 'filter-status'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyMatchFilters);
  });
  document.getElementById('matches-clear').addEventListener('click', clearMatches);

  singleBtn.addEventListener('click', doSingleLookup);
  singleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSingleLookup(); }
  });
  document.getElementById('single-clear-cache').addEventListener('click', () => {
    cache.clear();
    singleResult.className = 'result';
    singleResult.textContent = 'Cache cleared';
  });

  function renderFields(container, fields, selected, cached) {
    container.className = 'result ok';
    container.innerHTML = '';
    let any = false;
    selected.forEach(key => {
      const v = fields[key];
      if (!v) return;
      any = true;
      const row = document.createElement('div');
      row.className = 'field-row';
      const lbl = document.createElement('span');
      lbl.className = 'field-label';
      lbl.textContent = FIELD_LABELS[key] || key;
      const val = document.createElement('span');
      val.className = 'field-value';
      val.textContent = v;
      row.appendChild(lbl); row.appendChild(val);
      container.appendChild(row);
    });
    if (!any) {
      container.textContent = 'No values for the selected fields.';
    } else if (cached) {
      const note = document.createElement('div');
      note.className = 'field-label';
      note.style.marginTop = '6px';
      note.textContent = '(from cache)';
      container.appendChild(note);
    }
  }

  function renderError(container, msg) {
    container.className = 'result error';
    container.textContent = msg;
  }

  // ---------- recent ----------
  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function pushRecent(entry) {
    const list = loadRecent();
    list.unshift({ ts: Date.now(), ...entry });
    while (list.length > MAX_RECENT) list.pop();
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  function renderRecent() {
    const container = document.getElementById('recent-list');
    container.innerHTML = '';
    const items = loadRecent();
    if (!items.length) { container.textContent = 'No recent lookups.'; return; }
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'recent-item';
      const time = document.createElement('div');
      time.className = 'recent-time';
      time.textContent = new Date(item.ts).toLocaleString();
      div.appendChild(time);
      const body = document.createElement('div');
      body.className = 'recent-fields';
      if (item.error) {
        body.textContent = `${item.input} — ${item.error}`;
        body.style.color = 'var(--err)';
      } else {
        const f = item.fields || {};
        const parts = [];
        ['login', 'badge', 'employeeId', 'name'].forEach(k => {
          if (f[k]) parts.push(`${FIELD_LABELS[k]}: ${f[k]}`);
        });
        body.textContent = `${item.input} → ${parts.join(' · ') || '(no fields)'}`;
      }
      div.appendChild(body);
      container.appendChild(div);
    });
  }
  document.getElementById('recent-clear').addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY);
    renderRecent();
  });
  document.getElementById('recent-export').addEventListener('click', () => {
    const items = loadRecent();
    if (!items.length) return;
    const headers = ['timestamp', 'input', 'login', 'badge', 'employeeId', 'name', 'status', 'manager', 'shift', 'deptId', 'location', 'agency', 'error'];
    const rows = [headers];
    items.forEach(it => {
      const f = it.fields || {};
      rows.push([
        new Date(it.ts).toISOString(), it.input || '',
        f.login || '', f.badge || '', f.employeeId || '', f.name || '',
        f.status || '', f.manager || '', f.shift || '', f.deptId || '',
        f.location || '', f.agency || '', it.error || ''
      ]);
    });
    downloadCSV(window.CSVUtil.serializeCSV(rows), 'aa-lookups.csv');
  });

  function downloadCSV(text, filename) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- batch CSV ----------
  let csvHeaders = [];
  let csvRows = [];
  let enrichedRows = null;
  let cancelBatch = false;

  const csvFileInput = document.getElementById('csv-file');
  const csvConfig = document.getElementById('csv-config');
  const csvInputColumn = document.getElementById('csv-input-column');
  const batchStartBtn = document.getElementById('batch-start');
  const batchCancelBtn = document.getElementById('batch-cancel');
  const batchProgressWrap = document.getElementById('batch-progress-wrap');
  const batchProgressFill = document.getElementById('batch-progress-fill');
  const batchProgressText = document.getElementById('batch-progress-text');
  const batchErrorSummary = document.getElementById('batch-error-summary');
  const batchDownloadWrap = document.getElementById('batch-download-wrap');
  const batchDownloadBtn = document.getElementById('batch-download');

  csvFileInput.addEventListener('change', async () => {
    const file = csvFileInput.files[0];
    if (!file) return;
    const text = await file.text();
    const rows = window.CSVUtil.parseCSV(text);
    if (!rows.length) { alert('CSV is empty'); return; }
    csvHeaders = rows[0];
    csvRows = rows.slice(1);
    csvInputColumn.innerHTML = '';
    csvHeaders.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = h || `(column ${i + 1})`;
      csvInputColumn.appendChild(opt);
    });
    const guess = csvHeaders.findIndex(h =>
      /login|badge|empl|employee\s*id|alias|name/i.test(h || '')
    );
    if (guess >= 0) csvInputColumn.value = String(guess);

    csvConfig.classList.remove('hidden');
    batchProgressWrap.classList.add('hidden');
    batchDownloadWrap.classList.add('hidden');
    enrichedRows = null;
  });

  batchStartBtn.addEventListener('click', async () => {
    if (!csvRows.length) { alert('Load a CSV first'); return; }
    const colIdx = parseInt(csvInputColumn.value, 10);
    const fieldKeys = selectedFields('tab-batch');
    if (!fieldKeys.length) { alert('Select at least one output field'); return; }

    const outHeaders = csvHeaders.slice();
    const fieldColIndexes = {};
    fieldKeys.forEach(key => {
      const colName = FIELD_LABELS[key];
      let idx = outHeaders.findIndex(h => (h || '').trim().toLowerCase() === colName.toLowerCase());
      if (idx < 0) { outHeaders.push(colName); idx = outHeaders.length - 1; }
      fieldColIndexes[key] = idx;
    });

    enrichedRows = [outHeaders];
    csvRows.forEach(r => {
      const padded = r.slice();
      while (padded.length < outHeaders.length) padded.push('');
      enrichedRows.push(padded);
    });

    const items = [];
    csvRows.forEach((r, rowIndex) => {
      const v = (r[colIdx] || '').trim();
      if (v) items.push({ value: v, rowIndex });
    });
    if (!items.length) { alert('No values found in the chosen column'); return; }

    cancelBatch = false;
    batchStartBtn.classList.add('hidden');
    batchCancelBtn.classList.remove('hidden');
    batchProgressWrap.classList.remove('hidden');
    batchDownloadWrap.classList.add('hidden');
    batchProgressFill.style.width = '0%';
    batchProgressText.textContent = `0 / ${items.length}`;
    batchErrorSummary.textContent = '';

    const csvInputType = document.getElementById('csv-input-type').value;
    let errorCount = 0;
    let ambiguousCount = 0;
    const wh = getWarehouse();

    async function resolveItem(value) {
      const useNameSearch = csvInputType === 'name'
        || (csvInputType === 'auto' && window.FCLM.looksLikeName(value));
      if (!useNameSearch) {
        return await lookupCached(value, wh, true);
      }
      const sr = await searchCached(value, wh, true);
      if (!sr.ok) return sr;
      const matches = sr.matches || [];
      if (matches.length === 0) {
        return { ok: false, error: 'No matches', input: value };
      }
      if (matches.length > 1) {
        return { ok: false, error: `${matches.length} matches — ambiguous`, input: value, ambiguous: true };
      }
      const id = matches[0].login || matches[0].employeeId || matches[0].badge;
      if (id) {
        const detail = await lookupCached(id, wh, true);
        if (detail?.ok) return detail;
      }
      return { ok: true, input: value, fields: matches[0] };
    }

    for (let i = 0; i < items.length; i++) {
      if (cancelBatch) break;
      const item = items[i];
      let res;
      try {
        res = await resolveItem(item.value);
      } catch (err) {
        res = { ok: false, error: err.message, input: item.value };
      }
      if (res.ok) {
        const target = enrichedRows[item.rowIndex + 1];
        fieldKeys.forEach(k => { target[fieldColIndexes[k]] = res.fields[k] || ''; });
      } else {
        if (res.ambiguous) ambiguousCount++; else errorCount++;
        const parts = [];
        if (errorCount) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
        if (ambiguousCount) parts.push(`${ambiguousCount} ambiguous`);
        batchErrorSummary.textContent = parts.join(' · ');
      }
      const done = i + 1;
      batchProgressFill.style.width = Math.round((done / items.length) * 100) + '%';
      batchProgressText.textContent = `${done} / ${items.length}`;
      if (i < items.length - 1 && !res.cached) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      }
    }

    batchStartBtn.classList.remove('hidden');
    batchCancelBtn.classList.add('hidden');
    batchDownloadWrap.classList.remove('hidden');
  });

  batchCancelBtn.addEventListener('click', () => { cancelBatch = true; });

  batchDownloadBtn.addEventListener('click', () => {
    if (!enrichedRows) return;
    const text = window.CSVUtil.serializeCSV(enrichedRows);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadCSV(text, `aa-lookup-enriched-${stamp}.csv`);
  });
})();
