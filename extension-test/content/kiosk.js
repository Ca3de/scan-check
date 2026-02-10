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

  // Extension enabled state - when ON, intercepts all badge scans for MPV check
  // When OFF, allows native form submission without any intervention
  let extensionEnabled = true;

  // Recent work codes for suggestions
  let recentWorkCodes = [];

  // Path refresh timer for auto-refresh every 15 minutes
  let pathRefreshTimer = null;

  // Restricted paths configuration
  const RESTRICTED_PATHS = [
    'C-Returns_StowSweep', // TEST ONLY - for MPV testing
    'Vreturns WaterSpider',
    'C-Returns_EndofLine',
    'Water Spider',      // Generic Water Spider (covers CRET)
    'WHD Waterspider',   // WHD Water Spider variant
    'WHD Water Spider',  // WHD Water Spider with space
    'Team_Mech_Wspider'  // CRET Support Team Mech Water Spider
  ];
  const PATH_REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

  // Load extension state and recent work codes from storage
  async function loadExtensionState() {
    try {
      const data = await browser.storage.local.get(['extensionEnabled', 'recentWorkCodes']);
      if (data.extensionEnabled !== undefined) {
        extensionEnabled = data.extensionEnabled;
      }
      if (data.recentWorkCodes) {
        recentWorkCodes = data.recentWorkCodes;
      }
      console.log('[FC Labor Tracking] Loaded state - enabled:', extensionEnabled, 'workCodes:', recentWorkCodes.length);
      updateToggleUI();
    } catch (e) {
      console.log('[FC Labor Tracking] Could not load state:', e);
    }
  }

  async function saveExtensionState() {
    try {
      await browser.storage.local.set({
        extensionEnabled,
        recentWorkCodes: recentWorkCodes.slice(0, 20) // Keep last 20
      });
    } catch (e) {
      console.log('[FC Labor Tracking] Could not save state:', e);
    }
  }

  function toggleExtension() {
    extensionEnabled = !extensionEnabled;
    saveExtensionState();
    updateToggleUI();
    console.log('[FC Labor Tracking] Extension', extensionEnabled ? 'ENABLED' : 'DISABLED');
  }

  function updateToggleUI() {
    const toggle = document.getElementById('fc-lt-toggle');
    const panel = document.getElementById('fc-labor-tracking-panel');
    if (toggle) {
      toggle.textContent = extensionEnabled ? 'ON' : 'OFF';
      toggle.className = 'fc-lt-toggle ' + (extensionEnabled ? 'on' : 'off');
    }
    if (panel) {
      panel.classList.toggle('disabled', !extensionEnabled);
    }
  }

  function addRecentWorkCode(code) {
    const upper = code.toUpperCase();
    // Remove if exists and add to front
    recentWorkCodes = recentWorkCodes.filter(c => c !== upper);
    recentWorkCodes.unshift(upper);
    saveExtensionState();
  }

  function getWorkCodeSuggestions(input) {
    const upper = input.toUpperCase();
    if (!upper) return [];
    return recentWorkCodes.filter(code => code.includes(upper) && code !== upper).slice(0, 5);
  }

  loadExtensionState();

  // Create floating panel UI
  createFloatingPanel();

  // On badge page, set up native form watching (not full interception)
  if (isBadgePage) {
    setupNativeFormWatching();
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
    // Remove existing panels if any
    const existing = document.getElementById('fc-labor-tracking-panel');
    if (existing) existing.remove();
    const existingLeft = document.getElementById('fc-path-tracking-panel');
    if (existingLeft) existingLeft.remove();

    // Create LEFT panel - Restricted Path AAs
    const leftPanel = document.createElement('div');
    leftPanel.id = 'fc-path-tracking-panel';
    leftPanel.innerHTML = `
      <div class="fc-lt-header">
        <span class="fc-lt-title">Restricted Path AAs</span>
        <button id="fc-lt-refresh-paths" class="fc-lt-refresh-btn" title="Refresh">↻</button>
        <button class="fc-lt-minimize fc-lt-minimize-left" title="Minimize">_</button>
      </div>
      <div class="fc-lt-body">
        <div class="fc-lt-path-updated" id="fc-lt-path-updated">Not loaded</div>
        <div class="fc-lt-path-list" id="fc-lt-path-list">
          <div class="fc-lt-path-empty">Click ↻ to load AAs</div>
        </div>
      </div>
    `;

    // Create RIGHT panel - Labor Tracking Assistant
    const panel = document.createElement('div');
    panel.id = 'fc-labor-tracking-panel';
    panel.innerHTML = `
      <div class="fc-lt-header">
        <span class="fc-lt-title">Labor Tracking Assistant</span>
        <span class="fc-lt-fclm-status" id="fc-lt-fclm-status" title="FCLM Data Status">--</span>
        <button class="fc-lt-toggle on" id="fc-lt-toggle" title="Toggle MPV Check ON/OFF">ON</button>
        <button class="fc-lt-minimize" title="Minimize">_</button>
      </div>
      <div class="fc-lt-body">
        <div class="fc-lt-section" id="fc-lt-workcode-section">
          <label>Work Code</label>
          <div class="fc-lt-input-wrapper">
            <input type="text" id="fc-lt-workcode" placeholder="Enter work code (e.g., CREOL)" autocomplete="off">
            <div class="fc-lt-suggestions hidden" id="fc-lt-workcode-suggestions"></div>
          </div>
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
      #fc-labor-tracking-panel, #fc-path-tracking-panel {
        position: fixed;
        top: 20px;
        width: 280px;
        background: #1a1a2e;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        z-index: 999999;
        color: #fff;
        overflow: hidden;
      }
      #fc-labor-tracking-panel {
        right: 20px;
      }
      #fc-path-tracking-panel {
        left: 20px;
        width: 260px;
      }
      #fc-labor-tracking-panel.minimized .fc-lt-body,
      #fc-path-tracking-panel.minimized .fc-lt-body {
        display: none;
      }
      #fc-labor-tracking-panel.minimized,
      #fc-path-tracking-panel.minimized {
        width: auto;
      }
      .fc-lt-header {
        background: #16213e;
        padding: 10px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: move;
        gap: 8px;
      }
      .fc-lt-title {
        font-size: 13px;
        font-weight: 600;
        flex-grow: 1;
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
      .fc-lt-toggle {
        font-size: 10px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 3px;
        border: none;
        cursor: pointer;
        margin-right: 4px;
      }
      .fc-lt-toggle.on {
        background: #27ae60;
        color: #fff;
      }
      .fc-lt-toggle.off {
        background: #e74c3c;
        color: #fff;
      }
      #fc-labor-tracking-panel.disabled {
        opacity: 0.6;
      }
      #fc-labor-tracking-panel.disabled .fc-lt-body {
        pointer-events: none;
      }
      .fc-lt-input-wrapper {
        position: relative;
      }
      .fc-lt-suggestions {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: #1a1a2e;
        border: 1px solid #333;
        border-top: none;
        border-radius: 0 0 4px 4px;
        z-index: 10;
        max-height: 150px;
        overflow-y: auto;
      }
      .fc-lt-suggestions.hidden {
        display: none;
      }
      .fc-lt-suggestion {
        padding: 8px 10px;
        cursor: pointer;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fc-lt-suggestion:hover {
        background: #16213e;
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
      .fc-lt-path-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      .fc-lt-path-header label {
        margin-bottom: 0;
      }
      .fc-lt-refresh-btn {
        background: #333;
        border: none;
        color: #888;
        font-size: 14px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 3px;
      }
      .fc-lt-refresh-btn:hover {
        background: #444;
        color: #fff;
      }
      .fc-lt-refresh-btn.loading {
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .fc-lt-path-updated {
        font-size: 10px;
        color: #666;
        margin-bottom: 6px;
      }
      .fc-lt-path-list {
        background: #0f0f1a;
        border-radius: 4px;
        max-height: 60vh;
        overflow-y: auto;
      }
      .fc-lt-path-empty {
        padding: 10px;
        text-align: center;
        color: #666;
        font-size: 11px;
      }
      .fc-lt-path-group {
        border-bottom: 1px solid #222;
      }
      .fc-lt-path-group:last-child {
        border-bottom: none;
      }
      .fc-lt-path-name {
        background: #16213e;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 600;
        color: #ff9900;
      }
      .fc-lt-path-aa {
        padding: 4px 10px;
        font-size: 11px;
        display: flex;
        justify-content: space-between;
        border-bottom: 1px solid #1a1a2e;
      }
      .fc-lt-path-aa:last-child {
        border-bottom: none;
      }
      .fc-lt-path-aa-name {
        color: #ccc;
      }
      .fc-lt-path-aa-time {
        color: #888;
      }
      .fc-lt-path-aa-time.warning {
        color: #e74c3c;
        font-weight: 600;
      }
    `;

    document.head.appendChild(styles);
    document.body.appendChild(leftPanel);
    document.body.appendChild(panel);

    // Setup event listeners for both panels
    setupPanelEvents(panel);
    setupLeftPanelEvents(leftPanel);

    // Make both panels draggable
    makeDraggable(panel);
    makeDraggable(leftPanel);

    // Auto-show badge section if on badge page
    if (isBadgePage) {
      document.getElementById('fc-lt-workcode-section').classList.add('hidden');
      document.getElementById('fc-lt-badge-section').classList.remove('hidden');
      document.getElementById('fc-lt-badge').focus();
    } else {
      document.getElementById('fc-lt-workcode').focus();
    }
  }

  function setupLeftPanelEvents(panel) {
    const minimizeBtn = panel.querySelector('.fc-lt-minimize-left');
    const refreshBtn = document.getElementById('fc-lt-refresh-paths');

    // Minimize toggle
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        panel.classList.toggle('minimized');
        minimizeBtn.textContent = panel.classList.contains('minimized') ? '+' : '_';
      });
    }

    // Refresh path AAs
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => refreshPathAAs());
    }

    // Load cached path data on init
    loadCachedPathAAs();

    // Start auto-refresh timer for restricted paths (every 15 minutes)
    startPathAutoRefresh();
  }

  function startPathAutoRefresh() {
    // Clear any existing timer
    if (pathRefreshTimer) {
      clearInterval(pathRefreshTimer);
    }

    // Auto-refresh every 15 minutes
    pathRefreshTimer = setInterval(() => {
      console.log('[FC Labor Tracking] Auto-refreshing restricted path AAs...');
      refreshPathAAs();
    }, PATH_REFRESH_INTERVAL);

    console.log('[FC Labor Tracking] Path auto-refresh started (every 15 minutes)');

    // Also do an initial refresh if cache is old or empty
    browser.storage.local.get(['pathAAsUpdated']).then(data => {
      if (!data.pathAAsUpdated || (Date.now() - data.pathAAsUpdated > PATH_REFRESH_INTERVAL)) {
        console.log('[FC Labor Tracking] Cache stale, doing initial refresh...');
        setTimeout(refreshPathAAs, 2000); // Slight delay to not overwhelm on load
      }
    });
  }

  function setupPanelEvents(panel) {
    const minimizeBtn = panel.querySelector('.fc-lt-minimize');
    const toggleBtn = document.getElementById('fc-lt-toggle');
    const workCodeInput = document.getElementById('fc-lt-workcode');
    const suggestionsDiv = document.getElementById('fc-lt-workcode-suggestions');
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

    // Extension ON/OFF toggle
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExtension();
    });

    // Work code input with suggestions
    workCodeInput.addEventListener('input', () => {
      const value = workCodeInput.value.trim();
      const suggestions = getWorkCodeSuggestions(value);
      if (suggestions.length > 0 && value.length > 0) {
        suggestionsDiv.textContent = '';
        suggestions.forEach(code => {
          const div = document.createElement('div');
          div.className = 'fc-lt-suggestion';
          div.textContent = code;
          div.addEventListener('click', () => {
            workCodeInput.value = code;
            suggestionsDiv.classList.add('hidden');
            workCodeInput.focus();
          });
          suggestionsDiv.appendChild(div);
        });
        suggestionsDiv.classList.remove('hidden');
      } else {
        suggestionsDiv.classList.add('hidden');
      }
    });

    workCodeInput.addEventListener('blur', () => {
      // Delay hiding to allow click on suggestion
      setTimeout(() => suggestionsDiv.classList.add('hidden'), 200);
    });

    // Work code submission
    submitWorkCodeBtn.addEventListener('click', () => submitWorkCode());
    workCodeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        suggestionsDiv.classList.add('hidden');
        submitWorkCode();
      }
    });

    // Badge input - lookup on change (with shorter debounce for scanner)
    badgeInput.addEventListener('input', debounce(async () => {
      const badgeId = badgeInput.value.trim();
      if (badgeId.length >= 3 && extensionEnabled) {
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
      addRecentWorkCode(workCode); // Save for suggestions
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

  // Watch native form for MPV check - intercept when extension is enabled
  function setupNativeFormWatching() {
    console.log('[FC Labor Tracking] Setting up native form watching on badge page');

    // Find the native badge input and form
    const nativeBadgeInput = document.getElementById('trackingBadgeId') ||
                             document.querySelector('input[name="trackingBadgeId"]');

    if (!nativeBadgeInput) {
      console.log('[FC Labor Tracking] Native badge input not found');
      return;
    }

    const nativeForm = nativeBadgeInput.closest('form');
    console.log('[FC Labor Tracking] Found native badge input and form:', !!nativeForm);

    // Track the last badge we processed to avoid duplicate lookups
    let lastProcessedBadge = '';
    let isProcessing = false;
    let bypassingInterception = false; // Global bypass flag for our own submissions

    // Main flow: on input, start lookup, then auto-submit if cleared
    async function processBadgeScan(badgeId) {
      if (!badgeId || badgeId.length < 3 || isProcessing || badgeId === lastProcessedBadge) {
        return;
      }

      console.log('[FC Labor Tracking] Processing badge scan:', badgeId);
      isProcessing = true;
      lastProcessedBadge = badgeId;

      // Sync to our panel input for display
      const panelInput = document.getElementById('fc-lt-badge');
      if (panelInput) {
        panelInput.value = badgeId;
      }

      try {
        // Start MPV lookup
        showPanelMessage('Checking MPV status...', 'info');
        await lookupAssociate(badgeId);

        // After lookup completes, check result and auto-submit if cleared
        if (currentMpvCheckResult && currentMpvCheckResult.hasMpvRisk) {
          // MPV BLOCKED - do NOT submit
          console.log('[FC Labor Tracking] MPV BLOCKED - NOT submitting badge');
          showPanelMessage('🚫 MPV Risk - Badge NOT submitted!', 'error');

          // Clear the input so they can't accidentally submit
          nativeBadgeInput.value = '';
          if (panelInput) panelInput.value = '';

          // Flash warning
          const infoDiv = document.getElementById('fc-lt-associate-info');
          if (infoDiv) {
            infoDiv.style.transform = 'scale(1.05)';
            setTimeout(() => { infoDiv.style.transform = 'scale(1)'; }, 200);
          }
        } else {
          // CLEARED - auto-submit the badge
          console.log('[FC Labor Tracking] MPV CLEARED - auto-submitting badge');
          showPanelMessage('✓ Cleared - Submitting...', 'success');

          // Submit via native form
          await actuallySubmitBadge(badgeId);

          showPanelMessage('Badge added!', 'success');

          // Clear for next badge
          nativeBadgeInput.value = '';
          if (panelInput) panelInput.value = '';
          hideAssociateInfo();
          currentMpvCheckResult = null;
          lastProcessedBadge = '';

          setTimeout(() => {
            showPanelMessage('Ready for next badge', 'info');
            nativeBadgeInput.focus();
          }, 800);
        }
      } catch (error) {
        console.log('[FC Labor Tracking] Lookup error:', error);
        showPanelMessage('Error: ' + error.message, 'error');
      } finally {
        isProcessing = false;
      }
    }

    // Actually submit the badge to the native form (called after MPV cleared)
    async function actuallySubmitBadge(badgeId) {
      console.log('[FC Labor Tracking] actuallySubmitBadge called with:', badgeId);

      // Set the value using native setter for React compatibility
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(nativeBadgeInput, badgeId);

      // Dispatch events
      nativeBadgeInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeBadgeInput.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(150);

      // Set bypass flag BEFORE submitting
      bypassingInterception = true;
      console.log('[FC Labor Tracking] Bypass flag set, submitting form...');

      try {
        // Submit the form directly (most reliable)
        if (nativeForm) {
          console.log('[FC Labor Tracking] Submitting via form.submit()');
          nativeForm.submit();
        } else {
          // Fallback: click the Done button
          const submitBtn = document.querySelector('input[type="submit"][value="Done"]') ||
                            document.querySelector('input[type="submit"]');
          if (submitBtn) {
            console.log('[FC Labor Tracking] Submitting via button click');
            submitBtn.click();
          }
        }
      } finally {
        // Reset bypass flag after a short delay
        setTimeout(() => {
          bypassingInterception = false;
        }, 500);
      }
    }

    // Sync native input to panel and trigger processing
    nativeBadgeInput.addEventListener('input', debounce(() => {
      const badgeId = nativeBadgeInput.value.trim();

      // If extension disabled, don't intercept
      if (!extensionEnabled) return;

      // Sync to panel
      const panelInput = document.getElementById('fc-lt-badge');
      if (panelInput && panelInput.value !== badgeId) {
        panelInput.value = badgeId;
      }

      // Process if valid badge length
      if (badgeId.length >= 3) {
        processBadgeScan(badgeId);
      }
    }, 150));

    // ALWAYS block Enter key from scanner - we handle submission ourselves
    nativeBadgeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (!extensionEnabled) {
          console.log('[FC Labor Tracking] Enter - extension DISABLED, allowing native');
          return;
        }

        // BLOCK Enter completely - our input handler already triggered the lookup
        console.log('[FC Labor Tracking] Enter BLOCKED - lookup already in progress');
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // Do NOT call submitBadge - the input event already triggered processing
      }
    }, true);

    // Block form submit - we handle it ourselves (unless bypassing)
    if (nativeForm) {
      nativeForm.addEventListener('submit', (e) => {
        if (!extensionEnabled) return;
        if (bypassingInterception) {
          console.log('[FC Labor Tracking] Form submit - BYPASS mode, allowing');
          return;
        }

        console.log('[FC Labor Tracking] Form submit BLOCKED');
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }

    // Block Done button clicks (unless we're bypassing)
    const doneButton = document.querySelector('input[type="submit"][value="Done"]') ||
                       document.querySelector('input[type="submit"]');
    if (doneButton) {
      doneButton.addEventListener('click', (e) => {
        // Check if this is our own bypass
        if (bypassingInterception) {
          console.log('[FC Labor Tracking] Done button - BYPASS mode, allowing');
          return;
        }

        if (!extensionEnabled) {
          console.log('[FC Labor Tracking] Done button - extension disabled, allowing');
          return;
        }

        const badgeId = nativeBadgeInput.value.trim();
        if (badgeId.length === 0) {
          console.log('[FC Labor Tracking] Done button - no badge, allowing (finishing session)');
          return;
        }

        // Block the click - our flow handles submission
        console.log('[FC Labor Tracking] Done button BLOCKED - use scanner flow');
        e.preventDefault();
        e.stopPropagation();

        // If not already processing, trigger it
        if (!isProcessing) {
          processBadgeScan(badgeId);
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

  // ============== PATH AA TRACKING ==============

  async function refreshPathAAs() {
    const refreshBtn = document.getElementById('fc-lt-refresh-paths');
    const pathList = document.getElementById('fc-lt-path-list');
    const updatedDiv = document.getElementById('fc-lt-path-updated');

    if (refreshBtn) {
      refreshBtn.classList.add('loading');
    }

    try {
      console.log('[FC Labor Tracking] Fetching path AAs from FCLM...');

      const response = await browser.runtime.sendMessage({
        action: 'fetchPathAAs',
        paths: RESTRICTED_PATHS
      });

      if (response.success && response.data) {
        displayPathAAs(response.data);

        // Cache the data
        await browser.storage.local.set({
          pathAAs: response.data,
          pathAAsUpdated: Date.now()
        });

        if (updatedDiv) {
          updatedDiv.textContent = 'Updated: ' + new Date().toLocaleTimeString();
        }
      } else {
        if (pathList) {
          pathList.textContent = '';
          const empty = document.createElement('div');
          empty.className = 'fc-lt-path-empty';
          empty.textContent = response.error || 'Failed to load. Is FCLM open?';
          pathList.appendChild(empty);
        }
      }
    } catch (e) {
      console.log('[FC Labor Tracking] Error fetching path AAs:', e);
      if (pathList) {
        pathList.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'fc-lt-path-empty';
        empty.textContent = 'Error: ' + e.message;
        pathList.appendChild(empty);
      }
    } finally {
      if (refreshBtn) {
        refreshBtn.classList.remove('loading');
      }
    }
  }

  async function loadCachedPathAAs() {
    try {
      const data = await browser.storage.local.get(['pathAAs', 'pathAAsUpdated']);
      if (data.pathAAs && data.pathAAsUpdated) {
        displayPathAAs(data.pathAAs);

        const updatedDiv = document.getElementById('fc-lt-path-updated');
        if (updatedDiv) {
          const ago = Math.round((Date.now() - data.pathAAsUpdated) / 60000);
          if (ago < 1) {
            updatedDiv.textContent = 'Updated: just now';
          } else if (ago < 60) {
            updatedDiv.textContent = `Updated: ${ago}m ago`;
          } else {
            updatedDiv.textContent = 'Updated: ' + new Date(data.pathAAsUpdated).toLocaleTimeString();
          }
        }
        // Note: Auto-refresh is handled by startPathAutoRefresh()
      }
    } catch (e) {
      console.log('[FC Labor Tracking] Could not load cached path AAs:', e);
    }
  }

  function displayPathAAs(data) {
    const pathList = document.getElementById('fc-lt-path-list');
    if (!pathList) return;

    console.log('[FC Labor Tracking] displayPathAAs called');
    console.log('[FC Labor Tracking] RESTRICTED_PATHS:', JSON.stringify(RESTRICTED_PATHS));
    console.log('[FC Labor Tracking] data keys:', JSON.stringify(Object.keys(data || {})));

    pathList.textContent = '';

    // Short name mapping for all restricted paths
    const PATH_SHORT_NAMES = {
      'C-Returns_StowSweep': 'STWSWP',
      'Vreturns WaterSpider': 'VRWS',
      'C-Returns_EndofLine': 'CREOL',
      'Water Spider': 'CRSDCNTF',
      'WHD Waterspider': 'WHDWTSP',
      'WHD Water Spider': 'WHDWTSP',
      'Team_Mech_Wspider': 'TMWSP'
    };

    for (const pathName of RESTRICTED_PATHS) {
      const pathData = data[pathName] || [];
      console.log(`[FC Labor Tracking] Rendering path: ${pathName} -> ${PATH_SHORT_NAMES[pathName] || pathName} (${pathData.length} AAs)`);

      const group = document.createElement('div');
      group.className = 'fc-lt-path-group';

      const header = document.createElement('div');
      header.className = 'fc-lt-path-name';
      const shortName = PATH_SHORT_NAMES[pathName] || pathName;
      header.textContent = `${shortName} (${pathData.length})`;
      group.appendChild(header);

      for (const aa of pathData) {
        const row = document.createElement('div');
        row.className = 'fc-lt-path-aa';

        const name = document.createElement('span');
        name.className = 'fc-lt-path-aa-name';
        // Show name with badge ID for debugging
        name.textContent = aa.name ? `${aa.name}` : aa.badgeId;
        name.title = `Badge: ${aa.badgeId}`; // Tooltip shows badge ID

        const time = document.createElement('span');
        time.className = 'fc-lt-path-aa-time';
        // Warning if over 4 hours (240 minutes)
        const totalMinutes = aa.minutes || (aa.hours * 60) || 0;
        if (totalMinutes >= 240) {
          time.classList.add('warning');
        }
        // Display hours directly if available
        if (aa.hours !== undefined) {
          time.textContent = aa.hours.toFixed(2) + 'h';
        } else {
          time.textContent = formatMinutes(totalMinutes);
        }

        row.appendChild(name);
        row.appendChild(time);
        group.appendChild(row);
      }

      pathList.appendChild(group);
    }
  }

  function formatMinutes(minutes) {
    if (!minutes && minutes !== 0) return '--';
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  }

  // ============== FCLM INTEGRATION ==============

  // Quick MPV check using cached pathAAs data (no navigation needed!)
  async function quickMpvCheckFromCache(badgeId, targetWorkCode) {
    const targetPath = getRestrictedPathForWorkCode(targetWorkCode);

    // If not a restricted work code, skip quick check
    if (!targetPath) {
      console.log('[FC Labor Tracking] Not a restricted path, skipping quick check');
      return null;
    }

    console.log('[FC Labor Tracking] Quick MPV check for badge:', badgeId, 'target:', targetPath);

    try {
      const data = await browser.storage.local.get(['pathAAs', 'pathAAsUpdated']);

      // Check if cache is fresh enough (within 30 minutes)
      if (!data.pathAAs || !data.pathAAsUpdated || (Date.now() - data.pathAAsUpdated > 30 * 60 * 1000)) {
        console.log('[FC Labor Tracking] Cache is stale or empty, falling back to full lookup');
        return null;
      }

      // Normalize badge ID for comparison (remove leading zeros, trim whitespace)
      const normalizedBadge = badgeId.toString().trim().replace(/^0+/, '');
      console.log('[FC Labor Tracking] Normalized badge for search:', normalizedBadge);

      // Debug: Log all cached badge IDs
      console.log('[FC Labor Tracking] Cached path data:');
      for (const [pathName, aas] of Object.entries(data.pathAAs)) {
        console.log(`  ${pathName}: ${aas.map(a => `${a.name}(${a.badgeId})`).join(', ')}`);
      }

      // Search for badge in cached path data
      let foundPath = null;
      let foundHours = 0;
      let foundName = '';

      for (const [pathName, aas] of Object.entries(data.pathAAs)) {
        const aa = aas.find(a => {
          // Normalize cached badge ID too
          const cachedBadge = (a.badgeId || '').toString().trim().replace(/^0+/, '');
          return cachedBadge === normalizedBadge;
        });
        if (aa) {
          foundPath = pathName;
          foundHours = aa.hours || (aa.minutes / 60) || 0;
          foundName = aa.name || '';
          console.log('[FC Labor Tracking] Found badge in cache:', pathName, foundHours + 'h', 'Name:', foundName);
          break;
        }
      }

      // Build result based on cached data
      const result = {
        hasMpvRisk: false,
        reason: null,
        details: null,
        workedPaths: foundPath ? [foundPath] : [],
        targetPath: targetPath,
        pathTimes: {},
        fromCache: true,
        employeeName: foundName
      };

      if (foundPath) {
        result.pathTimes[foundPath] = foundHours * 60; // Convert to minutes

        // Check for path switch MPV
        if (foundPath !== targetPath) {
          result.hasMpvRisk = true;
          result.reason = 'PATH_SWITCH';
          result.details = `${foundName || 'AA'} already worked ${foundPath} (${foundHours.toFixed(2)}h). Cannot switch to ${targetPath}.`;
          console.log('[FC Labor Tracking] QUICK MPV BLOCK - Path switch detected!');
          return result;
        }

        // Check for time exceeded (4h 30m = 270 min)
        const totalMinutes = foundHours * 60;
        if (totalMinutes >= MPV_MAX_TIME_MINUTES) {
          result.hasMpvRisk = true;
          result.reason = 'TIME_EXCEEDED';
          result.details = `${foundName || 'AA'} already ${foundHours.toFixed(2)}h on ${targetPath}. Max allowed is ${formatMinutes(MPV_MAX_TIME_MINUTES)}.`;
          console.log('[FC Labor Tracking] QUICK MPV BLOCK - Time exceeded!');
          return result;
        }

        // Same path, under limit - show remaining time
        result.remainingTime = MPV_MAX_TIME_MINUTES - totalMinutes;
        result.currentTime = totalMinutes;
        console.log('[FC Labor Tracking] Quick check OK - same path, time remaining:', result.remainingTime);
        return result;
      }

      // Badge not in any restricted path - OK to assign
      console.log('[FC Labor Tracking] Badge not in cached paths - OK for first time on restricted path');
      return result;

    } catch (e) {
      console.log('[FC Labor Tracking] Quick check error:', e);
      return null;
    }
  }

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

      // NOTE: Quick cache check is DISABLED because FCLM stores employee IDs
      // (e.g., 111983827) but scanners use badge IDs (e.g., 13525472).
      // These don't match, so we must use full timeDetails lookup.
      // TODO: If we can get a badge-to-employeeID mapping, re-enable this.
      const quickResult = null; // await quickMpvCheckFromCache(badgeId, currentWorkCode);
      if (quickResult) {
        console.log('[FC Labor Tracking] Quick MPV result from cache:', quickResult.hasMpvRisk ? 'BLOCKED' : 'OK');
        currentMpvCheckResult = quickResult;

        // Show result immediately (no navigation needed!)
        const infoDiv = document.getElementById('fc-lt-associate-info');
        const nameDiv = document.getElementById('fc-lt-associate-name');
        const detailsDiv = document.getElementById('fc-lt-associate-details');

        if (infoDiv) {
          infoDiv.classList.remove('hidden', 'not-found', 'mpv-warning', 'mpv-ok');
          nameDiv.textContent = `Badge: ${badgeId}`;

          if (quickResult.hasMpvRisk) {
            infoDiv.classList.add('mpv-warning');
            let alertText = '🚫 MPV BLOCKED!';
            if (quickResult.reason === 'PATH_SWITCH') alertText = '🚫 MPV - PATH SWITCH!';
            else if (quickResult.reason === 'TIME_EXCEEDED') alertText = '🚫 MPV - TIME EXCEEDED!';

            detailsDiv.textContent = '';
            const alert = document.createElement('div');
            alert.className = 'mpv-alert';
            alert.textContent = alertText;
            detailsDiv.appendChild(alert);
            const details = document.createElement('div');
            details.className = 'mpv-details';
            details.textContent = quickResult.details;
            detailsDiv.appendChild(details);
            const cache = document.createElement('div');
            cache.style.cssText = 'font-size:9px;color:#666;margin-top:4px;';
            cache.textContent = '(from cached data)';
            detailsDiv.appendChild(cache);

            showPanelMessage('🚫 MPV Risk - Cannot assign!', 'error');
          } else if (quickResult.remainingTime) {
            infoDiv.classList.add('mpv-ok');
            detailsDiv.textContent = '';
            const okAlert = document.createElement('div');
            okAlert.className = 'mpv-ok-alert';
            okAlert.textContent = '✓ OK - Same path';
            detailsDiv.appendChild(okAlert);
            const pathSpan = document.createElement('strong');
            pathSpan.textContent = quickResult.targetPath;
            detailsDiv.appendChild(pathSpan);
            detailsDiv.appendChild(document.createElement('br'));
            detailsDiv.appendChild(document.createTextNode(`Used: ${formatMinutes(quickResult.currentTime)} | Remaining: ${formatMinutes(quickResult.remainingTime)}`));

            showPanelMessage(`✓ OK - ${formatMinutes(quickResult.remainingTime)} remaining`, 'success');
          } else {
            infoDiv.classList.add('mpv-ok');
            detailsDiv.textContent = '';
            const okAlert = document.createElement('div');
            okAlert.className = 'mpv-ok-alert';
            okAlert.textContent = '✓ OK - First time on path';
            detailsDiv.appendChild(okAlert);
            const pathSpan = document.createElement('strong');
            pathSpan.textContent = quickResult.targetPath;
            detailsDiv.appendChild(pathSpan);

            showPanelMessage('✓ First time on restricted path', 'success');
          }
        }

        // Quick check complete - no need for slow timeDetails lookup!
        return;
      }

      // SLOW PATH: No cache hit or non-restricted work code
      // Fall back to full timeDetails lookup via FCLM navigation
      console.log('[FC Labor Tracking] No quick result, falling back to full FCLM lookup');

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
    'C-Returns_StowSweep': ['STWSWP', 'STOWSWEEP', 'SWEEP', 'CRESW', 'STOW_SWEEP', 'STOWSW', 'STSW'], // TEST ONLY
    'C-Returns_EndofLine': ['CREOL', 'EOL', 'ENDOFLINE', 'END_OF_LINE', 'ENDLINE'],
    'Vreturns WaterSpider': ['VRWS', 'VRETWS', 'VRWATER'],
    'Water Spider': ['CRSDCNTF'],           // CRET Water Spider
    'WHD Waterspider': ['WHDWTSP'],         // WHD Water Spider
    'WHD Water Spider': ['WHDWTSP'],        // WHD Water Spider (with space)
    'Team_Mech_Wspider': ['TMWSP']          // CRET Support Team Mech Water Spider
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
    }

    // Water Spider matching - check specific types first, then generic
    // WHD Water Spider - matches WHD Waterspider, WHD Grading Support Water Spider
    if (normalizedTitle.includes('whdwaterspider') || normalizedTitle.includes('whdgrading')) {
      return 'WHD Waterspider';
    }
    // CRET Water Spider - matches Decanter Flow, C-Returns Support Water Spider
    if (normalizedTitle.includes('decanterflow') || normalizedTitle.includes('creturnssupport')) {
      return 'Water Spider';
    }
    // Generic water spider fallback
    if (normalizedTitle.includes('waterspider')) {
      return 'Water Spider';
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

    // Helper to safely build details content
    function buildDetailsContent(container, elements) {
      container.textContent = '';
      elements.forEach(el => {
        if (typeof el === 'string') {
          container.appendChild(document.createTextNode(el));
        } else if (el.tag === 'br') {
          container.appendChild(document.createElement('br'));
        } else if (el.tag) {
          const node = document.createElement(el.tag);
          if (el.className) node.className = el.className;
          if (el.text) node.textContent = el.text;
          container.appendChild(node);
        }
      });
    }

    if (mpvCheck.hasMpvRisk) {
      // Show MPV warning - BLOCK this assignment
      infoDiv.classList.add('mpv-warning');

      let alertText = '⚠️ MPV RISK - DO NOT ASSIGN!';
      if (mpvCheck.reason === 'PATH_SWITCH') {
        alertText = '🚫 MPV - PATH SWITCH BLOCKED!';
      } else if (mpvCheck.reason === 'TIME_EXCEEDED') {
        alertText = '🚫 MPV - TIME LIMIT EXCEEDED!';
      }

      const elements = [
        { tag: 'div', className: 'mpv-alert', text: alertText },
        { tag: 'div', className: 'mpv-details', text: mpvCheck.details }
      ];
      if (currentActivity) {
        elements.push({ tag: 'br' }, `Current: ${currentActivity.title}`);
      }
      buildDetailsContent(detailsDiv, elements);
      showPanelMessage('🚫 MPV Risk - Cannot assign!', 'error');

    } else if (mpvCheck.targetPath && mpvCheck.remainingTime) {
      // Same restricted path, under limit - show remaining time
      infoDiv.classList.add('mpv-ok');
      const elements = [
        { tag: 'div', className: 'mpv-ok-alert', text: '✓ OK - Same path, time remaining' },
        { tag: 'strong', text: mpvCheck.targetPath },
        { tag: 'br' },
        `Used: ${formatMinutes(mpvCheck.currentTime)} | Remaining: ${formatMinutes(mpvCheck.remainingTime)}`
      ];
      if (currentActivity) {
        elements.push({ tag: 'br' }, `Current: ${currentActivity.title}`);
      }
      buildDetailsContent(detailsDiv, elements);
      showPanelMessage(`✓ OK - ${formatMinutes(mpvCheck.remainingTime)} remaining`, 'success');

    } else if (mpvCheck.targetPath && mpvCheck.workedPaths.length === 0) {
      // First time on restricted path
      infoDiv.classList.add('mpv-ok');
      const elements = [
        { tag: 'div', className: 'mpv-ok-alert', text: '✓ OK - First time on this path' },
        { tag: 'strong', text: mpvCheck.targetPath },
        { tag: 'br' },
        `Max allowed: ${formatMinutes(MPV_MAX_TIME_MINUTES)}`
      ];
      if (currentActivity) {
        elements.push({ tag: 'br' }, `Current: ${currentActivity.title}`);
      }
      buildDetailsContent(detailsDiv, elements);
      showPanelMessage('✓ First time on restricted path', 'success');

    } else if (currentActivity) {
      // Non-restricted path with current activity
      const statusClass = isClockedIn ? 'uph' : 'uph low';
      buildDetailsContent(detailsDiv, [
        { tag: 'strong', text: currentActivity.title },
        { tag: 'br' },
        { tag: 'span', className: statusClass, text: isClockedIn ? 'Active' : 'Inactive' },
        ` | Duration: ${currentActivity.duration || 'ongoing'}`
      ]);
      showPanelMessage('✓ Ready to assign', 'success');

    } else if (data.sessions.length > 0) {
      // Non-restricted path, show last session
      const lastSession = data.sessions[data.sessions.length - 1];
      const hoursText = data.hoursOnTask ? `Hours: ${data.hoursOnTask.toFixed(1)}h` : `Sessions: ${data.sessions.length}`;
      buildDetailsContent(detailsDiv, [
        'Last: ',
        { tag: 'strong', text: lastSession.title },
        { tag: 'br' },
        hoursText
      ]);
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

  // Periodic status update - check every 15 seconds for faster reconnection
  setInterval(updateFclmStatus, 15000);

  // Make status indicator clickable to manually check connection
  setTimeout(() => {
    const statusEl = document.getElementById('fc-lt-fclm-status');
    if (statusEl) {
      statusEl.style.cursor = 'pointer';
      statusEl.addEventListener('click', () => {
        statusEl.textContent = 'Checking...';
        updateFclmStatus();
      });
    }
  }, 1500);

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
