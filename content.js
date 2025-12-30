// content.js - Monitors localStorage changes in real-time

// 1. FAST RESTORE: Attempt to get data and restore it before page scripts run
// This fixes the issue where pages set "defaults" because they think data is missing.
const domain = window.location.hostname;

try {
    chrome.runtime.sendMessage({ action: 'get_startup_data', domain: domain }, (response) => {
        if (response && response.data) {
            let restoredCount = 0;
            Object.keys(response.data).forEach(key => {
                // SAFETY CHECK: Only restore if the key is MISSING.
                // If the key exists, it might be newer offline work, so we don't touch it.
                if (localStorage.getItem(key) === null) {
                    localStorage.setItem(key, response.data[key]);
                    restoredCount++;
                }
            });
            if (restoredCount > 0) {
                console.log(`[SyncExt Content]: Restored ${restoredCount} keys from shadow storage.`);
            }
        }
    });
} catch (e) {
    // Context invalidated or extension reloaded
}

// 2. INJECT HOOK: We inject a script into the MAIN world to hook into localStorage methods.
const script = document.createElement('script');
script.textContent = `
  (function() {
    // console.log("[SyncExt Page Hook]: Initializing localStorage hook...");
    
    try {
      const originalSetItem = localStorage.setItem;
      const originalRemoveItem = localStorage.removeItem;

      localStorage.setItem = function(key, value) {
        // console.log("[SyncExt Page Hook]: Intercepted setItem for", key);
        originalSetItem.apply(this, arguments);
        window.postMessage({ type: 'SYNC_EXT_LS_CHANGE', key: key }, '*');
      };

      localStorage.removeItem = function(key) {
        // console.log("[SyncExt Page Hook]: Intercepted removeItem for", key);
        originalRemoveItem.apply(this, arguments);
        window.postMessage({ type: 'SYNC_EXT_LS_CHANGE', key: key }, '*');
      };
      
      // console.log("[SyncExt Page Hook]: Success.");
    } catch(e) {
      console.error("[SyncExt Page Hook]: Error hooking localStorage:", e);
    }
  })();
`;

// Inject immediately
const target = document.head || document.documentElement;
if (target) {
    target.appendChild(script);
    script.remove(); // Clean up tag
} else {
    console.error("[SyncExt Content]: Could not find target to inject hook.");
}

// 3. LISTEN: Listen for the messages sent by our injected script
window.addEventListener('message', (event) => {
  // Security: only accept messages from this window
  if (event.source !== window) return;

  if (event.data && event.data.type === 'SYNC_EXT_LS_CHANGE') {
    const key = event.data.key;
    const currentDomain = window.location.hostname;
    
    // console.log("[SyncExt Content]: Forwarding change event for:", key);

    // Forward to background script
    chrome.runtime.sendMessage({
      action: 'trigger_debounce_sync',
      domain: currentDomain,
      key: key
    });
  }
});