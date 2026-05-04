// Background service worker (Chrome MV3) / event page (Firefox MV3).
// Routes lookup requests from the sidebar to an FCLM tab. If no FCLM tab
// exists, creates a hidden one. Maintains an in-memory cache and a
// rate-limited queue so batches don't hammer the portal.

const api = typeof browser !== 'undefined' ? browser : chrome;

const FCLM_ORIGIN = 'https://fclm-portal.amazon.com';
const FCLM_HOME = `${FCLM_ORIGIN}/`;
const REQUEST_DELAY_MS = 400; // throttle between batch lookups
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 1000;

// idValue -> { result, ts }
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key, result) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { result, ts: Date.now() });
}

async function findFclmTab() {
  const tabs = await api.tabs.query({ url: `${FCLM_ORIGIN}/*` });
  return tabs[0] || null;
}

async function ensureFclmTab() {
  let tab = await findFclmTab();
  if (tab) return tab;
  // Create a tab in the background. The content script auto-injects on load.
  tab = await api.tabs.create({ url: FCLM_HOME, active: false });
  // Wait for the tab to finish loading so the content script is ready.
  await new Promise((resolve) => {
    function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        api.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    api.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      const cb = (response) => {
        const err = api.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      };
      const ret = api.tabs.sendMessage(tabId, message, cb);
      if (ret && typeof ret.then === 'function') {
        ret.then(resolve, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function performLookup(idValue, warehouseId, useCache = true) {
  const cacheKey = `${warehouseId || 'IND8'}::${idValue}`;
  if (useCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const tab = await ensureFclmTab();
  let response;
  try {
    response = await sendMessageToTab(tab.id, {
      action: 'aaLookup',
      idValue,
      warehouseId
    });
  } catch (err) {
    return { ok: false, error: `Could not reach FCLM tab: ${err.message}`, input: idValue };
  }

  if (response?.ok) cacheSet(cacheKey, response);
  return response || { ok: false, error: 'No response from FCLM tab', input: idValue };
}

// ============== Batch queue ==============
// Sidebar streams progress via runtime.connect port.

const batches = new Map(); // batchId -> { cancel: bool }

async function runBatch(port, batchId, items, warehouseId) {
  batches.set(batchId, { cancel: false });
  let done = 0;
  for (const item of items) {
    if (batches.get(batchId)?.cancel) {
      try { port.postMessage({ type: 'batchCancelled', batchId }); } catch (_) {}
      batches.delete(batchId);
      return;
    }
    const result = await performLookup(item.value, warehouseId, true);
    done += 1;
    try {
      port.postMessage({
        type: 'batchProgress',
        batchId,
        done,
        total: items.length,
        rowIndex: item.rowIndex,
        input: item.value,
        result
      });
    } catch (_) {
      // Port disconnected — abort.
      batches.delete(batchId);
      return;
    }
    if (done < items.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }
  try { port.postMessage({ type: 'batchDone', batchId }); } catch (_) {}
  batches.delete(batchId);
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aaLookup') return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'startBatch') {
      runBatch(port, msg.batchId, msg.items, msg.warehouseId);
    } else if (msg?.type === 'cancelBatch') {
      const b = batches.get(msg.batchId);
      if (b) b.cancel = true;
    }
  });
  port.onDisconnect.addListener(() => {
    // Cancel any batches associated with this port.
    for (const [id, b] of batches) b.cancel = true;
  });
});

// ============== Single lookup over runtime.sendMessage ==============

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'singleLookup') {
    performLookup(message.idValue, message.warehouseId, message.useCache !== false)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message, input: message.idValue }));
    return true;
  }
  if (message?.action === 'clearCache') {
    cache.clear();
    sendResponse({ ok: true });
    return false;
  }
});

// ============== Action click: open side panel / sidebar ==============

if (api.sidePanel?.setPanelBehavior) {
  // Chrome: clicking the toolbar icon opens the side panel.
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

api.action?.onClicked?.addListener(async (tab) => {
  // Firefox: open the sidebar. Chrome already handled by sidePanel behavior.
  if (api.sidebarAction?.open) {
    try { await api.sidebarAction.open(); } catch (_) {}
  } else if (api.sidePanel?.open) {
    try { await api.sidePanel.open({ tabId: tab.id }); } catch (_) {}
  }
});
