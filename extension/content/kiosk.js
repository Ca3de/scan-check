// FC Labor Tracking Assistant - Kiosk Content Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Content script loaded on kiosk page');

  // Determine which page we're on based on URL
  const isWorkCodePage = window.location.pathname.includes('/laborTrackingKiosk') &&
                          !window.location.pathname.startsWith('/do/');
  const isBadgePage = window.location.pathname.startsWith('/do/laborTrackingKiosk');

  console.log('[FC Labor Tracking] Page type:', isWorkCodePage ? 'Work Code' : (isBadgePage ? 'Badge ID' : 'Unknown'));

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
          <button id="fc-lt-submit-badge" class="fc-lt-btn primary">Submit</button>
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

    // Badge submission
    submitBadgeBtn.addEventListener('click', () => submitBadge());
    badgeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitBadge();
    });

    // Back button
    backBtn.addEventListener('click', () => {
      document.getElementById('fc-lt-badge-section').classList.add('hidden');
      document.getElementById('fc-lt-workcode-section').classList.remove('hidden');
      workCodeInput.focus();
    });
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

      // Switch to badge mode after a short delay
      setTimeout(() => {
        document.getElementById('fc-lt-workcode-section').classList.add('hidden');
        document.getElementById('fc-lt-badge-section').classList.remove('hidden');
        document.getElementById('fc-lt-badge').focus();
        showPanelMessage('Enter badge ID', 'info');
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
      showPanelMessage('Badge submitted!', 'success');
      input.value = '';

      // Ready for next badge
      setTimeout(() => {
        showPanelMessage('Ready for next badge', 'info');
        input.focus();
      }, 1000);
    } catch (error) {
      showPanelMessage('Error: ' + error.message, 'error');
    }
  }

  function showPanelMessage(text, type) {
    const msg = document.getElementById('fc-lt-message');
    msg.textContent = text;
    msg.className = 'fc-lt-message ' + type;
  }

  async function handleWorkCodeInput(workCode) {
    console.log('[FC Labor Tracking] Attempting to input work code:', workCode);

    const inputSelectors = [
      'input[placeholder*="Work code" i]',
      'input[placeholder*="Indirect" i]',
      'input[name*="workCode" i]',
      'input[name*="work_code" i]',
      'input[id*="workCode" i]',
      'input[id*="work-code" i]',
      'input[type="text"]:not([id^="fc-lt"])'
    ];

    let inputField = null;

    for (const selector of inputSelectors) {
      const inputs = document.querySelectorAll(selector);
      if (inputs.length > 0) {
        for (const input of inputs) {
          if (isElementVisible(input) && !input.id.startsWith('fc-lt')) {
            inputField = input;
            console.log('[FC Labor Tracking] Found input with selector:', selector);
            break;
          }
        }
        if (inputField) break;
      }
    }

    if (!inputField) {
      throw new Error('Could not find work code input field');
    }

    inputField.focus();
    inputField.value = '';
    await simulateTyping(inputField, workCode);
    await simulateEnterKey(inputField);

    return { success: true };
  }

  async function handleBadgeIdInput(badgeId) {
    console.log('[FC Labor Tracking] Attempting to input badge ID:', badgeId);

    const inputSelectors = [
      'input[placeholder*="badge" i]',
      'input[placeholder*="scan" i]',
      'input[name*="badge" i]',
      'input[id*="badge" i]',
      'input[type="text"]:not([id^="fc-lt"])'
    ];

    let inputField = null;

    for (const selector of inputSelectors) {
      const inputs = document.querySelectorAll(selector);
      if (inputs.length > 0) {
        for (const input of inputs) {
          if (isElementVisible(input) && !input.id.startsWith('fc-lt')) {
            inputField = input;
            console.log('[FC Labor Tracking] Found badge input with selector:', selector);
            break;
          }
        }
        if (inputField) break;
      }
    }

    if (!inputField) {
      throw new Error('Could not find badge ID input field');
    }

    inputField.focus();
    inputField.value = '';
    await simulateTyping(inputField, badgeId);
    await simulateEnterKey(inputField);

    return { success: true };
  }

  function isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function simulateTyping(element, text) {
    element.focus();
    for (const char of text) {
      element.value += char;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(10);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function simulateEnterKey(element) {
    await sleep(100);

    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(enterEvent);

    const keyUpEvent = new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true
    });
    element.dispatchEvent(keyUpEvent);

    await sleep(200);

    // Try clicking submit button if Enter doesn't work
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.submit',
      'button.primary'
    ];

    for (const selector of submitSelectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn && isElementVisible(btn) && !btn.id.startsWith('fc-lt')) {
          console.log('[FC Labor Tracking] Clicking submit button');
          btn.click();
          break;
        }
      } catch (e) {}
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Notify background script
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: isWorkCodePage ? 'workCode' : (isBadgePage ? 'badge' : 'unknown'),
    url: window.location.href
  }).catch(err => {
    console.log('[FC Labor Tracking] Could not notify background script:', err);
  });

})();
