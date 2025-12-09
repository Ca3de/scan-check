// FC Labor Tracking Assistant - Background Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Background script loaded');

  // Track connected tabs
  const connectedTabs = {
    kiosk: null,
    fclm: null
  };

  // Store FCLM data for cross-tab access
  let fclmData = {
    associates: new Map(), // employee_id -> associate data
    allRecords: [],        // Full list of records
    shiftDate: null,
    lastUpdate: null
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

    // FCLM data management
    if (message.action === 'updateFclmData') {
      handleFclmDataUpdate(message);
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'getFclmData') {
      sendResponse({
        success: true,
        data: fclmData.allRecords,
        shiftDate: fclmData.shiftDate,
        lastUpdate: fclmData.lastUpdate,
        count: fclmData.associates.size
      });
      return false;
    }

    if (message.action === 'lookupAssociate') {
      const badgeId = message.badgeId;
      const associate = fclmData.associates.get(badgeId);
      console.log('[FC Labor Tracking] Lookup for badge:', badgeId, 'Found:', !!associate);
      sendResponse({
        success: true,
        found: !!associate,
        associate: associate || null,
        dataAge: fclmData.lastUpdate ? Date.now() - new Date(fclmData.lastUpdate).getTime() : null
      });
      return false;
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

    // Trigger FCLM poll from kiosk
    if (message.action === 'triggerFclmPoll') {
      if (connectedTabs.fclm) {
        browser.tabs.sendMessage(connectedTabs.fclm.tabId, { action: 'triggerPoll' })
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
    }

    updateBadge();
  }

  function handleFclmDataUpdate(message) {
    console.log('[FC Labor Tracking] Updating FCLM data:', message.data?.length, 'records');

    fclmData.allRecords = message.data || [];
    fclmData.shiftDate = message.shiftDate;
    fclmData.lastUpdate = message.timestamp;

    // Index by employee_id for quick lookup
    fclmData.associates.clear();
    for (const record of fclmData.allRecords) {
      const existing = fclmData.associates.get(record.employee_id);
      // Keep the one with more hours (primary function)
      if (!existing || record.paid_hours_total > existing.paid_hours_total) {
        fclmData.associates.set(record.employee_id, record);
      }
    }

    console.log('[FC Labor Tracking] Indexed', fclmData.associates.size, 'unique associates');

    // Update badge to show data is available
    updateBadge();

    // Notify kiosk tab that new data is available
    if (connectedTabs.kiosk) {
      browser.tabs.sendMessage(connectedTabs.kiosk.tabId, {
        action: 'fclmDataUpdated',
        count: fclmData.associates.size,
        shiftDate: fclmData.shiftDate
      }).catch(err => {
        console.log('[FC Labor Tracking] Could not notify kiosk of data update:', err);
      });
    }
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
    const hasKiosk = connectedTabs.kiosk !== null;
    const hasFclm = connectedTabs.fclm !== null;
    const hasData = fclmData.associates.size > 0;

    if (hasKiosk && hasFclm && hasData) {
      // Both connected with data
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
