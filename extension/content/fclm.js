// FC Labor Tracking Assistant - FCLM Portal Content Script
// Fetches individual employee time details on demand

(function() {
  'use strict';

  console.log('[FC Labor Tracking] FCLM content script loaded');

  // ============== CONFIGURATION ==============
  const CONFIG = {
    WAREHOUSE_ID: new URLSearchParams(window.location.search).get('warehouseId') || 'IND8',
    TIMEZONE: 'America/Indiana/Indianapolis'
  };

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

  // ============== FETCH EMPLOYEE TIME DETAILS ==============

  async function fetchEmployeeTimeDetails(employeeId) {
    log(`Fetching time details for employee: ${employeeId}`);

    const url = `/employee/timeDetails?warehouseId=${CONFIG.WAREHOUSE_ID}&employeeId=${employeeId}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return parseTimeDetailsHtml(html, employeeId);
    } catch (error) {
      log(`Error fetching time details: ${error.message}`, 'error');
      throw error;
    }
  }

  function parseTimeDetailsHtml(html, employeeId) {
    // Create a DOM parser to extract data from the HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const result = {
      employeeId: employeeId,
      sessions: [],
      currentActivity: null,
      totalHours: 0,
      isClockedIn: false
    };

    // Find the table with time details
    const table = doc.querySelector('table');
    if (!table) {
      log('No time details table found', 'warn');
      return result;
    }

    // Parse table rows
    const rows = table.querySelectorAll('tr');
    rows.forEach((row, index) => {
      if (index === 0) return; // Skip header row

      const cells = row.querySelectorAll('td');
      if (cells.length >= 4) {
        const title = cells[0]?.textContent?.trim() || '';
        const start = cells[1]?.textContent?.trim() || '';
        const end = cells[2]?.textContent?.trim() || '';
        const duration = cells[3]?.textContent?.trim() || '';

        if (title) {
          const session = {
            title,
            start,
            end,
            duration,
            durationMinutes: parseDurationToMinutes(duration)
          };
          result.sessions.push(session);

          // Check if this is the current activity (no end time or end time is in future)
          if (!end || end === '' || isOngoing(end)) {
            result.currentActivity = session;
            result.isClockedIn = true;
          }
        }
      }
    });

    // Calculate total hours from OnClock/Paid entries
    result.sessions.forEach(session => {
      if (session.title.includes('OnClock/Paid')) {
        result.totalHours += session.durationMinutes / 60;
      }
    });

    // Try to find "Hours on Task" from the page
    const hoursMatch = html.match(/Hours on Task:\s*([\d.]+)\s*\/\s*([\d.]+)/);
    if (hoursMatch) {
      result.hoursOnTask = parseFloat(hoursMatch[1]);
      result.totalScheduledHours = parseFloat(hoursMatch[2]);
    }

    log(`Parsed ${result.sessions.length} sessions for ${employeeId}`, 'success');
    return result;
  }

  function parseDurationToMinutes(duration) {
    // Duration format: "45:00" (mm:ss) or "259:00" (mmm:ss)
    if (!duration) return 0;

    const parts = duration.split(':');
    if (parts.length >= 2) {
      const minutes = parseInt(parts[0]) || 0;
      const seconds = parseInt(parts[1]) || 0;
      return minutes + (seconds / 60);
    }
    return 0;
  }

  function isOngoing(endTime) {
    // Check if the end time indicates an ongoing session
    if (!endTime || endTime === '') return true;

    // If end time contains a future date/time, it's ongoing
    // This is a simplified check - you may need to adjust based on actual format
    return false;
  }

  // ============== MESSAGE HANDLING ==============

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log(`Received message: ${message.action}`);

    if (message.action === 'fetchEmployeeTimeDetails') {
      const employeeId = message.employeeId;

      fetchEmployeeTimeDetails(employeeId)
        .then(data => {
          sendResponse({ success: true, data });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
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

    if (message.action === 'ping') {
      sendResponse({ success: true, ready: true });
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
        <span class="fc-fclm-text">FCLM Ready</span>
      </div>
    `;

    const styles = document.createElement('style');
    styles.textContent = `
      #fc-fclm-status {
        position: fixed;
        bottom: 20px;
        left: 20px;
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
    `;

    document.head.appendChild(styles);
    document.body.appendChild(indicator);

    return indicator;
  }

  // ============== START ==============

  // Notify background script that FCLM page is ready
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: 'fclm',
    url: window.location.href,
    warehouseId: CONFIG.WAREHOUSE_ID
  }).catch(err => {
    log(`Could not notify background: ${err.message}`, 'warn');
  });

  // Create status indicator
  createStatusIndicator();

  log('='.repeat(50));
  log('FCLM Ready for employee lookups!', 'success');
  log(`Warehouse: ${CONFIG.WAREHOUSE_ID}`);
  log('='.repeat(50));

})();
