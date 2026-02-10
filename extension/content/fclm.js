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
  // Night shift: 18:00 (6PM) to 06:00 (6AM next day)
  function getShiftDateRange() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinutes = now.getMinutes();

    log(`Current time: ${currentHour}:${String(currentMinutes).padStart(2, '0')} (hour=${currentHour})`);

    let startDate, endDate;

    if (currentHour >= CONFIG.SHIFT_START_HOUR) {
      // Between 6PM-11:59PM: shift started today, ends tomorrow
      startDate = new Date(now);
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() + 1);
      log(`Evening shift: ${currentHour}:00 >= 18:00, so start=today, end=tomorrow`);
    } else if (currentHour < CONFIG.SHIFT_END_HOUR) {
      // Between 12AM-5:59AM: shift started yesterday, ends today
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(now);
      log(`Early morning shift: ${currentHour}:00 < 06:00, so start=yesterday, end=today`);
    } else {
      // Between 6AM-5:59PM: daytime - check previous night shift
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(now);
      log(`Daytime (${currentHour}:00): checking previous night shift, start=yesterday, end=today`);
    }

    const formatDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}/${month}/${day}`;
    };

    const result = {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      startHour: CONFIG.SHIFT_START_HOUR,
      endHour: CONFIG.SHIFT_END_HOUR
    };

    log(`Shift range: ${result.startDate} ${result.startHour}:00 to ${result.endDate} ${result.endHour}:00`, 'success');

    return result;
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

    // Use direct fetch() API instead of navigation - MUCH FASTER!
    try {
      log(`Fetching timeDetails via fetch() API...`);
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();

      log(`Got HTML response (${html.length} chars), parsing...`);
      const result = parseTimeDetailsHtml(html, employeeId);
      log(`Parsed ${result.sessions.length} sessions via fetch()`, 'success');
      return result;

    } catch (fetchError) {
      log(`Fetch failed: ${fetchError.message}, trying live DOM scrape...`, 'warn');

      // Fallback: Check if we're already on the correct page
      const currentUrl = window.location.href;
      const isOnTimeDetailsPage = currentUrl.includes('/employee/timeDetails');
      const isCorrectEmployee = currentUrl.includes(`employeeId=${employeeId}`);

      if (isOnTimeDetailsPage && isCorrectEmployee) {
        log(`Already on timeDetails page for employee ${employeeId}, scraping live DOM...`);
        return scrapeTimeDetailsFromLiveDOM(employeeId);
      }

      // Last resort: navigation (slow path)
      log(`Falling back to navigation for ${employeeId}...`, 'warn');
      sessionStorage.setItem('fc_pending_lookup', JSON.stringify({
        employeeId,
        timestamp: Date.now()
      }));
      window.location.href = url;

      return {
        employeeId,
        sessions: [],
        pending: true,
        message: 'Navigating to time details page...'
      };
    }
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

    // Target the specific FCLM time details table using its unique selector
    const targetTable = document.querySelector('table.ganttChart[aria-label="Time Details"]');

    if (!targetTable) {
      log('Could not find table.ganttChart[aria-label="Time Details"]', 'warn');
      // Fallback: try to find any table with ganttChart class
      const fallbackTable = document.querySelector('table.ganttChart');
      if (fallbackTable) {
        log('Found fallback table.ganttChart', 'info');
        return scrapeGanttTable(fallbackTable, employeeId, result);
      }
      log('No ganttChart table found at all', 'error');
      return result;
    }

    log('Found time details table: table.ganttChart[aria-label="Time Details"]', 'success');
    return scrapeGanttTable(targetTable, employeeId, result);
  }

  // Parse the FCLM gantt chart table structure
  function scrapeGanttTable(table, employeeId, result) {
    // Get all rows from tbody (skip thead which has summary and header rows)
    const tbody = table.querySelector('tbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : table.querySelectorAll('tr');

    log(`Found ${rows.length} rows in table`);

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowClass = row.className || '';

      // Skip rows that aren't data rows (header rows, summary rows)
      if (rowClass.includes('totSummary') || row.querySelector('th')) {
        continue;
      }

      // Determine row type and parse accordingly
      // Row types: clock-seg, function-seg, job-seg
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) continue;

      let title = '';
      let start = '';
      let end = '';
      let duration = '';

      if (rowClass.includes('job-seg')) {
        // Job segment rows have: [trackingType] [title (in <a>)] [start] [end] [duration]
        // Cell 0: trackingType (e.g., "m")
        // Cell 1: title with <a> link containing job name
        // Cell 2: start time
        // Cell 3: end time
        // Cell 4: duration
        const titleLink = cells[1]?.querySelector('a');
        title = titleLink ? titleLink.textContent.trim() : cells[1]?.textContent?.trim() || '';
        start = cells[2]?.textContent?.trim() || '';
        end = cells[3]?.textContent?.trim() || '';
        duration = cells[4]?.textContent?.trim() || '';

        log(`[job-seg] Row ${rowIdx}: ${title} | ${start} | ${end} | ${duration}`);

      } else if (rowClass.includes('function-seg') || rowClass.includes('clock-seg')) {
        // Function/Clock segment rows have: [title colspan=2] [start] [end] [duration]
        // The title cell spans 2 columns, so indices shift:
        // Cell 0: title (colspan="2", may contain ♦ separator like "C-Returns Support♦C-Returns_StowSweep")
        // Cell 1: start time
        // Cell 2: end time
        // Cell 3: duration
        let rawTitle = cells[0]?.textContent?.trim() || '';

        // Handle diamond separator (♦ or &diams;) - extract the path name after it
        if (rawTitle.includes('♦')) {
          const parts = rawTitle.split('♦');
          title = parts[parts.length - 1].trim(); // Get the path name (last part)
        } else {
          title = rawTitle;
        }

        start = cells[1]?.textContent?.trim() || '';
        end = cells[2]?.textContent?.trim() || '';
        duration = cells[3]?.textContent?.trim() || '';

        log(`[${rowClass.includes('function-seg') ? 'function-seg' : 'clock-seg'}] Row ${rowIdx}: ${title} | ${start} | ${end} | ${duration}`);

      } else {
        // Unknown row type - try generic parsing
        // Assume: [title] [start] [end] [duration] or [title colspan=2] [start] [end] [duration]
        const firstCell = cells[0];
        const colspan = firstCell?.getAttribute('colspan');

        if (colspan === '2') {
          title = firstCell?.textContent?.trim() || '';
          start = cells[1]?.textContent?.trim() || '';
          end = cells[2]?.textContent?.trim() || '';
          duration = cells[3]?.textContent?.trim() || '';
        } else {
          // Check if first cell looks like trackingType (single char like "m")
          const firstText = firstCell?.textContent?.trim() || '';
          if (firstText.length <= 2 && cells.length >= 5) {
            // Likely job-seg style
            const titleLink = cells[1]?.querySelector('a');
            title = titleLink ? titleLink.textContent.trim() : cells[1]?.textContent?.trim() || '';
            start = cells[2]?.textContent?.trim() || '';
            end = cells[3]?.textContent?.trim() || '';
            duration = cells[4]?.textContent?.trim() || '';
          } else {
            title = firstText;
            start = cells[1]?.textContent?.trim() || '';
            end = cells[2]?.textContent?.trim() || '';
            duration = cells[3]?.textContent?.trim() || '';
          }
        }
        log(`[unknown] Row ${rowIdx}: ${title} | ${start} | ${end} | ${duration}`);
      }

      // Skip empty titles or clock entries (OnClock/OffClock are not work activities)
      if (!title || title.includes('OffClock') || title.includes('OnClock')) {
        continue;
      }

      // IMPORTANT: For MPV time calculation, only count job-seg rows
      // function-seg rows show aggregate time that OVERLAPS with job-seg rows
      // job-seg rows are the actual individual work sessions
      // Counting both would double-count the time!
      if (rowClass.includes('function-seg')) {
        log(`Skipping function-seg row for MPV (overlaps with job-seg): ${title} - ${duration}`);
        continue;
      }

      // Parse duration - FCLM uses MM:SS format (e.g., "210:35" = 210 mins 35 secs)
      const durationMinutes = parseDurationToMinutes(duration);

      const session = {
        title,
        start,
        end,
        duration,
        durationMinutes,
        rowType: rowClass.includes('job-seg') ? 'job' : 'other'
      };

      result.sessions.push(session);
      log(`Parsed session: ${title} - ${duration} (${durationMinutes} mins)`, 'success');

      // Track current activity (no end time = ongoing)
      if (!end || end === '') {
        result.currentActivity = session;
        result.isClockedIn = true;
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

    // Target the specific FCLM time details table using its unique selector
    const targetTable = doc.querySelector('table.ganttChart[aria-label="Time Details"]') ||
                        doc.querySelector('table.ganttChart');

    if (!targetTable) {
      log('No ganttChart table found in parsed HTML', 'warn');
      return result;
    }

    log('Found ganttChart table in parsed HTML', 'success');

    // Use the same parsing logic as scrapeGanttTable
    const tbody = targetTable.querySelector('tbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : targetTable.querySelectorAll('tr');

    log(`Found ${rows.length} rows in parsed table`);

    // DEBUG: Track all restricted path time from function-seg (aggregate rows)
    let functionSegTotals = {};

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowClass = row.className || '';

      // Skip non-data rows
      if (rowClass.includes('totSummary') || row.querySelector('th')) {
        log(`Skipping row ${rowIdx}: totSummary or th`);
        continue;
      }

      const cells = row.querySelectorAll('td');
      if (cells.length < 4) {
        log(`Skipping row ${rowIdx}: only ${cells.length} cells`);
        continue;
      }

      // DEBUG: Log raw row content
      log(`Row ${rowIdx} [${rowClass}]: ${Array.from(cells).map(c => c.textContent.trim().substring(0, 20)).join(' | ')}`);

      let title = '';
      let start = '';
      let end = '';
      let duration = '';

      if (rowClass.includes('job-seg')) {
        // Job segment: [trackingType] [title in <a>] [start] [end] [duration]
        const titleLink = cells[1]?.querySelector('a');
        title = titleLink ? titleLink.textContent.trim() : cells[1]?.textContent?.trim() || '';
        start = cells[2]?.textContent?.trim() || '';
        end = cells[3]?.textContent?.trim() || '';
        duration = cells[4]?.textContent?.trim() || '';
      } else if (rowClass.includes('function-seg') || rowClass.includes('clock-seg')) {
        // Function/Clock segment: [title colspan=2] [start] [end] [duration]
        let rawTitle = cells[0]?.textContent?.trim() || '';
        if (rawTitle.includes('♦')) {
          const parts = rawTitle.split('♦');
          title = parts[parts.length - 1].trim();
        } else {
          title = rawTitle;
        }
        start = cells[1]?.textContent?.trim() || '';
        end = cells[2]?.textContent?.trim() || '';
        duration = cells[3]?.textContent?.trim() || '';
      } else {
        // Generic fallback
        const firstCell = cells[0];
        const colspan = firstCell?.getAttribute('colspan');
        if (colspan === '2') {
          title = firstCell?.textContent?.trim() || '';
          start = cells[1]?.textContent?.trim() || '';
          end = cells[2]?.textContent?.trim() || '';
          duration = cells[3]?.textContent?.trim() || '';
        } else {
          const firstText = firstCell?.textContent?.trim() || '';
          if (firstText.length <= 2 && cells.length >= 5) {
            const titleLink = cells[1]?.querySelector('a');
            title = titleLink ? titleLink.textContent.trim() : cells[1]?.textContent?.trim() || '';
            start = cells[2]?.textContent?.trim() || '';
            end = cells[3]?.textContent?.trim() || '';
            duration = cells[4]?.textContent?.trim() || '';
          } else {
            title = firstText;
            start = cells[1]?.textContent?.trim() || '';
            end = cells[2]?.textContent?.trim() || '';
            duration = cells[3]?.textContent?.trim() || '';
          }
        }
      }

      // Skip empty or clock entries
      if (!title || title.includes('OffClock') || title.includes('OnClock')) {
        continue;
      }

      // Track function-seg totals (aggregate time per path)
      // These are the TOTAL time for a path, useful for comparison
      if (rowClass.includes('function-seg')) {
        const durationMins = parseDurationToMinutes(duration);
        functionSegTotals[title] = (functionSegTotals[title] || 0) + durationMins;
        log(`function-seg TOTAL for "${title}": ${duration} (${durationMins.toFixed(1)} mins)`);
        // Don't skip - we'll use this for verification but also parse job-seg rows
      }

      // Skip function-seg for session counting (job-seg has the actual sessions)
      // But we captured the total above for comparison
      if (rowClass.includes('function-seg')) {
        continue;
      }

      const durationMinutes = parseDurationToMinutes(duration);

      const session = {
        title,
        start,
        end,
        duration,
        durationMinutes,
        rowType: rowClass.includes('job-seg') ? 'job' : 'other'
      };

      result.sessions.push(session);
      log(`Parsed session: ${title} - ${duration} (${durationMinutes} mins)`);

      if (!end || end === '') {
        result.currentActivity = session;
        result.isClockedIn = true;
      }
    }

    log(`Total sessions parsed: ${result.sessions.length}`);

    // DEBUG: Log function-seg totals vs job-seg totals
    log('=== TIME COMPARISON ===');
    log(`function-seg totals (aggregate): ${JSON.stringify(functionSegTotals)}`);

    // Calculate job-seg totals per path for comparison
    const jobSegTotals = {};
    result.sessions.forEach(session => {
      jobSegTotals[session.title] = (jobSegTotals[session.title] || 0) + session.durationMinutes;
    });
    log(`job-seg totals (sum of sessions): ${JSON.stringify(jobSegTotals)}`);

    // If function-seg totals are higher, use those instead (more accurate)
    for (const [path, funcMins] of Object.entries(functionSegTotals)) {
      const jobMins = jobSegTotals[path] || 0;
      if (funcMins > jobMins) {
        log(`WARNING: function-seg (${funcMins.toFixed(1)} min) > job-seg (${jobMins.toFixed(1)} min) for "${path}"`);
        // Add a synthetic session with the difference to correct the total
        const diff = funcMins - jobMins;
        result.sessions.push({
          title: path,
          start: '',
          end: '',
          duration: `${Math.floor(diff)}:${Math.round((diff % 1) * 60)}`,
          durationMinutes: diff,
          rowType: 'correction',
          note: 'Added to match function-seg total'
        });
        log(`Added correction session: +${diff.toFixed(1)} mins for "${path}"`);
      }
    }

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

    log(`Final session count: ${result.sessions.length} for ${employeeId}`, 'success');
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

    if (message.action === 'fetchPathAAs') {
      fetchPathAAs(message.paths)
        .then(data => {
          sendResponse({ success: true, data });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true; // Async response
    }

  });

  // ============== FETCH AAs ON RESTRICTED PATHS ==============

  // Process IDs for fetching function rollup data
  const PROCESS_IDS = {
    'C-Returns Support': '1003058',
    'C-Returns Processed': '1003026',
    'V-Returns': '1003059',
    'WHD Grading': '1002979',
    'WHD Grading Support': '1003060'
  };

  async function fetchPathAAs(paths) {
    log(`Fetching AAs on paths: ${paths.join(', ')}`);

    const shiftRange = getShiftDateRange();
    const result = {};
    for (const path of paths) {
      result[path] = [];
    }

    // Fetch from both C-Returns and V-Returns processes
    for (const [processName, processId] of Object.entries(PROCESS_IDS)) {
      try {
        const params = new URLSearchParams({
          reportFormat: 'HTML',
          warehouseId: CONFIG.WAREHOUSE_ID,
          processId: processId,
          maxIntradayDays: '1',
          spanType: 'Intraday',
          startDateIntraday: shiftRange.startDate,
          startHourIntraday: String(shiftRange.startHour),
          startMinuteIntraday: '0',
          endDateIntraday: shiftRange.endDate,
          endHourIntraday: String(shiftRange.endHour),
          endMinuteIntraday: '0'
        });

        const rollupUrl = `https://fclm-portal.amazon.com/reports/functionRollup?${params.toString()}`;
        log(`Fetching ${processName}: ${rollupUrl}`);

        const response = await fetch(rollupUrl, { credentials: 'include' });
        const html = await response.text();

        // Parse the HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Find all tables - each path has its own table with a header
        // The structure is: header row with path name, then column headers, then data rows
        const allElements = doc.body.querySelectorAll('*');
        let currentPath = null;

        for (const elem of allElements) {
          const text = elem.textContent.trim();

          // Check if this element is a path header
          // Headers look like: "C-Returns_StowSweep [1599235343587]" or "Vreturns WaterSpider [ID]"
          for (const path of paths) {
            if (text.includes(path) && (text.includes('[') || elem.tagName === 'B' || elem.tagName === 'STRONG')) {
              currentPath = path;
              log(`Found path section: ${path}`);
              break;
            }
          }
        }

        // Better approach: find tables and look for path names in table headers/caption
        const tables = doc.querySelectorAll('table');

        for (const table of tables) {
          const tableText = table.textContent;

          // Check which path this table belongs to
          let tablePath = null;
          for (const path of paths) {
            if (tableText.includes(path)) {
              tablePath = path;
              break;
            }
          }

          if (!tablePath) continue;

          // Special handling for Water Spider - distinguish by source process
          // WHD processes -> WHD Waterspider, C-Returns processes -> Water Spider (CRET)
          if (tablePath === 'Water Spider') {
            if (processName.includes('WHD') || processName.includes('Warehouse')) {
              tablePath = 'WHD Waterspider';
              log(`Water Spider from WHD process -> mapping to WHD Waterspider`);
            } else {
              log(`Water Spider from ${processName} -> keeping as Water Spider (CRET)`);
            }
          }

          log(`Parsing table for path: ${tablePath} (from ${processName})`);

          // Make sure the result array exists for this path
          if (!result[tablePath]) {
            result[tablePath] = [];
          }

          // Find the header row to determine the "Total" column index
          const rows = table.querySelectorAll('tr');
          let totalColumnIndex = -1;
          let idColumnIndex = 1; // Default: ID is usually second column
          let nameColumnIndex = 2; // Default: Name is usually third column

          // First pass: find header row and column indices
          for (const row of rows) {
            const headerCells = row.querySelectorAll('th');
            if (headerCells.length > 0) {
              // This is a header row - find column indices
              for (let i = 0; i < headerCells.length; i++) {
                const headerText = headerCells[i]?.textContent?.trim()?.toLowerCase() || '';
                if (headerText === 'total') {
                  totalColumnIndex = i;
                  log(`Found Total column at index ${i}`);
                }
                if (headerText === 'id' || headerText === 'badge' || headerText === 'employee id') {
                  idColumnIndex = i;
                }
                if (headerText === 'name' || headerText === 'employee name') {
                  nameColumnIndex = i;
                }
              }
              break; // Only process first header row
            }

            // Also check for header-style td cells (some tables use td for headers)
            const cells = row.querySelectorAll('td');
            if (cells.length > 0) {
              const firstCellText = cells[0]?.textContent?.trim() || '';
              if (firstCellText === 'Type') {
                // This is a header row using td elements
                for (let i = 0; i < cells.length; i++) {
                  const cellText = cells[i]?.textContent?.trim()?.toLowerCase() || '';
                  if (cellText === 'total') {
                    totalColumnIndex = i;
                    log(`Found Total column at index ${i} (td header)`);
                  }
                }
                break;
              }
            }
          }

          // If we couldn't find Total column, try to infer from last numeric column
          if (totalColumnIndex === -1) {
            log(`Could not find Total column header, will use last numeric cell`);
          }

          // Second pass: parse data rows
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) continue;

            // Skip header rows and total rows
            const firstCellText = cells[0]?.textContent?.trim() || '';
            if (firstCellText === 'Type' || firstCellText === 'Total' || firstCellText === '') continue;

            // Structure: Type | ID | Name | Manager | ... | Total
            // Type is usually "AMZN" but can also be "TEMP"
            if (firstCellText !== 'AMZN' && firstCellText !== 'TEMP') continue;

            // DEBUG: Log all cell values for this row
            const cellValues = Array.from(cells).map((c, i) => `[${i}]=${c.textContent.trim().substring(0, 15)}`);
            log(`Row cells (${cells.length} total): ${cellValues.join(' | ')}`);

            // Get badge ID from ID column (may be a link)
            const idCell = cells[idColumnIndex];
            const idLink = idCell?.querySelector('a');
            const badgeId = idLink ? idLink.textContent.trim() : idCell?.textContent?.trim();

            if (!badgeId || !/^\d+$/.test(badgeId)) continue;

            // Get name from Name column
            const nameCell = cells[nameColumnIndex];
            const nameLink = nameCell?.querySelector('a');
            const name = nameLink ? nameLink.textContent.trim() : nameCell?.textContent?.trim() || '';

            // Get total hours - use found index or find last numeric cell
            let hours = 0;
            let hoursSource = 'none';
            if (totalColumnIndex !== -1 && totalColumnIndex < cells.length) {
              const totalText = cells[totalColumnIndex]?.textContent?.trim() || '0';
              hours = parseFloat(totalText) || 0;
              hoursSource = `col[${totalColumnIndex}]="${totalText}"`;
            } else {
              // Fallback: find the last cell that contains a valid number
              // Start from the end and work backwards
              for (let i = cells.length - 1; i >= 3; i--) {
                const cellText = cells[i]?.textContent?.trim() || '';
                // Check if it looks like a number (hours can be decimals like "8.37")
                if (/^[\d.]+$/.test(cellText) && cellText !== '') {
                  const parsed = parseFloat(cellText);
                  if (!isNaN(parsed)) {
                    hours = parsed;
                    hoursSource = `fallback col[${i}]="${cellText}"`;
                    break;
                  }
                }
              }
            }

            // If still 0, try summing all numeric cells (hourly breakdown columns)
            if (hours === 0) {
              let summedHours = 0;
              for (let i = 4; i < cells.length - 1; i++) { // Skip first 4 cols and last col
                const cellText = cells[i]?.textContent?.trim() || '';
                if (/^[\d.]+$/.test(cellText)) {
                  summedHours += parseFloat(cellText) || 0;
                }
              }
              if (summedHours > 0) {
                hours = summedHours;
                hoursSource = `summed=${summedHours.toFixed(2)}`;
              }
            }

            log(`Hours for ${name}: ${hours}h (source: ${hoursSource})`);

            const minutes = hours * 60;

            // Add to results if not already there
            if (!result[tablePath].find(aa => aa.badgeId === badgeId)) {
              result[tablePath].push({
                badgeId,
                name,
                minutes,
                hours
              });
              log(`Found AA: ${name} (${badgeId}) - ${hours}h on ${tablePath}`);
            }
          }
        }

      } catch (error) {
        log(`Error fetching ${processName}: ${error.message}`, 'error');
      }
    }

    // Sort each path by hours descending
    for (const path of paths) {
      result[path].sort((a, b) => b.minutes - a.minutes);
    }

    const totalAAs = Object.values(result).reduce((sum, arr) => sum + arr.length, 0);
    log(`Found ${totalAAs} total AAs on restricted paths`, 'success');

    return result;
  }

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
  function registerWithBackground() {
    browser.runtime.sendMessage({
      action: 'contentScriptReady',
      pageType: 'fclm',
      url: window.location.href,
      warehouseId: CONFIG.WAREHOUSE_ID
    }).then(() => {
      log('Registered with background script', 'success');
    }).catch(err => {
      log(`Could not register with background: ${err.message}`, 'warn');
    });
  }

  // Initial registration
  registerWithBackground();

  // Heartbeat - re-register every 30 seconds to keep connection alive
  // This handles cases where the content script context gets invalidated
  setInterval(() => {
    registerWithBackground();
  }, 30000);

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
