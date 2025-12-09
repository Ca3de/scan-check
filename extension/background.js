// FC Labor Tracking Assistant - Background Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Background script loaded');

  // Track connected tabs
  const connectedTabs = {
    kiosk: null,
    fclm: null
  };

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
        fclm: connectedTabs.fclm
      });
      return false;
    }

    // Fetch employee time details via FCLM tab
    if (message.action === 'fetchEmployeeTimeDetails') {
      if (connectedTabs.fclm) {
        browser.tabs.sendMessage(connectedTabs.fclm.tabId, {
          action: 'fetchEmployeeTimeDetails',
          employeeId: message.employeeId
        })
          .then(response => sendResponse(response))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Async response
      } else {
        sendResponse({ success: false, error: 'FCLM tab not connected. Please open fclm-portal.amazon.com' });
        return false;
      }
    }

    // Check if FCLM is connected
    if (message.action === 'checkFclmConnection') {
      if (connectedTabs.fclm) {
        // Ping FCLM to make sure it's still responsive
        browser.tabs.sendMessage(connectedTabs.fclm.tabId, { action: 'ping' })
          .then(response => {
            sendResponse({ connected: true, ready: response.ready });
          })
          .catch(() => {
            connectedTabs.fclm = null;
            sendResponse({ connected: false });
          });
        return true;
      } else {
        sendResponse({ connected: false });
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
      if (connectedTabs.fclm) {
        browser.tabs.sendMessage(connectedTabs.fclm.tabId, message.payload)
          .then(response => sendResponse(response))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
      } else {
        sendResponse({ success: false, error: 'No FCLM tab connected' });
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
      connectedTabs.fclm = {
        tabId,
        url: message.url,
        warehouseId: message.warehouseId
      };
      console.log('[FC Labor Tracking] FCLM tab registered:', connectedTabs.fclm);

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
    if (connectedTabs.fclm?.tabId === tabId) {
      connectedTabs.fclm = null;
      console.log('[FC Labor Tracking] FCLM tab closed');

      // Notify kiosk that FCLM is disconnected
      if (connectedTabs.kiosk) {
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
      if (connectedTabs.fclm?.tabId === tabId) {
        if (!changeInfo.url.includes('fclm-portal.amazon.com')) {
          connectedTabs.fclm = null;
          console.log('[FC Labor Tracking] FCLM tab navigated away');

          // Notify kiosk
          if (connectedTabs.kiosk) {
            browser.tabs.sendMessage(connectedTabs.kiosk.tabId, {
              action: 'fclmDisconnected'
            }).catch(() => {});
          }
        }
      }
      updateBadge();
    }
  });

  function updateBadge() {
    const hasKiosk = connectedTabs.kiosk !== null;
    const hasFclm = connectedTabs.fclm !== null;

    if (hasKiosk && hasFclm) {
      // Both connected
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
