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

  // Track current MPV check result to block submission if needed
  let currentMpvCheckResult = null;

  // Track pending badge lookup while waiting for FCLM navigation
  let pendingBadgeLookup = null;

  // Track if a lookup is currently in progress (to block premature submission)
  let lookupInProgress = false;
  let lookupPromise = null;

  // Create floating panel UI
  createFloatingPanel();

  // On badge page, intercept native form submission to enforce MPV check
  if (isBadgePage) {
    interceptNativeFormSubmission();
  }

  // Listen for messages from the popup and other scripts
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

    // Handle async time details result from FCLM (after navigation)
    if (message.action === 'timeDetailsResult') {
      console.log('[FC Labor Tracking] Received async time details result:', message.data);

      // Get current work code for MPV check
      browser.runtime.sendMessage({
        action: 'getCurrentWorkCode'
      }).then(response => {
        const currentWorkCode = response?.workCode || null;
        showAssociateTimeDetails(message.data, currentWorkCode);
      });

      sendResponse({ received: true });
      return false;
    }

    // Handle FCLM connection status changes
    if (message.action === 'fclmConnected') {
      updateFclmStatus();
      sendResponse({ received: true });
      return false;
    }

    if (message.action === 'fclmDisconnected') {
      updateFclmStatus();
      sendResponse({ received: true });
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
      .fc-lt-associate-info.mpv-warning {
        background: rgba(231, 76, 60, 0.3);
        border: 2px solid #e74c3c;
        animation: mpv-pulse 1s ease-in-out infinite;
      }
      @keyframes mpv-pulse {
        0%, 100% { box-shadow: 0 0 5px rgba(231, 76, 60, 0.5); }
        50% { box-shadow: 0 0 15px rgba(231, 76, 60, 0.8); }
      }
      .mpv-alert {
        background: #e74c3c;
        color: #fff;
        padding: 6px 8px;
        border-radius: 4px;
        font-weight: 600;
        font-size: 12px;
        margin-bottom: 6px;
        text-align: center;
      }
      .mpv-details {
        font-size: 11px;
        color: #ff6b6b;
        margin-top: 4px;
      }
      .fc-lt-associate-info.mpv-ok {
        background: rgba(46, 204, 113, 0.2);
        border: 2px solid #2ecc71;
      }
      .mpv-ok-alert {
        background: #2ecc71;
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
        font-weight: 600;
        font-size: 11px;
        margin-bottom: 6px;
        text-align: center;
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

    // Badge input - lookup on change (with shorter debounce for scanner)
    // Scanners type fast and send Enter at the end, so we need to be quick
    badgeInput.addEventListener('input', debounce(async () => {
      const badgeId = badgeInput.value.trim();
      if (badgeId.length >= 3) {
        // Start lookup and track it
        lookupInProgress = true;
        lookupPromise = lookupAssociate(badgeId).finally(() => {
          lookupInProgress = false;
        });
        await lookupPromise;
      } else {
        hideAssociateInfo();
        currentMpvCheckResult = null;
      }
    }, 150)); // Reduced debounce time for faster scanner response

    // Badge submission - wait for lookup if in progress
    submitBadgeBtn.addEventListener('click', () => submitBadge());
    badgeInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Prevent default form submission
        await submitBadge();
      }
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

      // Store work code in background script for MPV check on badge page
      await browser.runtime.sendMessage({
        action: 'setCurrentWorkCode',
        workCode: workCode
      });
      console.log('[FC Labor Tracking] Work code stored for MPV check:', workCode);

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

    // If lookup is in progress, wait for it to complete first
    if (lookupInProgress && lookupPromise) {
      console.log('[FC Labor Tracking] Waiting for lookup to complete before submit...');
      showPanelMessage('Checking MPV status...', 'info');
      try {
        await lookupPromise;
      } catch (e) {
        console.log('[FC Labor Tracking] Lookup failed during wait:', e);
      }
    }

    // If no lookup was done yet (very fast scan), do it now synchronously
    if (!currentMpvCheckResult && badgeId.length >= 3) {
      console.log('[FC Labor Tracking] No MPV result yet, performing lookup now...');
      showPanelMessage('Checking MPV status...', 'info');
      try {
        await lookupAssociate(badgeId);
      } catch (e) {
        console.log('[FC Labor Tracking] Quick lookup failed:', e);
      }
    }

    // CHECK FOR MPV RISK - BLOCK SUBMISSION IF DETECTED
    if (currentMpvCheckResult && currentMpvCheckResult.hasMpvRisk) {
      console.log('[FC Labor Tracking] BLOCKED - MPV risk detected!', currentMpvCheckResult);
      showPanelMessage('🚫 BLOCKED - MPV Risk! Cannot submit this badge.', 'error');

      // Flash the warning to make it more obvious
      const infoDiv = document.getElementById('fc-lt-associate-info');
      if (infoDiv) {
        infoDiv.style.transform = 'scale(1.05)';
        setTimeout(() => { infoDiv.style.transform = 'scale(1)'; }, 200);
      }

      // DO NOT submit - return early
      return;
    }

    try {
      showPanelMessage('Submitting badge...', 'info');
      await handleBadgeIdInput(badgeId);
      showPanelMessage('Badge added!', 'success');
      input.value = '';
      hideAssociateInfo();
      currentMpvCheckResult = null; // Reset for next badge

      // Ready for next badge
      setTimeout(() => {
        showPanelMessage('Ready for next badge', 'info');
        input.focus();
      }, 1000);
    } catch (error) {
      showPanelMessage('Error: ' + error.message, 'error');
    }
  }

  // Intercept native form submission on badge page to enforce MPV check
  function interceptNativeFormSubmission() {
    console.log('[FC Labor Tracking] Setting up native form interception on badge page');

    // Find the native badge input and form
    const nativeBadgeInput = document.getElementById('trackingBadgeId') ||
                             document.querySelector('input[name="trackingBadgeId"]');

    if (!nativeBadgeInput) {
      console.log('[FC Labor Tracking] Native badge input not found');
      return;
    }

    const nativeForm = nativeBadgeInput.closest('form');
    console.log('[FC Labor Tracking] Found native badge input and form:', !!nativeForm);

    // Watch for changes to the native input (scanner inputs here)
    nativeBadgeInput.addEventListener('input', debounce(async () => {
      const badgeId = nativeBadgeInput.value.trim();
      console.log('[FC Labor Tracking] Native input changed:', badgeId);

      // Sync to our panel input
      const panelInput = document.getElementById('fc-lt-badge');
      if (panelInput && panelInput.value !== badgeId) {
        panelInput.value = badgeId;
      }

      if (badgeId.length >= 3) {
        lookupInProgress = true;
        lookupPromise = lookupAssociate(badgeId).finally(() => {
          lookupInProgress = false;
        });
        await lookupPromise;
      }
    }, 100)); // Very short debounce for native input

    // Intercept Enter key on native input
    nativeBadgeInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        console.log('[FC Labor Tracking] Enter pressed on native input - intercepting');
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Sync badge to our panel and submit through our logic
        const panelInput = document.getElementById('fc-lt-badge');
        if (panelInput) {
          panelInput.value = nativeBadgeInput.value;
        }

        await submitBadge();
      }
    }, true); // Use capture phase to intercept before other handlers

    // Also intercept form submission directly
    if (nativeForm) {
      nativeForm.addEventListener('submit', async (e) => {
        console.log('[FC Labor Tracking] Form submit intercepted');

        // Always prevent default - we'll submit manually if allowed
        e.preventDefault();
        e.stopPropagation();

        // Sync badge to our panel and submit through our logic
        const panelInput = document.getElementById('fc-lt-badge');
        if (panelInput) {
          panelInput.value = nativeBadgeInput.value;
        }

        await submitBadge();
      }, true); // Use capture phase
    }

    // Watch for Done button clicks too
    const doneButton = document.querySelector('input[type="submit"][value="Done"]') ||
                       document.querySelector('input[type="submit"]');
    if (doneButton) {
      doneButton.addEventListener('click', async (e) => {
        // Only intercept if there's a badge being entered
        const badgeId = nativeBadgeInput.value.trim();
        if (badgeId.length > 0) {
          console.log('[FC Labor Tracking] Done button clicked with badge - intercepting');
          e.preventDefault();
          e.stopPropagation();

          const panelInput = document.getElementById('fc-lt-badge');
          if (panelInput) {
            panelInput.value = badgeId;
          }

          await submitBadge();
        }
      }, true);
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

    // Reset previous MPV result for fresh lookup
    currentMpvCheckResult = null;

    try {
      // Show loading state
      showAssociateLoading(badgeId);

      // Get the current work code from background script
      const workCodeResponse = await browser.runtime.sendMessage({
        action: 'getCurrentWorkCode'
      });
      const currentWorkCode = workCodeResponse?.workCode || null;
      console.log('[FC Labor Tracking] Current work code for MPV check:', currentWorkCode);

      // Store the badge ID in case we get an async result later
      pendingBadgeLookup = badgeId;

      const response = await browser.runtime.sendMessage({
        action: 'fetchEmployeeTimeDetails',
        employeeId: badgeId
      });

      if (response.success && response.data) {
        // Check if FCLM is navigating to fetch data (will send result async later)
        if (response.data.pending) {
          console.log('[FC Labor Tracking] FCLM is navigating to fetch data...');
          showAssociateLoading(badgeId);
          const detailsDiv = document.getElementById('fc-lt-associate-details');
          if (detailsDiv) {
            detailsDiv.textContent = 'Loading from FCLM (navigating)...';
          }
          // Result will come via 'timeDetailsResult' message later
          return;
        }

        showAssociateTimeDetails(response.data, currentWorkCode);
      } else {
        // Check if FCLM might be temporarily unavailable (navigating)
        const errorMsg = response.error || 'Unknown error';
        if (errorMsg.includes('not connected') || errorMsg.includes('Could not establish connection')) {
          console.log('[FC Labor Tracking] FCLM may be navigating, will retry on async result');
          showAssociateLoading(badgeId);
          const detailsDiv = document.getElementById('fc-lt-associate-details');
          if (detailsDiv) {
            detailsDiv.textContent = 'Waiting for FCLM...';
          }
          // Refresh FCLM status after a delay
          setTimeout(updateFclmStatus, 2000);
        } else {
          showAssociateNotFound(badgeId, errorMsg);
        }
      }
    } catch (error) {
      console.log('[FC Labor Tracking] Lookup error:', error);
      // Don't immediately show as disconnected - might be temporary
      showAssociateLoading(badgeId);
      const detailsDiv = document.getElementById('fc-lt-associate-details');
      if (detailsDiv) {
        detailsDiv.textContent = 'Connecting to FCLM...';
      }
      // Refresh FCLM status
      setTimeout(updateFclmStatus, 1000);
    }
  }

  function showAssociateLoading(badgeId) {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    const nameDiv = document.getElementById('fc-lt-associate-name');
    const detailsDiv = document.getElementById('fc-lt-associate-details');

    if (!infoDiv) return;

    // Clear all previous states including MPV warnings
    infoDiv.classList.remove('hidden', 'not-found', 'mpv-warning', 'mpv-ok');
    nameDiv.textContent = 'Looking up...';
    detailsDiv.textContent = `Badge: ${badgeId}`;
  }

  // MPV (Multiple Path Violation) Configuration
  // These are the restricted paths that can cause MPV
  const MPV_RESTRICTED_PATHS = {
    'C-Returns_StowSweep': ['STWSWP', 'STOWSWEEP', 'SWEEP', 'CRESW', 'STOW_SWEEP', 'STOWSW', 'STSW'],
    'C-Returns_EndofLine': ['CREOL', 'EOL', 'ENDOFLINE', 'END_OF_LINE', 'ENDLINE'],
    'Vreturns WaterSpider': ['VRWS', 'WATERSPIDER', 'VRETWS', 'VRWATER']
  };

  // Max time allowed on a restricted path (4 hours 30 minutes in minutes)
  const MPV_MAX_TIME_MINUTES = 270;

  // Get which restricted path a work code belongs to (if any)
  function getRestrictedPathForWorkCode(workCode) {
    if (!workCode) return null;
    const upperCode = workCode.toUpperCase().replace(/[^A-Z0-9]/g, '');

    console.log('[MPV] Matching work code:', upperCode);

    for (const [pathTitle, codes] of Object.entries(MPV_RESTRICTED_PATHS)) {
      for (const code of codes) {
        // Exact match or work code starts with the pattern
        if (upperCode === code || upperCode.startsWith(code) || code.startsWith(upperCode)) {
          console.log('[MPV] Work code', upperCode, 'matched to', pathTitle, 'via', code);
          return pathTitle;
        }
      }
    }
    console.log('[MPV] Work code', upperCode, 'did not match any restricted path');
    return null;
  }

  // Get which restricted path a session title belongs to (if any)
  function getRestrictedPathForTitle(title) {
    if (!title) return null;

    // Normalize title for matching (remove special chars, lowercase)
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Check each restricted path with flexible matching
    for (const pathTitle of Object.keys(MPV_RESTRICTED_PATHS)) {
      const normalizedPath = pathTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Exact or contains match
      if (title.includes(pathTitle) || normalizedTitle.includes(normalizedPath)) {
        return pathTitle;
      }

      // Also check for key parts: stowsweep, endofline, waterspider
      if (pathTitle.includes('StowSweep') && (normalizedTitle.includes('stowsweep') || normalizedTitle.includes('sweepstow'))) {
        return pathTitle;
      }
      if (pathTitle.includes('EndofLine') && (normalizedTitle.includes('endofline') || normalizedTitle.includes('eol'))) {
        return pathTitle;
      }
      if (pathTitle.includes('WaterSpider') && (normalizedTitle.includes('waterspider') || normalizedTitle.includes('ws'))) {
        return pathTitle;
      }
    }
    return null;
  }

  // Parse duration string (e.g., "2h 30m", "45m", "1:30:00") to minutes
  function parseDurationToMinutes(duration) {
    if (!duration) return 0;

    // Try "Xh Ym" format
    const hMatch = duration.match(/(\d+)\s*h/i);
    const mMatch = duration.match(/(\d+)\s*m/i);
    if (hMatch || mMatch) {
      const hours = hMatch ? parseInt(hMatch[1]) : 0;
      const mins = mMatch ? parseInt(mMatch[1]) : 0;
      return hours * 60 + mins;
    }

    // Try "H:MM:SS" or "H:MM" format
    const timeMatch = duration.match(/(\d+):(\d+)(?::(\d+))?/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const mins = parseInt(timeMatch[2]);
      return hours * 60 + mins;
    }

    return 0;
  }

  // Calculate total time per restricted path from sessions
  function calculateRestrictedPathTimes(sessions) {
    const pathTimes = {};

    for (const session of sessions) {
      const restrictedPath = getRestrictedPathForTitle(session.title);
      if (restrictedPath) {
        // Use durationMinutes from FCLM (already parsed), fallback to parsing duration string
        const mins = session.durationMinutes || parseDurationToMinutes(session.duration);
        pathTimes[restrictedPath] = (pathTimes[restrictedPath] || 0) + mins;
        console.log(`[MPV] ${session.title} -> ${restrictedPath}: ${mins} mins`);
      }
    }

    console.log('[MPV] Path times:', pathTimes);
    return pathTimes;
  }

  // Check for MPV risk based on current work code and AA history
  function checkForMpvRisk(sessions, currentWorkCode) {
    console.log('[MPV] Checking MPV risk for work code:', currentWorkCode);
    console.log('[MPV] Number of sessions received:', sessions ? sessions.length : 'null/undefined');
    console.log('[MPV] Sessions to check:', JSON.stringify(sessions, null, 2));

    const result = {
      hasMpvRisk: false,
      reason: null,
      details: null,
      workedPaths: [],
      targetPath: null,
      pathTimes: {}
    };

    // Get the restricted path for the work code being assigned
    const targetPath = getRestrictedPathForWorkCode(currentWorkCode);
    result.targetPath = targetPath;
    console.log('[MPV] Target restricted path:', targetPath);

    // Calculate time spent on each restricted path
    const pathTimes = calculateRestrictedPathTimes(sessions);
    result.pathTimes = pathTimes;

    // Find which restricted paths the AA has worked
    const workedPaths = Object.keys(pathTimes);
    result.workedPaths = workedPaths;

    // If target is not a restricted path, no MPV risk
    if (!targetPath) {
      return result;
    }

    // Rule 1: Check if AA has worked a DIFFERENT restricted path
    for (const workedPath of workedPaths) {
      if (workedPath !== targetPath) {
        result.hasMpvRisk = true;
        result.reason = 'PATH_SWITCH';
        result.details = `Already worked ${workedPath} (${formatMinutes(pathTimes[workedPath])}). Cannot switch to ${targetPath}.`;
        return result;
      }
    }

    // Rule 2: Check if AA has exceeded 4:30 on the target restricted path
    const targetTime = pathTimes[targetPath] || 0;
    if (targetTime >= MPV_MAX_TIME_MINUTES) {
      result.hasMpvRisk = true;
      result.reason = 'TIME_EXCEEDED';
      result.details = `Already ${formatMinutes(targetTime)} on ${targetPath}. Max allowed is ${formatMinutes(MPV_MAX_TIME_MINUTES)}.`;
      return result;
    }

    // If same path and under time limit, show remaining time as info
    if (targetTime > 0) {
      const remaining = MPV_MAX_TIME_MINUTES - targetTime;
      result.remainingTime = remaining;
      result.currentTime = targetTime;
    }

    return result;
  }

  // Format minutes as "Xh Ym"
  function formatMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  function showAssociateTimeDetails(data, currentWorkCode) {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    const nameDiv = document.getElementById('fc-lt-associate-name');
    const detailsDiv = document.getElementById('fc-lt-associate-details');

    if (!infoDiv) return;

    infoDiv.classList.remove('hidden', 'not-found', 'mpv-warning', 'mpv-ok');

    // Check for MPV risk based on current work code
    const mpvCheck = checkForMpvRisk(data.sessions, currentWorkCode);

    // Store the MPV check result to block submission if needed
    currentMpvCheckResult = mpvCheck;
    console.log('[FC Labor Tracking] MPV check result stored:', mpvCheck.hasMpvRisk ? 'BLOCKED' : 'OK');

    // Find current activity
    const currentActivity = data.currentActivity;
    const isClockedIn = data.isClockedIn;

    // Display employee ID and status
    nameDiv.textContent = `Badge: ${data.employeeId}`;

    if (mpvCheck.hasMpvRisk) {
      // Show MPV warning - BLOCK this assignment
      infoDiv.classList.add('mpv-warning');

      let alertText = '⚠️ MPV RISK - DO NOT ASSIGN!';
      if (mpvCheck.reason === 'PATH_SWITCH') {
        alertText = '🚫 MPV - PATH SWITCH BLOCKED!';
      } else if (mpvCheck.reason === 'TIME_EXCEEDED') {
        alertText = '🚫 MPV - TIME LIMIT EXCEEDED!';
      }

      detailsDiv.innerHTML = `
        <div class="mpv-alert">${alertText}</div>
        <div class="mpv-details">${mpvCheck.details}</div>
        ${currentActivity ? `<br>Current: ${currentActivity.title}` : ''}
      `;
      showPanelMessage('🚫 MPV Risk - Cannot assign!', 'error');

    } else if (mpvCheck.targetPath && mpvCheck.remainingTime) {
      // Same restricted path, under limit - show remaining time
      infoDiv.classList.add('mpv-ok');
      detailsDiv.innerHTML = `
        <div class="mpv-ok-alert">✓ OK - Same path, time remaining</div>
        <strong>${mpvCheck.targetPath}</strong><br>
        Used: ${formatMinutes(mpvCheck.currentTime)} | Remaining: ${formatMinutes(mpvCheck.remainingTime)}
        ${currentActivity ? `<br>Current: ${currentActivity.title}` : ''}
      `;
      showPanelMessage(`✓ OK - ${formatMinutes(mpvCheck.remainingTime)} remaining`, 'success');

    } else if (mpvCheck.targetPath && mpvCheck.workedPaths.length === 0) {
      // First time on restricted path
      infoDiv.classList.add('mpv-ok');
      detailsDiv.innerHTML = `
        <div class="mpv-ok-alert">✓ OK - First time on this path</div>
        <strong>${mpvCheck.targetPath}</strong><br>
        Max allowed: ${formatMinutes(MPV_MAX_TIME_MINUTES)}
        ${currentActivity ? `<br>Current: ${currentActivity.title}` : ''}
      `;
      showPanelMessage('✓ First time on restricted path', 'success');

    } else if (currentActivity) {
      // Non-restricted path with current activity
      const statusClass = isClockedIn ? 'uph' : 'uph low';
      detailsDiv.innerHTML = `
        <strong>${currentActivity.title}</strong><br>
        <span class="${statusClass}">${isClockedIn ? 'Active' : 'Inactive'}</span> |
        Duration: ${currentActivity.duration || 'ongoing'}
      `;
      showPanelMessage('✓ Ready to assign', 'success');

    } else if (data.sessions.length > 0) {
      // Non-restricted path, show last session
      const lastSession = data.sessions[data.sessions.length - 1];
      detailsDiv.innerHTML = `
        Last: <strong>${lastSession.title}</strong><br>
        ${data.hoursOnTask ? `Hours: ${data.hoursOnTask.toFixed(1)}h` : `Sessions: ${data.sessions.length}`}
      `;
      showPanelMessage('✓ Ready to assign', 'info');

    } else {
      detailsDiv.textContent = 'No time details found for today';
      showPanelMessage('✓ Ready to assign (no history)', 'info');
    }
  }

  function showAssociateNotFound(badgeId, reason) {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    const nameDiv = document.getElementById('fc-lt-associate-name');
    const detailsDiv = document.getElementById('fc-lt-associate-details');

    if (!infoDiv) return;

    infoDiv.classList.remove('hidden', 'mpv-warning', 'mpv-ok');
    infoDiv.classList.add('not-found');

    nameDiv.textContent = 'Lookup failed';
    detailsDiv.textContent = reason || `Badge: ${badgeId} - Not found in FCLM`;

    // Clear the MPV check result since lookup failed
    currentMpvCheckResult = null;
  }

  function hideAssociateInfo() {
    const infoDiv = document.getElementById('fc-lt-associate-info');
    if (infoDiv) {
      infoDiv.classList.add('hidden');
      infoDiv.classList.remove('not-found', 'mpv-warning', 'mpv-ok');
    }
    // Clear the MPV check result
    currentMpvCheckResult = null;
  }

  async function updateFclmStatus() {
    const statusEl = document.getElementById('fc-lt-fclm-status');
    if (!statusEl) return;

    try {
      const response = await browser.runtime.sendMessage({
        action: 'checkFclmConnection'
      });

      if (response.connected) {
        statusEl.textContent = 'FCLM Ready';
        statusEl.className = 'fc-lt-fclm-status connected';
        statusEl.title = 'FCLM connected - will lookup employee on badge scan';
      } else {
        statusEl.textContent = 'FCLM Offline';
        statusEl.className = 'fc-lt-fclm-status disconnected';
        statusEl.title = 'Open fclm-portal.amazon.com to enable lookups';
      }
    } catch (error) {
      statusEl.textContent = '--';
      statusEl.className = 'fc-lt-fclm-status';
      statusEl.title = 'FCLM: Unable to check status';
    }
  }

  // Listen for FCLM connection status changes
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fclmConnected') {
      console.log('[FC Labor Tracking] FCLM connected');
      updateFclmStatus();
      showPanelMessage('FCLM connected!', 'success');
    }
    if (message.action === 'fclmDisconnected') {
      console.log('[FC Labor Tracking] FCLM disconnected');
      updateFclmStatus();
      showPanelMessage('FCLM disconnected', 'error');
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
