// Sidebar UI controller.
//
// FCLM accepts login, badge, or Empl ID as the `employeeId` query param, so
// "auto-detect" simply forwards the scanned value as-is. The input-type
// dropdowns are kept for clarity (and for CSV column meaning), but they
// don't change the network call.

(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

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
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveSettings(patch) {
    const s = { ...loadSettings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  const warehouseInput = document.getElementById('warehouseId');
  const settings = loadSettings();
  if (settings.warehouseId) warehouseInput.value = settings.warehouseId;
  warehouseInput.addEventListener('change', () => {
    saveSettings({ warehouseId: warehouseInput.value.trim() || 'IND8' });
  });

  function getWarehouse() {
    return (warehouseInput.value || 'IND8').trim();
  }

  // Restore field-checkbox state per fieldset.
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
  const singleResult = document.getElementById('single-result');
  const singleBtn = document.getElementById('single-lookup-btn');

  async function doSingleLookup() {
    const value = singleInput.value.trim();
    if (!value) {
      renderError(singleResult, 'Enter or scan a value');
      return;
    }
    singleBtn.disabled = true;
    singleResult.className = 'result';
    singleResult.textContent = 'Looking up...';
    let resp;
    try {
      resp = await sendRuntimeMessage({
        action: 'singleLookup',
        idValue: value,
        warehouseId: getWarehouse()
      });
    } catch (err) {
      renderError(singleResult, err.message);
      singleBtn.disabled = false;
      return;
    }
    singleBtn.disabled = false;

    if (!resp?.ok) {
      renderError(singleResult, resp?.error || 'Lookup failed');
      pushRecent({ input: value, error: resp?.error || 'Lookup failed' });
      return;
    }

    const fields = selectedFields('tab-single');
    renderFields(singleResult, resp.fields, fields, resp.cached);
    pushRecent({ input: value, fields: resp.fields, cached: !!resp.cached });

    // Select all so the next scan replaces the value.
    singleInput.select();
  }

  singleBtn.addEventListener('click', doSingleLookup);
  singleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSingleLookup();
    }
  });

  document.getElementById('single-clear-cache').addEventListener('click', async () => {
    await sendRuntimeMessage({ action: 'clearCache' });
    singleResult.className = 'result';
    singleResult.textContent = 'Cache cleared';
  });

  function renderFields(container, fields, selected, cached) {
    container.className = 'result ok';
    container.innerHTML = '';
    let any = false;
    selected.forEach(key => {
      const value = fields[key];
      if (!value) return;
      any = true;
      const row = document.createElement('div');
      row.className = 'field-row';
      const lbl = document.createElement('span');
      lbl.className = 'field-label';
      lbl.textContent = FIELD_LABELS[key] || key;
      const val = document.createElement('span');
      val.className = 'field-value';
      val.textContent = value;
      row.appendChild(lbl);
      row.appendChild(val);
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

  function sendRuntimeMessage(message) {
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
    if (!items.length) {
      container.textContent = 'No recent lookups.';
      return;
    }
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
        new Date(it.ts).toISOString(),
        it.input || '',
        f.login || '', f.badge || '', f.employeeId || '', f.name || '',
        f.status || '', f.manager || '', f.shift || '', f.deptId || '',
        f.location || '', f.agency || '',
        it.error || ''
      ]);
    });
    downloadCSV(window.CSVUtil.serializeCSV(rows), 'aa-lookups.csv');
  });

  function downloadCSV(text, filename) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- batch CSV ----------
  let csvHeaders = [];
  let csvRows = [];
  let enrichedRows = null; // populated as batch runs
  let batchPort = null;
  let currentBatchId = null;

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
    if (!rows.length) {
      alert('CSV is empty');
      return;
    }
    csvHeaders = rows[0];
    csvRows = rows.slice(1);
    csvInputColumn.innerHTML = '';
    csvHeaders.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = h || `(column ${i + 1})`;
      csvInputColumn.appendChild(opt);
    });
    // Heuristic: pick a column whose header looks like an id field.
    const guess = csvHeaders.findIndex(h =>
      /login|badge|empl|employee\s*id|alias|name/i.test(h || '')
    );
    if (guess >= 0) csvInputColumn.value = String(guess);

    csvConfig.classList.remove('hidden');
    batchProgressWrap.classList.add('hidden');
    batchDownloadWrap.classList.add('hidden');
    enrichedRows = null;
  });

  batchStartBtn.addEventListener('click', () => {
    if (!csvRows.length) {
      alert('Load a CSV first');
      return;
    }
    const colIdx = parseInt(csvInputColumn.value, 10);
    const fieldKeys = selectedFields('tab-batch');
    if (!fieldKeys.length) {
      alert('Select at least one output field');
      return;
    }

    // Build new header row: original headers + selected output columns
    // (skip output columns whose name collides with the input column name).
    const outHeaders = csvHeaders.slice();
    const fieldColIndexes = {};
    fieldKeys.forEach(key => {
      const colName = FIELD_LABELS[key];
      let idx = outHeaders.findIndex(h => (h || '').trim().toLowerCase() === colName.toLowerCase());
      if (idx < 0) {
        outHeaders.push(colName);
        idx = outHeaders.length - 1;
      }
      fieldColIndexes[key] = idx;
    });

    enrichedRows = [outHeaders];
    csvRows.forEach(r => {
      const padded = r.slice();
      while (padded.length < outHeaders.length) padded.push('');
      enrichedRows.push(padded);
    });

    // Items to look up.
    const items = [];
    csvRows.forEach((r, rowIndex) => {
      const v = (r[colIdx] || '').trim();
      if (v) items.push({ value: v, rowIndex });
    });

    if (!items.length) {
      alert('No values found in the chosen column');
      return;
    }

    // UI state.
    batchStartBtn.classList.add('hidden');
    batchCancelBtn.classList.remove('hidden');
    batchProgressWrap.classList.remove('hidden');
    batchDownloadWrap.classList.add('hidden');
    batchProgressFill.style.width = '0%';
    batchProgressText.textContent = `0 / ${items.length}`;
    batchErrorSummary.textContent = '';

    let errorCount = 0;
    currentBatchId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    batchPort = api.runtime.connect({ name: 'aaLookup' });
    batchPort.onMessage.addListener((msg) => {
      if (msg.batchId !== currentBatchId) return;
      if (msg.type === 'batchProgress') {
        const pct = Math.round((msg.done / msg.total) * 100);
        batchProgressFill.style.width = pct + '%';
        batchProgressText.textContent = `${msg.done} / ${msg.total}`;
        if (msg.result?.ok) {
          const target = enrichedRows[msg.rowIndex + 1];
          fieldKeys.forEach(k => {
            target[fieldColIndexes[k]] = msg.result.fields[k] || '';
          });
        } else {
          errorCount++;
          batchErrorSummary.textContent = `${errorCount} error${errorCount === 1 ? '' : 's'} so far`;
        }
      } else if (msg.type === 'batchDone' || msg.type === 'batchCancelled') {
        batchStartBtn.classList.remove('hidden');
        batchCancelBtn.classList.add('hidden');
        batchDownloadWrap.classList.remove('hidden');
        try { batchPort.disconnect(); } catch (_) {}
        batchPort = null;
      }
    });
    batchPort.postMessage({
      type: 'startBatch',
      batchId: currentBatchId,
      items,
      warehouseId: getWarehouse()
    });
  });

  batchCancelBtn.addEventListener('click', () => {
    if (batchPort && currentBatchId) {
      batchPort.postMessage({ type: 'cancelBatch', batchId: currentBatchId });
    }
  });

  batchDownloadBtn.addEventListener('click', () => {
    if (!enrichedRows) return;
    const text = window.CSVUtil.serializeCSV(enrichedRows);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadCSV(text, `aa-lookup-enriched-${stamp}.csv`);
  });
})();
