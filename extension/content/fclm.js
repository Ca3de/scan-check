// FC Labor Tracking Assistant - FCLM Portal Content Script
// Fetches individual employee time details on demand

(function() {
  'use strict';

  console.log('[FC Labor Tracking] FCLM content script loaded');

  // ============== CONFIGURATION ==============
  const CONFIG = {
    WAREHOUSE_ID: new URLSearchParams(window.location.search).get('warehouseId') || 'IND8',
    TIMEZONE: 'America/Indiana/Indianapolis',
    // Night shift times
    SHIFT_START_HOUR: 18,  // 6 PM
    SHIFT_END_HOUR: 6      // 6 AM next day
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

  // Calculate shift date range based on current time (for night shift)
  function getShiftDateRange() {
    const now = new Date();
    const currentHour = now.getHours();

    let startDate, endDate;

    if (currentHour >= CONFIG.SHIFT_START_HOUR) {
      // Between 6PM-11:59PM: shift started today, ends tomorrow
      startDate = new Date(now);
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() + 1);
    } else if (currentHour < CONFIG.SHIFT_END_HOUR) {
      // Between 12AM-6AM: shift started yesterday, ends today
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(now);
    } else {
      // Between 6AM-6PM: use today as day shift or previous night
      // Default to checking previous night shift
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(now);
    }

    const formatDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}/${month}/${day}`;
    };

    return {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      startHour: CONFIG.SHIFT_START_HOUR,
      endHour: CONFIG.SHIFT_END_HOUR
    };
  }

  // ============== FETCH EMPLOYEE TIME DETAILS ==============

  // Build the URL for employee time details
  function buildTimeDetailsUrl(employeeId) {
    const shiftRange = getShiftDateRange();

    const params = new URLSearchParams({
      employeeId: employeeId,
      warehouseId: CONFIG.WAREHOUSE_ID,
      startDateDay: shiftRange.endDate,
      maxIntradayDays: '1',
      spanType: 'Intraday',
      startDateIntraday: shiftRange.startDate,
      startHourIntraday: String(shiftRange.startHour),
      startMinuteIntraday: '0',
      endDateIntraday: shiftRange.endDate,
      endHourIntraday: String(shiftRange.endHour),
      endMinuteIntraday: '0'
    });

    return `https://fclm-portal.amazon.com/employee/timeDetails?&${params.toString()}`;
  }

  async function fetchEmployeeTimeDetails(employeeId) {
    log(`Fetching time details for employee: ${employeeId}`);

    const shiftRange = getShiftDateRange();
    log(`Shift range: ${shiftRange.startDate} ${shiftRange.startHour}:00 to ${shiftRange.endDate} ${shiftRange.endHour}:00`);

    const url = buildTimeDetailsUrl(employeeId);
    log(`Target URL: ${url}`);

    // Method 1: Try to scrape from live DOM if we're already on a timeDetails page
    // or if we can navigate to it
    if (window.location.href.includes('/employee/timeDetails')) {
      log('Already on timeDetails page, scraping live DOM...');
      return scrapeTimeDetailsFromLiveDOM(employeeId);
    }

    // Method 2: Navigate to the URL and scrape after load
    // This will reload the FCLM tab with the employee's time details
    log('Navigating to timeDetails page...');

    // Store the request in sessionStorage so we can complete it after navigation
    sessionStorage.setItem('fc_pending_lookup', JSON.stringify({
      employeeId,
      timestamp: Date.now()
    }));

    // Navigate to the time details page
    window.location.href = url;

    // Return a pending response - the actual data will be sent after page loads
    return {
      employeeId,
      sessions: [],
      pending: true,
      message: 'Navigating to time details page...'
    };
  }

  // Scrape time details from the live DOM (after JavaScript has rendered)
  function scrapeTimeDetailsFromLiveDOM(employeeId) {
    log('Scraping time details from live DOM...');

    const result = {
      employeeId: employeeId,
      sessions: [],
      currentActivity: null,
      totalHours: 0,
      isClockedIn: false
    };

    // Find all tables in the live DOM
    const tables = document.querySelectorAll('table');
    log(`Found ${tables.length} tables in live DOM`);

    // Look for the time details table with title/start/end/duration columns
    for (let tableIdx = 0; tableIdx < tables.length; tableIdx++) {
      const table = tables[tableIdx];
      const rows = table.querySelectorAll('tr');

      if (rows.length < 2) continue;

      // Check first row for headers
      const headerRow = rows[0];
      const headerCells = headerRow.querySelectorAll('th, td');
      const headerTexts = Array.from(headerCells).map(c => c.textContent?.trim().toLowerCase() || '');

      log(`Live DOM Table ${tableIdx}: ${headerCells.length} headers: [${headerTexts.join(', ')}]`);

      // Find column indices
      let titleIdx = -1, startIdx = -1, endIdx = -1, durationIdx = -1;
      headerTexts.forEach((text, idx) => {
        if (text.includes('title')) titleIdx = idx;
        else if (text.includes('start')) startIdx = idx;
        else if (text.includes('end')) endIdx = idx;
        else if (text.includes('duration')) durationIdx = idx;
      });

      if (titleIdx >= 0 && startIdx >= 0 && durationIdx >= 0) {
        log(`Found time details table (table ${tableIdx})`, 'success');

        // Parse data rows
        for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
          const cells = rows[rowIdx].querySelectorAll('td');
          if (cells.length > durationIdx) {
            const title = cells[titleIdx]?.textContent?.trim() || '';
            const start = cells[startIdx]?.textContent?.trim() || '';
            const end = endIdx >= 0 ? (cells[endIdx]?.textContent?.trim() || '') : '';
            const duration = cells[durationIdx]?.textContent?.trim() || '';

            if (title && !title.includes('OffClock') && !title.includes('OnClock')) {
              const session = {
                title,
                start,
                end,
                duration,
                durationMinutes: parseDurationToMinutes(duration)
              };
              result.sessions.push(session);
              log(`Parsed: ${title} - ${duration} (${session.durationMinutes} mins)`);

              if (!end || end === '') {
                result.currentActivity = session;
                result.isClockedIn = true;
              }
            }
          }
        }

        break; // Found the table, stop searching
      }
    }

    // Try to find "Hours on Task" from the page
    const pageText = document.body.textContent || '';
    const hoursMatch = pageText.match(/Hours on Task:\s*([\d.]+)\s*\/\s*([\d.]+)/);
    if (hoursMatch) {
      result.hoursOnTask = parseFloat(hoursMatch[1]);
      result.totalScheduledHours = parseFloat(hoursMatch[2]);
    }

    log(`Scraped ${result.sessions.length} sessions from live DOM`, 'success');
    return result;
  }

  // Check if we arrived here from a lookup navigation
  function checkPendingLookup() {
    const pendingStr = sessionStorage.getItem('fc_pending_lookup');
    if (pendingStr && window.location.href.includes('/employee/timeDetails')) {
      sessionStorage.removeItem('fc_pending_lookup');

      const pending = JSON.parse(pendingStr);
      const age = Date.now() - pending.timestamp;

      // Only process if the request is recent (within 30 seconds)
      if (age < 30000) {
        log(`Processing pending lookup for ${pending.employeeId} (${age}ms old)`);

        // Wait for the page to fully render
        setTimeout(() => {
          const result = scrapeTimeDetailsFromLiveDOM(pending.employeeId);

          // Send the result back to the kiosk via background script
          browser.runtime.sendMessage({
            action: 'forwardToKiosk',
            payload: {
              action: 'timeDetailsResult',
              data: result
            }
          }).catch(err => {
            log(`Error sending result to kiosk: ${err.message}`, 'error');
          });
        }, 1500); // Wait 1.5s for JavaScript to render the table
      }
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

    // First, try to find embedded JSON data in script tags
    // Many sites embed data that JavaScript renders
    const scripts = doc.querySelectorAll('script');
    for (const script of scripts) {
      const content = script.textContent || '';
      // Look for JSON data patterns
      if (content.includes('timeDetails') || content.includes('sessions') || content.includes('activities')) {
        log(`Found potential data in script tag (${content.length} chars)`);
        // Try to extract JSON
        const jsonMatch = content.match(/(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]*?\});/);
        if (jsonMatch) {
          log(`Found JSON pattern in script`);
        }
      }
    }

    // Also search the raw HTML for session-like data patterns
    // Look for known path names that indicate time entries exist
    const pathPatterns = ['C-Returns', 'StowSweep', 'EndofLine', 'WaterSpider', 'Vreturns', 'OnClock', 'OffClock'];
    for (const pattern of pathPatterns) {
      if (html.includes(pattern)) {
        log(`Found "${pattern}" in HTML - time data exists`);
      }
    }

    // Find the correct table - look for one with "start", "end", "duration" headers
    // Note: The "title" column may not have a header, it's just the first column
    const tables = doc.querySelectorAll('table');
    log(`Found ${tables.length} tables in the page`);

    let targetTable = null;
    let titleIdx = 0, startIdx = 1, endIdx = 2, durationIdx = 3;

    for (let tableIdx = 0; tableIdx < tables.length; tableIdx++) {
      const table = tables[tableIdx];

      // Try to find header row - check thead first, then first tr
      let headerRow = table.querySelector('thead tr');
      if (!headerRow) {
        headerRow = table.querySelector('tr');
      }
      if (!headerRow) continue;

      const headerCells = headerRow.querySelectorAll('th, td');
      const headerTexts = Array.from(headerCells).map(c => c.textContent?.trim().toLowerCase() || '');
      log(`Table ${tableIdx}: ${headerCells.length} cells in first row: [${headerTexts.join(', ')}]`);

      let hasTitle = false, hasStart = false, hasEnd = false, hasDuration = false;

      headerCells.forEach((cell, idx) => {
        const text = cell.textContent?.trim().toLowerCase() || '';
        // Use includes() for more flexible matching (handles "title:", "start time", etc.)
        if (text.includes('title')) { titleIdx = idx; hasTitle = true; }
        else if (text.includes('start')) { startIdx = idx; hasStart = true; }
        else if (text.includes('end')) { endIdx = idx; hasEnd = true; }
        else if (text.includes('duration')) { durationIdx = idx; hasDuration = true; }
      });

      // Found the right table if it has title, start, and duration columns
      if (hasTitle && hasStart && hasDuration) {
        targetTable = table;
        log(`Found time details table (table ${tableIdx}) with title/start/duration headers`, 'success');
        break;
      }

      // Fallback: if has start, end, duration but no title header, title is before start
      if (hasStart && hasEnd && hasDuration) {
        targetTable = table;
        titleIdx = startIdx - 1;
        if (titleIdx < 0) titleIdx = 0;
        log(`Found time details table (table ${tableIdx}, no title header) with ${headerCells.length} columns`, 'success');
        break;
      }
    }

    if (!targetTable) {
      log('No time details table found with standard headers', 'warn');

      // Alternative approach: Look for any table row that has time-like data
      // Format: something like "C-Returns_StowSweep | 12/08 6:21 PM | 12/08 6:41 PM | 20:00"
      log('Searching all table rows for time-pattern data...');

      for (let tableIdx = 0; tableIdx < tables.length; tableIdx++) {
        const table = tables[tableIdx];
        const allRows = table.querySelectorAll('tr');

        for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
          const row = allRows[rowIdx];
          const cells = row.querySelectorAll('td, th');

          if (cells.length >= 3) {
            // Check if any cell contains a time pattern like "12/08" or "PM" or duration like "20:00"
            const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');
            const hasDatePattern = cellTexts.some(t => /\d{1,2}\/\d{1,2}/.test(t));
            const hasTimePattern = cellTexts.some(t => /\d{1,2}:\d{2}/.test(t) && !t.includes('EST'));
            const hasPathName = cellTexts.some(t => /returns|stow|sweep|spider|eol|clock/i.test(t));

            if (hasDatePattern || (hasTimePattern && hasPathName)) {
              log(`Table ${tableIdx} Row ${rowIdx}: [${cellTexts.join(' | ')}]`);

              // This looks like a data row - try to parse it
              if (cells.length >= 4 && hasPathName) {
                // Assume format: title, start, end, duration (or similar)
                const title = cellTexts[0] || '';
                const start = cellTexts[1] || '';
                const end = cellTexts[2] || '';
                const duration = cellTexts[3] || '';

                if (title && !title.includes('title') && duration) {
                  const session = {
                    title,
                    start,
                    end,
                    duration,
                    durationMinutes: parseDurationToMinutes(duration)
                  };
                  result.sessions.push(session);
                  log(`Parsed session from row: ${title} - ${duration}`, 'success');
                }
              }
            }
          }
        }
      }

      // Also check for divs that might contain time entries
      const possibleContainers = doc.querySelectorAll('div[class*="time"], div[class*="detail"], div[class*="row"]');
      log(`Found ${possibleContainers.length} possible container divs`);

      if (result.sessions.length > 0) {
        log(`Found ${result.sessions.length} sessions via alternative parsing`, 'success');
      } else {
        log('No sessions found even with alternative parsing', 'warn');
      }

      return result;
    }

    const rows = targetTable.querySelectorAll('tr');
    log(`Column indices - title: ${titleIdx}, start: ${startIdx}, end: ${endIdx}, duration: ${durationIdx}`);
    log(`Total rows in table: ${rows.length}`);

    rows.forEach((row, index) => {
      if (index === 0) return; // Skip header row

      const cells = row.querySelectorAll('td');
      if (cells.length > durationIdx) {
        const title = cells[titleIdx]?.textContent?.trim() || '';
        const start = cells[startIdx]?.textContent?.trim() || '';
        const end = cells[endIdx]?.textContent?.trim() || '';
        const duration = cells[durationIdx]?.textContent?.trim() || '';

        // Skip empty titles or clock entries for MPV purposes
        if (title && !title.includes('OffClock') && !title.includes('OnClock')) {
          const session = {
            title,
            start,
            end,
            duration,
            durationMinutes: parseDurationToMinutes(duration)
          };
          result.sessions.push(session);
          log(`Parsed session: ${title} - ${duration} (${session.durationMinutes} mins)`);

          // Check if this is the current activity (no end time or end time is in future)
          if (!end || end === '' || isOngoing(end)) {
            result.currentActivity = session;
            result.isClockedIn = true;
          }
        }
      }
    });

    log(`Total sessions parsed: ${result.sessions.length}`);

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
  log(`Current URL: ${window.location.href}`);
  log('='.repeat(50));

  // Check if we arrived here from a pending lookup (after navigation)
  // Wait a bit for the page to render before checking
  setTimeout(() => {
    checkPendingLookup();
  }, 2000);

})();
