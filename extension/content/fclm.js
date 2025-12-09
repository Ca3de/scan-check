// FC Labor Tracking Assistant - FCLM Portal Content Script
// Fetches associate metrics from FCLM and shares with kiosk pages

(function() {
  'use strict';

  console.log('[FC Labor Tracking] FCLM content script loaded');

  // ============== CONFIGURATION ==============
  const CONFIG = {
    WAREHOUSE_ID: 'IND8',
    PROCESS_IDS: {
      '1003015': 'Sort-Batch',
      '1003034': 'V-Returns Pick',
      '1003055': 'V-Returns Stow',
      '1003056': 'V-Returns Pack'
    },
    POLL_INTERVAL: 120000, // 2 minutes
    TIMEZONE: 'America/Indiana/Indianapolis'
  };

  // Store fetched data
  let associateData = new Map();
  let lastFetchTime = null;
  let isPolling = false;

  // ============== HELPERS ==============

  function log(message, type = 'info') {
    const prefix = '[FC Labor Tracking FCLM]';
    const timestamp = new Date().toLocaleTimeString();
    const styles = {
      info: 'color: #3b82f6',
      success: 'color: #22c55e',
      error: 'color: #ef4444',
      warn: 'color: #f59e0b'
    };
    console.log(`%c${prefix} [${timestamp}] ${message}`, styles[type] || styles.info);
  }

  function getShiftDate() {
    const now = new Date();
    const options = { timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: 'numeric' };
    const timeStr = now.toLocaleString('en-US', options);
    const [time, period] = timeStr.split(' ');
    const [hours, minutes] = time.split(':').map(Number);
    const hour24 = period === 'PM' && hours !== 12 ? hours + 12 : (period === 'AM' && hours === 12 ? 0 : hours);

    const dateOptions = { timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' };
    let shiftDate = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));

    if (hour24 < 5 || (hour24 === 5 && minutes < 30)) {
      shiftDate.setDate(shiftDate.getDate() - 1);
    }

    return shiftDate.toISOString().split('T')[0];
  }

  function getTimeRange() {
    const now = new Date();
    const nowInTZ = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE }));
    const hour = nowInTZ.getHours();

    let start, end;

    if (hour >= 18 || hour < 6) {
      if (hour >= 18) {
        start = new Date(nowInTZ);
        start.setHours(18, 30, 0, 0);
        end = nowInTZ;
      } else {
        start = new Date(nowInTZ);
        start.setDate(start.getDate() - 1);
        start.setHours(18, 30, 0, 0);
        end = nowInTZ;
      }
    } else {
      start = new Date(nowInTZ);
      start.setDate(start.getDate() - 1);
      start.setHours(18, 30, 0, 0);
      end = new Date(nowInTZ);
      end.setHours(5, 30, 0, 0);
    }

    return { start, end };
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  // ============== CSV PARSING ==============

  function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]);
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const record = {};
      headers.forEach((header, idx) => {
        record[header] = values[idx] || '';
      });
      records.push(record);
    }

    return records;
  }

  // ============== FCLM API ==============

  async function fetchFunctionRollup(processId) {
    const { start, end } = getTimeRange();

    const params = new URLSearchParams({
      reportFormat: 'CSV',
      warehouseId: CONFIG.WAREHOUSE_ID,
      processId: processId,
      spanType: 'Intraday',
      maxIntradayDays: '1',
      startDateIntraday: formatDate(start),
      startHourIntraday: String(start.getHours()),
      startMinuteIntraday: String(start.getMinutes()),
      endDateIntraday: formatDate(end),
      endHourIntraday: String(end.getHours()),
      endMinuteIntraday: String(end.getMinutes())
    });

    const url = `/reports/functionRollup?${params}`;
    log(`Fetching: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  }

  function parseFunctionRollup(csvText) {
    const records = parseCSV(csvText);
    const grouped = new Map();

    for (const row of records) {
      const employeeId = row['Employee Id'] || '';
      const functionName = row['Function Name'] || '';
      if (!employeeId) continue;

      const key = `${employeeId}|${functionName}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          employeeId,
          functionName,
          name: row['Name'] || '',
          manager: row['Manager'] || '',
          employeeType: row['Employee Type'] || '',
          processName: row['Process Name'] || '',
          hours: 0,
          units: 0,
          uph: 0,
          jobs: 0,
          hasTotal: false
        });
      }

      const entry = grouped.get(key);
      const size = row['Size'] || '';

      if (size === 'Total') {
        entry.hours = parseFloat(row['Paid Hours-Total(function,employee)']) || 0;
        entry.uph = parseFloat(row['UPH']) || 0;
        entry.jobs += parseInt(row['Jobs']) || 0;
        entry.units += parseInt(row['Units']) || 0;
        entry.hasTotal = true;
      }
    }

    const results = [];
    for (const entry of grouped.values()) {
      if (!entry.hasTotal) continue;

      const jph = entry.hours > 0 ? entry.jobs / entry.hours : 0;

      results.push({
        employee_id: entry.employeeId,
        name: entry.name,
        manager: entry.manager,
        employee_type: entry.employeeType,
        process_name: entry.processName,
        function_name: entry.functionName,
        paid_hours_total: entry.hours,
        jobs: entry.jobs,
        jph: jph,
        units: entry.units,
        uph: entry.uph
      });
    }

    return results;
  }

  // ============== POLLING ==============

  async function poll() {
    if (isPolling) {
      log('Poll already in progress, skipping', 'warn');
      return;
    }

    isPolling = true;
    log('Starting poll cycle...');

    const shiftDate = getShiftDate();
    log(`Shift date: ${shiftDate}`);

    let allRecords = [];

    for (const [processId, processName] of Object.entries(CONFIG.PROCESS_IDS)) {
      try {
        log(`Fetching ${processName} (${processId})...`);
        const csvData = await fetchFunctionRollup(processId);
        const records = parseFunctionRollup(csvData);
        log(`  Parsed ${records.length} associate records`, 'success');
        allRecords = allRecords.concat(records);
      } catch (error) {
        log(`  Error fetching ${processName}: ${error.message}`, 'error');
      }
    }

    if (allRecords.length > 0) {
      // Store in local map indexed by employee_id
      associateData.clear();
      for (const record of allRecords) {
        const existing = associateData.get(record.employee_id);
        if (!existing || record.paid_hours_total > existing.paid_hours_total) {
          associateData.set(record.employee_id, record);
        }
      }

      lastFetchTime = new Date();

      // Send to background script for cross-tab access
      try {
        await browser.runtime.sendMessage({
          action: 'updateFclmData',
          data: allRecords,
          shiftDate: shiftDate,
          timestamp: lastFetchTime.toISOString()
        });
        log(`Sent ${allRecords.length} records to background script`, 'success');
      } catch (e) {
        log(`Failed to send to background: ${e.message}`, 'error');
      }

      // Summary
      const totalUnits = allRecords.reduce((sum, r) => sum + r.units, 0);
      const avgUph = allRecords.length > 0 ? Math.round(allRecords.reduce((sum, r) => sum + r.uph, 0) / allRecords.length) : 0;
      log(`Summary: ${allRecords.length} associates | ${totalUnits} total units | ${avgUph} avg UPH`, 'success');
    } else {
      log('No records fetched', 'warn');
    }

    isPolling = false;
    log(`Next poll in ${CONFIG.POLL_INTERVAL / 60000} minutes`);
  }

  // ============== MESSAGE HANDLING ==============

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log(`Received message: ${message.action}`);

    if (message.action === 'getFclmData') {
      sendResponse({
        success: true,
        data: Array.from(associateData.values()),
        lastFetch: lastFetchTime ? lastFetchTime.toISOString() : null
      });
      return false;
    }

    if (message.action === 'lookupAssociate') {
      const badgeId = message.badgeId;
      const associate = associateData.get(badgeId);
      sendResponse({
        success: true,
        found: !!associate,
        associate: associate || null
      });
      return false;
    }

    if (message.action === 'triggerPoll') {
      poll().then(() => {
        sendResponse({ success: true });
      }).catch(e => {
        sendResponse({ success: false, error: e.message });
      });
      return true; // Async response
    }

    if (message.action === 'getConfig') {
      sendResponse({
        success: true,
        config: CONFIG
      });
      return false;
    }
  });

  // ============== UI INDICATOR ==============

  function createStatusIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'fc-fclm-status';
    indicator.innerHTML = `
      <div class="fc-fclm-status-inner">
        <span class="fc-fclm-dot"></span>
        <span class="fc-fclm-text">FCLM Poller Active</span>
        <button class="fc-fclm-refresh" title="Refresh Now">↻</button>
      </div>
    `;

    const styles = document.createElement('style');
    styles.textContent = `
      #fc-fclm-status {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1a1a2e;
        color: #fff;
        padding: 8px 12px;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        z-index: 999999;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      }
      .fc-fclm-status-inner {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .fc-fclm-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #2ecc71;
        box-shadow: 0 0 6px #2ecc71;
      }
      .fc-fclm-dot.polling {
        background: #f39c12;
        animation: pulse 1s infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      .fc-fclm-refresh {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
      }
      .fc-fclm-refresh:hover {
        color: #fff;
      }
    `;

    document.head.appendChild(styles);
    document.body.appendChild(indicator);

    // Refresh button click
    indicator.querySelector('.fc-fclm-refresh').addEventListener('click', () => {
      const dot = indicator.querySelector('.fc-fclm-dot');
      dot.classList.add('polling');
      poll().finally(() => {
        dot.classList.remove('polling');
      });
    });

    return indicator;
  }

  // ============== START ==============

  // Notify background script that FCLM page is ready
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: 'fclm',
    url: window.location.href,
    warehouseId: new URLSearchParams(window.location.search).get('warehouseId') || CONFIG.WAREHOUSE_ID
  }).catch(err => {
    log(`Could not notify background: ${err.message}`, 'warn');
  });

  // Create status indicator
  createStatusIndicator();

  // Initial poll
  log('='.repeat(50));
  log('FCLM Poller Started!', 'success');
  log(`Warehouse: ${CONFIG.WAREHOUSE_ID}`);
  log(`Poll interval: ${CONFIG.POLL_INTERVAL / 60000} minutes`);
  log(`Processes: ${Object.values(CONFIG.PROCESS_IDS).join(', ')}`);
  log('='.repeat(50));

  poll();

  // Schedule recurring polls
  setInterval(poll, CONFIG.POLL_INTERVAL);

})();
