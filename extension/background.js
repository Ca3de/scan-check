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
    console.log('[FC Labor Tracking] Background received message:', message, 'from tab:', sender.tab?.id);

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
        url: message.url
      };
      console.log('[FC Labor Tracking] Kiosk tab registered:', connectedTabs.kiosk);
    } else if (message.pageType === 'fclm') {
      connectedTabs.fclm = {
        tabId,
        url: message.url,
        warehouseId: message.warehouseId
      };
      console.log('[FC Labor Tracking] FCLM tab registered:', connectedTabs.fclm);
    }

    // Update badge to show connected status
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
    }
    updateBadge();
  });

  // Handle tab URL changes
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      // Re-check if this is still a relevant page
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
        }
      }
      updateBadge();
    }
  });

  function updateBadge() {
    const isConnected = connectedTabs.kiosk !== null;

    if (isConnected) {
      browser.browserAction.setBadgeText({ text: '✓' });
      browser.browserAction.setBadgeBackgroundColor({ color: '#2ecc71' });
    } else {
      browser.browserAction.setBadgeText({ text: '' });
    }
  }

  // Initialize badge
  updateBadge();

})();
