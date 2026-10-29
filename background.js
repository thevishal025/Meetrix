/**
 * Meetrix - Background Service Worker (Manifest V3) v1.1
 *
 * Manages icon badge updates, downloads, content script injection,
 * caption event forwarding from content script to popup, and tab events.
 */

// Handle extension installation or update
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Meetrix] Extension installed/updated:', details.reason);
  chrome.action.setBadgeBackgroundColor({ color: '#0284c7' });
});

// Remove credentials left by older builds; AI credentials now belong only to the local proxy process.
chrome.storage.local.remove('meetrix_nvidia_api_key');

/**
 * Checks if the content script is alive on a given tab via a PING.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isContentScriptReady(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'MEETRIX_PING' }, (response) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!(response && response.pong));
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * Attempts to inject all content scripts into a tab if they aren't already loaded.
 * @param {number} tabId
 * @returns {Promise<boolean>} Whether injection succeeded
 */
async function ensureContentScriptInjected(tabId) {
  const ready = await isContentScriptReady(tabId);
  if (ready) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: [
        'storage.js',
        'device-detector.js',
        'camera-detector.js',
        'presentation-detector.js',
        'participant-detector.js',
        'attendance.js',
        'report-generator.js',
        'caption-manager.js',
        'content.js'
      ]
    });

    await new Promise(r => setTimeout(r, 500));
    return await isContentScriptReady(tabId);
  } catch (err) {
    console.warn('[Meetrix] Failed to inject content scripts:', err.message);
    return false;
  }
}

// Registered popup ports for caption streaming
const popupPorts = new Set();

// Listen for long-lived connections from popup (for caption streaming)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'meetrix-popup') {
    popupPorts.add(port);
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  }
});

/**
 * Forwards a caption event to all connected popup ports.
 * @param {Object} event
 */
function broadcastToPopup(event) {
  for (const port of popupPorts) {
    try { port.postMessage(event); } catch (e) { popupPorts.delete(port); }
  }
}

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'MEETRIX_STATE_UPDATED') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      updateTabBadge(tabId, message.presentCount, message.isPresenting);
    }
    sendResponse({ received: true });
    return true;
  }

  // Caption events from content script — forward to popup via port
  if (message.type === 'MEETRIX_CAPTION_EVENT') {
    broadcastToPopup({ type: 'MEETRIX_CAPTION_EVENT', event: message.event });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === 'MEETRIX_TRIGGER_DOWNLOAD') {
    if (chrome.downloads && message.url && message.filename) {
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
      return true;
    }
  }

  if (message.type === 'MEETRIX_SAVE_HTML_REPORT') {
    if (!chrome.downloads || !message.html || !message.filename) {
      sendResponse({ success: false, error: 'Downloads are unavailable or report data is missing.' });
      return true;
    }
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(message.html);
    chrome.downloads.download({ url, filename: message.filename, saveAs: false, conflictAction: 'uniquify' }, (downloadId) => {
      if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
      else sendResponse({ success: true, downloadId });
    });
    return true;
  }

  if (message.type === 'MEETRIX_ENSURE_CONTENT_SCRIPT') {
    const tabId = message.tabId;
    if (!tabId) {
      sendResponse({ ready: false, error: 'No tabId provided' });
      return true;
    }
    ensureContentScriptInjected(tabId).then((ready) => {
      sendResponse({ ready });
    }).catch((err) => {
      sendResponse({ ready: false, error: err.message });
    });
    return true;
  }

  if (message.type === 'MEETRIX_SET_TRACKING_STATE') {
    chrome.storage.local.set({ 'meetrix_tracking_active': message.isTracking }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }

  if (message.type === 'MEETRIX_GET_TRACKING_STATE') {
    chrome.storage.local.get('meetrix_tracking_active', (data) => {
      if (chrome.runtime.lastError) {
        sendResponse({ isTracking: false });
      } else {
        const isTracking = data['meetrix_tracking_active'] === true;
        sendResponse({ isTracking });
      }
    });
    return true;
  }

  if (message.type === 'MEETRIX_GET_AI_PROXY_STATUS') {
    fetchAiProxy('/health', { method: 'GET' }).then(sendResponse);
    return true;
  }

  if (message.type === 'MEETRIX_GENERATE_SUMMARY') {
    generateNvidiaMeetingInsights(message.transcript || '').then(sendResponse);
    return true;
  }
});

// ------------------------------------------------------------------
// Local AI proxy helpers. The NVIDIA key is never stored in extension files or storage.
// ------------------------------------------------------------------

async function generateNvidiaMeetingInsights(transcript) {
  try {
    const lines = typeof transcript === 'string' ? JSON.parse(transcript) : transcript;
    if (!Array.isArray(lines) || !lines.length || lines.length > 1000) return { success: false, error: 'No usable captions were available for AI processing.' };
    const response = await fetch('http://127.0.0.1:8787/api/meeting-insights', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines })
    });
    const data = await response.json();
    if (!response.ok || !data.success) return { success: false, error: data.error || `Local AI proxy returned HTTP ${response.status}.` };
    return data;
  } catch (_) {
    return { success: false, error: 'Local AI proxy is not running. Start it with a newly rotated NVIDIA key; original captions are preserved.' };
  }
}

async function fetchAiProxy(path, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:8787${path}`, options);
    const data = await response.json();
    return { success: response.ok && !!data.ready, ready: !!data.ready, keyConfigured: Boolean(data.keyConfigured), error: data.error || null };
  } catch (_) { return { success: false, ready: false, keyConfigured: false, error: 'Local AI proxy is not running.' }; }
}

/**
 * Updates the action badge for a specific Google Meet tab.
 * @param {number} tabId
 * @param {number} count
 * @param {boolean} isPresenting
 */
function updateTabBadge(tabId, count, isPresenting) {
  if (!tabId) return;
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: isPresenting ? '#f59e0b' : '#0284c7'
  });
}

// Clear badge if tab navigates away from Google Meet
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !changeInfo.url.includes('meet.google.com')) {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateNvidiaMeetingInsights,
  };
}
