// FC Labor Tracking Assistant - Kiosk Content Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Content script loaded on kiosk page');

  // Determine which page we're on based on URL
  const isWorkCodePage = window.location.pathname.includes('/laborTrackingKiosk') &&
                          !window.location.pathname.startsWith('/do/');
  const isBadgePage = window.location.pathname.startsWith('/do/laborTrackingKiosk');

  console.log('[FC Labor Tracking] Page type:', isWorkCodePage ? 'Work Code' : (isBadgePage ? 'Badge ID' : 'Unknown'));

  // Listen for messages from the popup
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FC Labor Tracking] Received message:', message);

    if (message.action === 'inputWorkCode') {
      handleWorkCodeInput(message.workCode)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response
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

  async function handleWorkCodeInput(workCode) {
    console.log('[FC Labor Tracking] Attempting to input work code:', workCode);

    // Find the work code input field
    // Based on the screenshot, look for input with placeholder or label related to "Indirect Work code"
    const inputSelectors = [
      'input[placeholder*="Work code" i]',
      'input[placeholder*="Indirect" i]',
      'input[name*="workCode" i]',
      'input[name*="work_code" i]',
      'input[id*="workCode" i]',
      'input[id*="work-code" i]',
      'input[type="text"]'  // Fallback to any text input
    ];

    let inputField = null;

    for (const selector of inputSelectors) {
      const inputs = document.querySelectorAll(selector);
      if (inputs.length > 0) {
        // If we have multiple inputs, try to find the one that's visible and looks right
        for (const input of inputs) {
          if (isElementVisible(input)) {
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

    // Clear existing value and set new one
    inputField.focus();
    inputField.value = '';

    // Simulate typing for better compatibility with React/Vue apps
    await simulateTyping(inputField, workCode);

    // Trigger form submission or press Enter
    await simulateEnterKey(inputField);

    return { success: true };
  }

  async function handleBadgeIdInput(badgeId) {
    console.log('[FC Labor Tracking] Attempting to input badge ID:', badgeId);

    // Find the badge ID input field
    const inputSelectors = [
      'input[placeholder*="badge" i]',
      'input[placeholder*="scan" i]',
      'input[name*="badge" i]',
      'input[id*="badge" i]',
      'input[type="text"]'  // Fallback
    ];

    let inputField = null;

    for (const selector of inputSelectors) {
      const inputs = document.querySelectorAll(selector);
      if (inputs.length > 0) {
        for (const input of inputs) {
          if (isElementVisible(input)) {
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

    // Clear and set value
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
    // Focus the element
    element.focus();

    // For React/Vue apps, we need to dispatch input events
    for (const char of text) {
      element.value += char;

      // Dispatch input event
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));

      // Small delay to simulate real typing
      await sleep(10);
    }

    // Final change event
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function simulateEnterKey(element) {
    // Small delay before pressing enter
    await sleep(100);

    // Create and dispatch keydown event for Enter
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });

    element.dispatchEvent(enterEvent);

    // Also dispatch keyup
    const keyUpEvent = new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true
    });

    element.dispatchEvent(keyUpEvent);

    // Try to find and click a submit button if Enter doesn't work
    await sleep(200);

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:contains("Submit")',
      'button:contains("Done")',
      'button.submit',
      'button.primary'
    ];

    // If the page hasn't navigated, try clicking submit
    for (const selector of submitSelectors) {
      try {
        const btn = document.querySelector(selector);
        if (btn && isElementVisible(btn)) {
          console.log('[FC Labor Tracking] Clicking submit button');
          btn.click();
          break;
        }
      } catch (e) {
        // Selector might be invalid, continue
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Notify background script that content script is ready
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: isWorkCodePage ? 'workCode' : (isBadgePage ? 'badge' : 'unknown'),
    url: window.location.href
  }).catch(err => {
    // Background script might not be listening yet
    console.log('[FC Labor Tracking] Could not notify background script:', err);
  });

})();
