// FC Labor Tracking Assistant - FCLM Portal Content Script

(function() {
  'use strict';

  console.log('[FC Labor Tracking] Content script loaded on FCLM portal');

  // This script runs on fclm-portal.amazon.com
  // Future functionality: communicate with FCLM to get associate data

  // Listen for messages from the popup or background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[FC Labor Tracking] FCLM received message:', message);

    if (message.action === 'getFclmData') {
      // Placeholder for future FCLM data extraction
      sendResponse({
        success: true,
        data: {
          // This will be populated in future versions
          warehouseId: getWarehouseId()
        }
      });
      return false;
    }

    if (message.action === 'lookupAssociate') {
      // Placeholder for future associate lookup functionality
      lookupAssociate(message.badgeId)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }
  });

  function getWarehouseId() {
    // Try to extract warehouse ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('warehouseId') || null;
  }

  async function lookupAssociate(badgeId) {
    // Placeholder - will be implemented later
    console.log('[FC Labor Tracking] Associate lookup requested for:', badgeId);
    return {
      success: true,
      message: 'Associate lookup not yet implemented',
      badgeId: badgeId
    };
  }

  // Notify background script that FCLM content script is ready
  browser.runtime.sendMessage({
    action: 'contentScriptReady',
    pageType: 'fclm',
    url: window.location.href,
    warehouseId: getWarehouseId()
  }).catch(err => {
    console.log('[FC Labor Tracking] Could not notify background script:', err);
  });

})();
