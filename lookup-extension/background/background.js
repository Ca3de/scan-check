// Background service worker.
//
// 1. Opens the side panel / sidebar on toolbar click.
// 2. Handles {action: 'fclmFetch', url} messages from the sidebar by running
//    the fetch inside an FCLM tab via chrome.scripting.executeScript. Doing
//    the fetch in-page avoids the cross-origin CORS rejection Firefox
//    issues against credentialed extension-page fetches.

const api = typeof browser !== 'undefined' ? browser : chrome;

const FCLM_HOST = 'fclm-portal.amazon.com';
const FCLM_HOME = `https://${FCLM_HOST}/`;

if (api.sidePanel?.setPanelBehavior) {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

api.action?.onClicked?.addListener((tab) => {
  // sidebarAction.open() / sidePanel.open() must be called synchronously
  // from inside the user-gesture listener — no awaits before the call.
  if (api.sidebarAction?.open) {
    api.sidebarAction.open().catch(() => {});
  } else if (api.sidePanel?.open && tab?.id) {
    api.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for FCLM tab to load'));
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    api.tabs.onUpdated.addListener(listener);
    // In case the tab is already complete by the time we attached.
    api.tabs.get(tabId).then(t => {
      if (t && t.status === 'complete') {
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function findOrCreateFclmTab() {
  const tabs = await api.tabs.query({ url: `*://${FCLM_HOST}/*` });
  // Prefer a tab that has finished loading.
  const ready = tabs.find(t => t.status === 'complete');
  if (ready) return ready;
  if (tabs.length) {
    await waitForTabComplete(tabs[0].id);
    return tabs[0];
  }
  const created = await api.tabs.create({ url: FCLM_HOME, active: false });
  await waitForTabComplete(created.id);
  return created;
}

async function fetchInTab(url) {
  const tab = await findOrCreateFclmTab();
  const results = await api.scripting.executeScript({
    target: { tabId: tab.id },
    args: [url],
    func: async (fetchUrl) => {
      try {
        const r = await fetch(fetchUrl, { credentials: 'include' });
        const html = await r.text();
        return { ok: r.ok, status: r.status, finalUrl: r.url, html };
      } catch (e) {
        return { ok: false, status: 0, error: String(e && e.message || e) };
      }
    }
  });
  // executeScript returns one result per frame; the main frame is first.
  const main = Array.isArray(results) ? results[0] : results;
  return main?.result || { ok: false, status: 0, error: 'No script result' };
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'fclmFetch') {
    fetchInTab(message.url)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, status: 0, error: err.message }));
    return true; // keep channel open for async sendResponse
  }
});
