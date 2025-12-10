// FC Labor Tracking Assistant - Background Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Background script loaded');

  // Track connected tabs
  const connectedTabs = {
    kiosk: null,
    fclmTabs: []  // Track multiple FCLM tabs
  };

  // Get the best available FCLM tab
  function getAvailableFclmTab() {
    // Filter out closed tabs
    connectedTabs.fclmTabs = connectedTabs.fclmTabs.filter(tab => tab && tab.tabId);
    return connectedTabs.fclmTabs[0] || null;
  }

  // Store current work code being assigned (persists across page navigation)
  let currentWorkCode = null;

  // Listen for messages from content scripts
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FC Labor Tracking] Background received message:', message.action, 'from tab:', sender.tab?.id);

    if (message.action === 'contentScriptReady') {
      handleContentScriptReady(message, sender);
      sendResponse({ received: true });
      return false;
    }

    if (message.action === 'getConnectedTabs') {
      sendResponse({
        kiosk: connectedTabs.kiosk,
        fclm: getAvailableFclmTab(),
        fclmTabCount: connectedTabs.fclmTabs.length
      });
      return false;
    }

    // Store current work code when submitted
    if (message.action === 'setCurrentWorkCode') {
      currentWorkCode = message.workCode;
      console.log('[FC Labor Tracking] Work code stored:', currentWorkCode);
      sendResponse({ success: true });
      return false;
    }

    // Get current work code for MPV check
    if (message.action === 'getCurrentWorkCode') {
      sendResponse({ workCode: currentWorkCode });
      return false;
    }

    // Clear work code (after Done is clicked)
    if (message.action === 'clearCurrentWorkCode') {
      currentWorkCode = null;
      console.log('[FC Labor Tracking] Work code cleared');
      sendResponse({ success: true });
      return false;
    }

    // Fetch employee time details via FCLM tab
    if (message.action === 'fetchEmployeeTimeDetails') {
      const fclmTab = getAvailableFclmTab();
      if (fclmTab) {
        browser.tabs.sendMessage(fclmTab.tabId, {
          action: 'fetchEmployeeTimeDetails',
          employeeId: message.employeeId
        })
          .then(response => sendResponse(response))
          .catch(error => {
            // Remove this tab from the list and try again
            connectedTabs.fclmTabs = connectedTabs.fclmTabs.filter(t => t.tabId !== fclmTab.tabId);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Async response
      } else {
        sendResponse({ success: false, error: 'FCLM tab not connected. Please open fclm-portal.amazon.com' });
        return false;
      }
    }

    // Check if FCLM is connected
    if (message.action === 'checkFclmConnection') {
      const fclmTab = getAvailableFclmTab();
      if (fclmTab) {
        // Ping FCLM to make sure it's still responsive
        browser.tabs.sendMessage(fclmTab.tabId, { action: 'ping' })
          .then(response => {
            sendResponse({ connected: true, ready: response.ready, tabCount: connectedTabs.fclmTabs.length });
          })
          .catch(() => {
            // Remove unresponsive tab
            connectedTabs.fclmTabs = connectedTabs.fclmTabs.filter(t => t.tabId !== fclmTab.tabId);
            sendResponse({ connected: getAvailableFclmTab() !== null, tabCount: connectedTabs.fclmTabs.length });
          });
        return true;
      } else {
        sendResponse({ connected: false, tabCount: 0 });
        return false;
      }
    }

    // Forward messages between tabs
    if (message.action === 'forwardToKiosk') {
      if (connectedTabs.kiosk) {
        browser.tabs.sendMessage(connectedTabs.kiosk.tabId, message.payload)
          .then(response => sendResponse(response))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
      } else {
        sendResponse({ success: false, error: 'No kiosk tab connected' });
        return false;
      }
    }

    if (message.action === 'forwardToFclm') {
      const fclmTab = getAvailableFclmTab();
      if (fclmTab) {
        browser.tabs.sendMessage(fclmTab.tabId, message.payload)
          .then(response => sendResponse(response))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
      } else {
        sendResponse({ success: false, error: 'No FCLM tab connected' });
        return false;
      }
    }

    // Fetch AAs on restricted paths from FCLM
    if (message.action === 'fetchPathAAs') {
      const fclmTab = getAvailableFclmTab();
      if (fclmTab) {
        browser.tabs.sendMessage(fclmTab.tabId, {
          action: 'fetchPathAAs',
          paths: message.paths
        })
          .then(response => sendResponse(response))
          .catch(error => {
            connectedTabs.fclmTabs = connectedTabs.fclmTabs.filter(t => t.tabId !== fclmTab.tabId);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Async response
      } else {
        sendResponse({ success: false, error: 'FCLM tab not connected. Please open fclm-portal.amazon.com' });
        return false;
      }
    }
  });

  function handleContentScriptReady(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    if (message.pageType === 'workCode' || message.pageType === 'badge') {
      connectedTabs.kiosk = {
        tabId,
        pageType: message.pageType,
        url: message.url,
        warehouseId: message.warehouseId
      };
      console.log('[FC Labor Tracking] Kiosk tab registered:', connectedTabs.kiosk);
    } else if (message.pageType === 'fclm') {
      // Add to FCLM tabs array if not already present
      const existingIdx = connectedTabs.fclmTabs.findIndex(t => t.tabId === tabId);
      const fclmTabInfo = {
        tabId,
        url: message.url,
        warehouseId: message.warehouseId
      };

      if (existingIdx >= 0) {
        connectedTabs.fclmTabs[existingIdx] = fclmTabInfo;
      } else {
        connectedTabs.fclmTabs.push(fclmTabInfo);
      }
      console.log('[FC Labor Tracking] FCLM tab registered:', fclmTabInfo, `(${connectedTabs.fclmTabs.length} total)`);

      // Notify kiosk that FCLM is now connected
      if (connectedTabs.kiosk) {
        browser.tabs.sendMessage(connectedTabs.kiosk.tabId, {
          action: 'fclmConnected'
        }).catch(err => {
          console.log('[FC Labor Tracking] Could not notify kiosk:', err);
        });
      }
    }

    updateBadge();
  }

  // Handle tab closure
  browser.tabs.onRemoved.addListener((tabId) => {
    if (connectedTabs.kiosk?.tabId === tabId) {
      connectedTabs.kiosk = null;
      console.log('[FC Labor Tracking] Kiosk tab closed');
    }

    // Remove from FCLM tabs array
    const fclmIdx = connectedTabs.fclmTabs.findIndex(t => t.tabId === tabId);
    if (fclmIdx >= 0) {
      connectedTabs.fclmTabs.splice(fclmIdx, 1);
      console.log('[FC Labor Tracking] FCLM tab closed. Remaining:', connectedTabs.fclmTabs.length);

      // Notify kiosk if no more FCLM tabs
      if (connectedTabs.fclmTabs.length === 0 && connectedTabs.kiosk) {
        browser.tabs.sendMessage(connectedTabs.kiosk.tabId, {
          action: 'fclmDisconnected'
        }).catch(() => {});
      }
    }
    updateBadge();
  });

  // Handle tab URL changes
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      if (connectedTabs.kiosk?.tabId === tabId) {
        if (!changeInfo.url.includes('fcmenu-iad-regionalized.corp.amazon.com')) {
          connectedTabs.kiosk = null;
          console.log('[FC Labor Tracking] Kiosk tab navigated away');
        }
      }

      // Check FCLM tabs
      const fclmIdx = connectedTabs.fclmTabs.findIndex(t => t.tabId === tabId);
      if (fclmIdx >= 0 && !changeInfo.url.includes('fclm-portal.amazon.com')) {
        connectedTabs.fclmTabs.splice(fclmIdx, 1);
        console.log('[FC Labor Tracking] FCLM tab navigated away. Remaining:', connectedTabs.fclmTabs.length);

        // Notify kiosk if no more FCLM tabs
        if (connectedTabs.fclmTabs.length === 0 && connectedTabs.kiosk) {
          browser.tabs.sendMessage(connectedTabs.kiosk.tabId, {
            action: 'fclmDisconnected'
          }).catch(() => {});
        }
      }
      updateBadge();
    }
  });

  function updateBadge() {
    const hasKiosk = connectedTabs.kiosk !== null;
    const hasFclm = connectedTabs.fclmTabs.length > 0;

    if (hasKiosk && hasFclm) {
      // Both connected - show number of FCLM tabs
      browser.browserAction.setBadgeText({ text: '✓' });
      browser.browserAction.setBadgeBackgroundColor({ color: '#2ecc71' });
    } else if (hasKiosk || hasFclm) {
      // Partially connected
      browser.browserAction.setBadgeText({ text: '!' });
      browser.browserAction.setBadgeBackgroundColor({ color: '#f39c12' });
    } else {
      browser.browserAction.setBadgeText({ text: '' });
    }
  }

  // Initialize badge
  updateBadge();

})();
