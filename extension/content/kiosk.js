// FC Labor Tracking Assistant - Kiosk Content Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Content script loaded on kiosk page');

  // Determine which page we're on based on URL
  const isWorkCodePage = window.location.pathname.includes('/laborTrackingKiosk') &&
                          !window.location.pathname.startsWith('/do/');
  const isBadgePage = window.location.pathname.startsWith('/do/laborTrackingKiosk');

  // Extract warehouse ID from URL (e.g., IND8 from /IND8/laborTrackingKiosk)
  const warehouseMatch = window.location.pathname.match(/\/([A-Z0-9]+)\/laborTrackingKiosk/);
  const warehouseId = warehouseMatch ? warehouseMatch[1] : 'IND8';

  console.log('[FC Labor Tracking] Page type:', isWorkCodePage ? 'Work Code' : (isBadgePage ? 'Badge ID' : 'Unknown'));
  console.log('[FC Labor Tracking] Warehouse ID:', warehouseId);

  // Create floating panel UI
  createFloatingPanel();

  // Listen for messages from the popup
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FC Labor Tracking] Received message:', message);

    if (message.action === 'inputWorkCode') {
      handleWorkCodeInput(message.workCode)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.action === 'inputBadgeId') {
      handleBadgeIdInput(message.badgeId)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.action === 'getPageState') {
      sendResponse({
        isWorkCodePage,
        isBadgePage,
        url: window.location.href
      });
      return false;
    }
  });

  function createFloatingPanel() {
    // Remove existing panel if any
    const existing = document.getElementById('fc-labor-tracking-panel');
    if (existing) existing.remove();

    // Create panel container
    const panel = document.createElement('div');
    panel.id = 'fc-labor-tracking-panel';
    panel.innerHTML = `
      <div class="fc-lt-header">
        <span class="fc-lt-title">Labor Tracking Assistant</span>
        <span class="fc-lt-fclm-status" id="fc-lt-fclm-status" title="FCLM Data Status">--</span>
        <button class="fc-lt-minimize" title="Minimize">_</button>
      </div>
      <div class="fc-lt-body">
        <div class="fc-lt-section" id="fc-lt-workcode-section">
          <label>Work Code</label>
          <input type="text" id="fc-lt-workcode" placeholder="Enter work code (e.g., CREOL)" autocomplete="off">
          <button id="fc-lt-submit-workcode" class="fc-lt-btn primary">Submit</button>
        </div>
        <div class="fc-lt-section hidden" id="fc-lt-badge-section">
          <label>Badge ID</label>
          <input type="text" id="fc-lt-badge" placeholder="Scan or enter badge ID" autocomplete="off">
          <div class="fc-lt-associate-info hidden" id="fc-lt-associate-info">
            <div class="fc-lt-associate-name" id="fc-lt-associate-name"></div>
            <div class="fc-lt-associate-details" id="fc-lt-associate-details"></div>
          </div>
          <button id="fc-lt-submit-badge" class="fc-lt-btn primary">Submit Badge</button>
          <button id="fc-lt-done" class="fc-lt-btn success">Done</button>
          <button id="fc-lt-back" class="fc-lt-btn secondary">Back</button>
        </div>
        <div class="fc-lt-message hidden" id="fc-lt-message"></div>
      </div>
    `;

    // Add styles
    const styles = document.createElement('style');
    styles.textContent = `
      #fc-labor-tracking-panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 280px;
        background: #1a1a2e;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        z-index: 999999;
        color: #fff;
        overflow: hidden;
      }
      #fc-labor-tracking-panel.minimized .fc-lt-body {
        display: none;
      }
      #fc-labor-tracking-panel.minimized {
        width: auto;
      }
      .fc-lt-header {
        background: #16213e;
        padding: 10px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
      }
      .fc-lt-title {
        font-size: 13px;
        font-weight: 600;
      }
      .fc-lt-minimize {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
      }
      .fc-lt-minimize:hover {
        color: #fff;
      }
      .fc-lt-body {
        padding: 12px;
      }
      .fc-lt-section {
        margin-bottom: 8px;
      }
      .fc-lt-section.hidden {
        display: none;
      }
      .fc-lt-section label {
        display: block;
        font-size: 11px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .fc-lt-section input {
        width: 100%;
        padding: 8px 10px;
        font-size: 14px;
        border: 2px solid #333;
        border-radius: 4px;
        background: #0f0f1a;
        color: #fff;
        outline: none;
        box-sizing: border-box;
      }
      .fc-lt-section input:focus {
        border-color: #3498db;
      }
      .fc-lt-btn {
        width: 100%;
        padding: 8px;
        font-size: 13px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-top: 8px;
      }
      .fc-lt-btn.primary {
        background: #3498db;
        color: #fff;
      }
      .fc-lt-btn.primary:hover {
        background: #2980b9;
      }
      .fc-lt-btn.success {
        background: #27ae60;
        color: #fff;
      }
      .fc-lt-btn.success:hover {
        background: #219a52;
      }
      .fc-lt-btn.secondary {
        background: #444;
        color: #fff;
      }
      .fc-lt-btn.secondary:hover {
        background: #555;
      }
      .fc-lt-message {
        padding: 8px;
        border-radius: 4px;
        font-size: 12px;
        margin-top: 8px;
      }
      .fc-lt-message.hidden {
        display: none;
      }
      .fc-lt-message.success {
        background: rgba(46, 204, 113, 0.2);
        border: 1px solid rgba(46, 204, 113, 0.4);
        color: #2ecc71;
      }
      .fc-lt-message.error {
        background: rgba(231, 76, 60, 0.2);
        border: 1px solid rgba(231, 76, 60, 0.4);
        color: #e74c3c;
      }
      .fc-lt-message.info {
        background: rgba(52, 152, 219, 0.2);
        border: 1px solid rgba(52, 152, 219, 0.4);
        color: #3498db;
      }
      .fc-lt-fclm-status {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 3px;
        background: #333;
        color: #888;
        margin-left: auto;
        margin-right: 8px;
      }
      .fc-lt-fclm-status.connected {
        background: rgba(46, 204, 113, 0.2);
        color: #2ecc71;
      }
      .fc-lt-fclm-status.disconnected {
        background: rgba(231, 76, 60, 0.2);
        color: #e74c3c;
      }
      .fc-lt-associate-info {
        background: #16213e;
        border-radius: 4px;
        padding: 8px;
        margin: 8px 0;
      }
      .fc-lt-associate-info.hidden {
        display: none;
      }
      .fc-lt-associate-name {
        font-weight: 600;
        font-size: 14px;
        color: #fff;
        margin-bottom: 4px;
      }
      .fc-lt-associate-details {
        font-size: 11px;
        color: #888;
      }
      .fc-lt-associate-details .uph {
        color: #2ecc71;
        font-weight: 500;
      }
      .fc-lt-associate-details .uph.low {
        color: #e74c3c;
      }
      .fc-lt-associate-info.not-found {
        background: rgba(231, 76, 60, 0.2);
        border: 1px solid rgba(231, 76, 60, 0.3);
      }
      .fc-lt-associate-info.not-found .fc-lt-associate-name {
        color: #e74c3c;
      }
    `;

    document.head.appendChild(styles);
    document.body.appendChild(panel);

    // Setup event listeners
    setupPanelEvents(panel);

    // Make panel draggable
    makeDraggable(panel);

    // Auto-show badge section if on badge page
    if (isBadgePage) {
      document.getElementById('fc-lt-workcode-section').classList.add('hidden');
      document.getElementById('fc-lt-badge-section').classList.remove('hidden');
      document.getElementById('fc-lt-badge').focus();
    } else {
      document.getElementById('fc-lt-workcode').focus();
    }
  }

  function setupPanelEvents(panel) {
    const minimizeBtn = panel.querySelector('.fc-lt-minimize');
    const workCodeInput = document.getElementById('fc-lt-workcode');
    const badgeInput = document.getElementById('fc-lt-badge');
    const submitWorkCodeBtn = document.getElementById('fc-lt-submit-workcode');
    const submitBadgeBtn = document.getElementById('fc-lt-submit-badge');
    const doneBtn = document.getElementById('fc-lt-done');
    const backBtn = document.getElementById('fc-lt-back');

    // Minimize toggle
    minimizeBtn.addEventListener('click', () => {
      panel.classList.toggle('minimized');
      minimizeBtn.textContent = panel.classList.contains('minimized') ? '+' : '_';
    });

    // Work code submission
    submitWorkCodeBtn.addEventListener('click', () => submitWorkCode());
    workCodeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitWorkCode();
    });

    // Badge input - lookup on change
    badgeInput.addEventListener('input', debounce(async () => {
      const badgeId = badgeInput.value.trim();
      if (badgeId.length >= 3) {
        await lookupAssociate(badgeId);
      } else {
        hideAssociateInfo();
      }
    }, 300));

    // Badge submission
    submitBadgeBtn.addEventListener('click', () => submitBadge());
    badgeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitBadge();
    });

    // Done button - clicks the page's Done/Submit button
    doneBtn.addEventListener('click', () => clickPageDoneButton());

    // Back button - triggers the page's back functionality
    backBtn.addEventListener('click', () => triggerBack());
  }

  function makeDraggable(panel) {
    const header = panel.querySelector('.fc-lt-header');
    let isDragging = false;
    let offsetX, offsetY;

    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('fc-lt-minimize')) return;
      isDragging = true;
      offsetX = e.clientX - panel.offsetLeft;
      offsetY = e.clientY - panel.offsetTop;
      panel.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.left = (e.clientX - offsetX) + 'px';
      panel.style.top = (e.clientY - offsetY) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      panel.style.cursor = '';
    });
  }

  async function submitWorkCode() {
    const input = document.getElementById('fc-lt-workcode');
    const workCode = input.value.trim().toUpperCase();

    if (!workCode) {
      showPanelMessage('Please enter a work code', 'error');
      input.focus();
      return;
    }

    try {
      showPanelMessage('Submitting work code...', 'info');
      await handleWorkCodeInput(workCode);
      showPanelMessage('Work code submitted!', 'success');

      // The page will navigate, but if it doesn't, switch to badge mode
      setTimeout(() => {
        if (document.getElementById('fc-lt-workcode-section')) {
          document.getElementById('fc-lt-workcode-section').classList.add('hidden');
          document.getElementById('fc-lt-badge-section').classList.remove('hidden');
          document.getElementById('fc-lt-badge').focus();
          showPanelMessage('Enter badge ID', 'info');
        }
      }, 500);
    } catch (error) {
      showPanelMessage('Error: ' + error.message, 'error');
    }
  }

  async function submitBadge() {
    const input = document.getElementById('fc-lt-badge');
    const badgeId = input.value.trim();

    if (!badgeId) {
      showPanelMessage('Please enter a badge ID', 'error');
      input.focus();
      return;
    }

    try {
      showPanelMessage('Submitting badge...', 'info');
      await handleBadgeIdInput(badgeId);
      showPanelMessage('Badge added!', 'success');
      input.value = '';
      hideAssociateInfo();

      // Ready for next badge
      setTimeout(() => {
        showPanelMessage('Ready for next badge', 'info');
        input.focus();
      }, 1000);
    } catch (error) {
      showPanelMessage('Error: ' + error.message, 'error');
    }
  }

  function clickPageDoneButton() {
    // Find and click the Done/Submit button on the page
    const submitBtn = document.querySelector('input[type="submit"][value="Done"]') ||
                      document.querySelector('input[type="submit"]') ||
                      document.querySelector('button[type="submit"]');

    if (submitBtn) {
      console.log('[FC Labor Tracking] Clicking Done button');
      submitBtn.click();
      showPanelMessage('Done clicked!', 'success');
    } else {
      showPanelMessage('Could not find Done button', 'error');
    }
  }

  function triggerBack() {
    console.log('[FC Labor Tracking] Triggering back navigation');

    // Method 1: Try to trigger the hotkey event that the page listens to
    if (typeof jQuery !== 'undefined' && jQuery.publish) {
      jQuery.publish('/hotkey/back');
      showPanelMessage('Going back...', 'info');
      return;
    }

    // Method 2: Simulate pressing 'b' key (the page's back hotkey)
    const bKeyEvent = new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      keyCode: 66,
      which: 66,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(bKeyEvent);

    // Method 3: Direct navigation as fallback
    setTimeout(() => {
      // Check if we're still on the same page
      if (isBadgePage) {
        window.location.href = `/${warehouseId}/laborTrackingKiosk`;
      } else if (typeof window.APP_LAUNCHER_MAIN !== 'undefined') {
        window.location.href = window.APP_LAUNCHER_MAIN;
      } else {
        window.history.back();
      }
    }, 100);

    showPanelMessage('Going back...', 'info');
  }

  function showPanelMessage(text, type) {
    const msg = document.getElementById('fc-lt-message');
    msg.textContent = text;
    msg.className = 'fc-lt-message ' + type;
  }

  // ============== FCLM INTEGRATION ==============

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  async function lookupAssociate(badgeId) {
    console.log('[FC Labor Tracking] Looking up associate:', badgeId);

    try {
      const response = await browser.runtime.sendMessage({
        action: 'lookupAssociate',
        badgeId: badgeId
      });

      if (response.found && response.associate) {
        showAssociateInfo(response.associate);
      } else {
        showAssociateNotFound(badgeId);
      }
    } catch (error) {
      console.log('[FC Labor Tracking] Lookup error:', error);
      hideAssociateInfo();
    }
  }

  function showAssociateInfo(associate) {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    const nameDiv = document.getElementById('fc-lt-associate-name');
    const detailsDiv = document.getElementById('fc-lt-associate-details');

    if (!infoDiv) return;

    infoDiv.classList.remove('hidden', 'not-found');

    nameDiv.textContent = associate.name || associate.employee_id;

    const uphClass = associate.uph < 50 ? 'uph low' : 'uph';
    detailsDiv.innerHTML = `
      ${associate.function_name || 'Unknown function'} |
      <span class="${uphClass}">${Math.round(associate.uph)} UPH</span> |
      ${associate.paid_hours_total?.toFixed(1) || 0}h
    `;
  }

  function showAssociateNotFound(badgeId) {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    const nameDiv = document.getElementById('fc-lt-associate-name');
    const detailsDiv = document.getElementById('fc-lt-associate-details');

    if (!infoDiv) return;

    infoDiv.classList.remove('hidden');
    infoDiv.classList.add('not-found');

    nameDiv.textContent = 'Associate not found in FCLM';
    detailsDiv.textContent = `Badge: ${badgeId} - May be new or not clocked in`;
  }

  function hideAssociateInfo() {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    if (infoDiv) {
      infoDiv.classList.add('hidden');
      infoDiv.classList.remove('not-found');
    }
  }

  async function updateFclmStatus() {
    const statusEl = document.getElementById('fc-lt-fclm-status');
    if (!statusEl) return;

    try {
      const response = await browser.runtime.sendMessage({
        action: 'getFclmData'
      });

      if (response.count > 0) {
        statusEl.textContent = `${response.count} AAs`;
        statusEl.className = 'fc-lt-fclm-status connected';
        statusEl.title = `FCLM: ${response.count} associates loaded (${response.shiftDate})`;
      } else {
        statusEl.textContent = 'No data';
        statusEl.className = 'fc-lt-fclm-status disconnected';
        statusEl.title = 'FCLM: No associate data - open FCLM portal';
      }
    } catch (error) {
      statusEl.textContent = '--';
      statusEl.className = 'fc-lt-fclm-status';
      statusEl.title = 'FCLM: Unable to check status';
    }
  }

  // Listen for FCLM data updates
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fclmDataUpdated') {
      console.log('[FC Labor Tracking] FCLM data updated:', message.count, 'associates');
      updateFclmStatus();
      showPanelMessage(`FCLM: ${message.count} associates loaded`, 'success');
      setTimeout(() => {
        const input = document.getElementById('fc-lt-badge');
        if (input && input.value) {
          showPanelMessage('Ready for badge', 'info');
        }
      }, 2000);
    }
  });

  // Initial FCLM status check
  setTimeout(updateFclmStatus, 1000);

  // Periodic status update
  setInterval(updateFclmStatus, 30000);

  async function handleWorkCodeInput(workCode) {
    console.log('[FC Labor Tracking] Attempting to input work code:', workCode);

    // Target the specific calmCode input field
    const inputField = document.getElementById('calmCode') ||
                       document.querySelector('input[name="calmCode"]') ||
                       document.querySelector('input[placeholder*="Indirect Work code" i]');

    if (!inputField) {
      throw new Error('Could not find work code input field (#calmCode)');
    }

    console.log('[FC Labor Tracking] Found calmCode input field');

    // Clear and set value
    inputField.focus();
    inputField.value = '';

    // Set the value directly
    inputField.value = workCode;

    // Dispatch events for any JS listeners
    inputField.dispatchEvent(new Event('input', { bubbles: true }));
    inputField.dispatchEvent(new Event('change', { bubbles: true }));

    // Small delay then submit the form
    await sleep(100);

    // Find and submit the form
    const form = inputField.closest('form');
    if (form) {
      console.log('[FC Labor Tracking] Submitting form');
      form.submit();
    } else {
      // Fallback: simulate Enter key
      await simulateEnterKey(inputField);
    }

    return { success: true };
  }

  async function handleBadgeIdInput(badgeId) {
    console.log('[FC Labor Tracking] Attempting to input badge ID:', badgeId);

    // Target the specific trackingBadgeId input field
    const inputField = document.getElementById('trackingBadgeId') ||
                       document.querySelector('input[name="trackingBadgeId"]');

    if (!inputField) {
      throw new Error('Could not find badge ID input field (#trackingBadgeId)');
    }

    console.log('[FC Labor Tracking] Found trackingBadgeId input field');

    // Clear and set value
    inputField.focus();
    inputField.value = '';

    // Set the value using native setter to trigger React/Vue reactivity
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(inputField, badgeId);

    // Dispatch input event
    inputField.dispatchEvent(new Event('input', { bubbles: true }));
    inputField.dispatchEvent(new Event('change', { bubbles: true }));

    // Small delay then click the Done button to submit the form
    await sleep(150);

    // Find and click the Done/Submit button
    const submitBtn = document.querySelector('input[type="submit"][value="Done"]') ||
                      document.querySelector('input[type="submit"]') ||
                      document.querySelector('button[type="submit"]');

    if (submitBtn) {
      console.log('[FC Labor Tracking] Clicking Done button to submit badge');
      submitBtn.click();
    } else {
      // Fallback: submit the form directly
      const form = inputField.closest('form');
      if (form) {
        console.log('[FC Labor Tracking] Submitting form directly');
        form.submit();
      } else {
        throw new Error('Could not find submit button or form');
      }
    }

    return { success: true };
  }

  async function simulateEnterKey(element) {
    // Make sure element has focus
    element.focus();

    // Method 1: Try jQuery trigger if available (the page uses jQuery)
    if (typeof jQuery !== 'undefined') {
      try {
        const $element = jQuery(element);
        const jqEvent = jQuery.Event('keydown', {
          key: 'Enter',
          keyCode: 13,
          which: 13
        });
        $element.trigger(jqEvent);

        const jqKeypress = jQuery.Event('keypress', {
          key: 'Enter',
          keyCode: 13,
          which: 13
        });
        $element.trigger(jqKeypress);

        const jqKeyup = jQuery.Event('keyup', {
          key: 'Enter',
          keyCode: 13,
          which: 13
        });
        $element.trigger(jqKeyup);

        console.log('[FC Labor Tracking] Triggered Enter via jQuery');
        return;
      } catch (e) {
        console.log('[FC Labor Tracking] jQuery trigger failed:', e);
      }
    }

    // Method 2: Native KeyboardEvent dispatch
    const eventOptions = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      view: window
    };

    // Create and dispatch keydown event
    const enterDown = new KeyboardEvent('keydown', eventOptions);
    element.dispatchEvent(enterDown);

    // Dispatch keypress
    const enterPress = new KeyboardEvent('keypress', eventOptions);
    element.dispatchEvent(enterPress);

    // Dispatch keyup
    const enterUp = new KeyboardEvent('keyup', eventOptions);
    element.dispatchEvent(enterUp);

    console.log('[FC Labor Tracking] Dispatched Enter via native events');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Notify background script
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: isWorkCodePage ? 'workCode' : (isBadgePage ? 'badge' : 'unknown'),
    url: window.location.href,
    warehouseId: warehouseId
  }).catch(err => {
    console.log('[FC Labor Tracking] Could not notify background script:', err);
  });

})();
