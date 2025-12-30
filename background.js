// background.js - Handles Google Drive Auth & Sync Logic

let authToken = null;
let syncDebounceTimer = null;

// --- Helper: Log to Active Tab ---
// Injects logs into the active tab console for visibility
async function logToActiveTab(msg, ...args) {
    try {
        const tabs = await chrome.tabs.query({ active: true });
        for (const tab of tabs) {
            if (tab.url && tab.url.startsWith('http')) {
                 chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (m, a) => console.log('[SyncExt Background]:', m, ...a),
                    args: [msg, args]
                 }).catch(() => {});
            }
        }
    } catch(e) { /* Ignore logging errors */ }
}

// --- Helper: Data & Timestamp Management ---
// Wraps raw data with a timestamp
function wrapData(value, ts = Date.now()) {
    // If it's already wrapped, don't double wrap unless structure is wrong
    if (value && typeof value === 'object' && 'value' in value && 'ts' in value) {
        return value;
    }
    return { value: value, ts: ts };
}

// Unwraps data, handling both legacy (raw string) and new (object) formats
function unwrapValue(item) {
    if (item && typeof item === 'object' && 'value' in item) {
        return item.value;
    }
    return item;
}

function getTimestamp(item) {
    if (item && typeof item === 'object' && 'ts' in item) {
        return item.ts;
    }
    return 0; // Legacy data is treated as "old"
}

// --- Authentication ---
function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        if (interactive) console.error("Auth failed:", chrome.runtime.lastError);
        resolve(null);
      } else {
        authToken = token;
        resolve(token);
      }
    });
  });
}

// --- Google Drive API Helpers ---

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

async function listSyncedFiles() {
  const token = await getAuthToken(false);
  if (!token) return [];

  const query = "trashed = false and 'appDataFolder' in parents";
  const url = `${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id, name, modifiedTime, size)&spaces=appDataFolder`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (response.status === 401) {
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
    return listSyncedFiles(); 
  }

  if (!response.ok) return [];

  const data = await response.json();
  return data.files || [];
}

async function getFileContent(fileId) {
  const token = await getAuthToken(false);
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return await response.json();
}

async function uploadFile(filename, contentJson, fileId = null) {
  const token = await getAuthToken(false); 
  if (!token) throw new Error("Auth required");

  const metadata = {
    name: filename,
    mimeType: 'application/json',
    parents: fileId ? [] : ['appDataFolder']
  };

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', new Blob([JSON.stringify(contentJson)], { type: 'application/json' }));

  let url = UPLOAD_API + '?uploadType=multipart';
  let method = 'POST';

  if (fileId) {
    url = `${UPLOAD_API}/${fileId}?uploadType=multipart`;
    method = 'PATCH';
  }

  const response = await fetch(url, {
    method: method,
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });

  return await response.json();
}

async function deleteFile(fileId) {
  const token = await getAuthToken(false);
  if (!token) return;
  await fetch(`${DRIVE_API}/${fileId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// --- Periodic Sync Logic ---

chrome.alarms.create('sync_check', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync_check') {
    await performPeriodicSync(false); // false = not triggered by user action
  }
});

async function performPeriodicSync(isTriggered = false) {
  const mode = isTriggered ? "Triggered" : "Periodic";
  console.log(`Running ${mode} sync...`);
  if(isTriggered) logToActiveTab(`${mode} sync started...`);
  
  const tabs = await chrome.tabs.query({ active: true });
  
  for (const tab of tabs) {
    if (!tab.url || !tab.url.startsWith('http')) continue;
    
    const url = new URL(tab.url);
    const domain = url.hostname;
    
    // 1. Load Extension Storage (Config + Shadow)
    const storageData = await chrome.storage.local.get('syncedSites');
    const syncedSites = storageData.syncedSites || {};
    const config = syncedSites[domain];
    
    // Explicitly check for at least one active key
    if (config && config.keys && Object.values(config.keys).some(v => v === true)) {
      // Ensure shadow storage exists
      if (!config.shadow) config.shadow = {};

      try {
        // 2. Fetch Live Page Data
        const localData = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({...localStorage})
        });
        
        if (!localData || !localData[0] || !localData[0].result) continue;
        const livePageData = localData[0].result;
        let shadowUpdated = false;

        // 3. Detect Local Changes (Update Shadow)
        Object.keys(config.keys).forEach(key => {
            if (config.keys[key] === true) {
                const liveVal = livePageData[key];
                const shadowVal = unwrapValue(config.shadow[key]);

                // If live differs from shadow, User modified it recently.
                // Update shadow with NEW timestamp.
                // EXCEPTION: If liveVal is missing (undefined/null), user might have deleted it,
                // OR it might be a fresh load where we want to restore.
                // We SKIP updating shadow here if missing, so we can detect it as "missing" in Step 4.
                if (liveVal !== shadowVal) {
                    // Only update if liveVal is defined (avoid deleting if null temporarily)
                    if(liveVal !== undefined && liveVal !== null) {
                        config.shadow[key] = wrapData(liveVal, Date.now());
                        shadowUpdated = true;
                        console.log(`Local change detected for ${key}. Updated timestamp.`);
                    }
                }
            }
        });

        // Save shadow updates immediately
        if (shadowUpdated) {
            syncedSites[domain] = config;
            await chrome.storage.local.set({ syncedSites });
        }
        
        // 4. Fetch Remote Cloud Data
        const files = await listSyncedFiles().catch(() => []);
        const file = files.find(f => f.name === domain + '.json');
        
        if (file) {
           const remoteDataRaw = await getFileContent(file.id);
           let needsUpload = false;
           let newDataForCloud = { ...remoteDataRaw };
           let injectDataRaw = {};
           let reloadNeeded = false;
           
           Object.keys(config.keys).forEach(key => {
             if (config.keys[key] === true) {
               
               const localObj = config.shadow[key]; // { value, ts }
               const cloudObj = remoteDataRaw[key]; // { value, ts } or raw value
               const liveVal = livePageData[key];

               // RESTORE CHECK:
               // If missing from page (liveVal undefined) AND exists in cloud -> Restore
               // This fixes the "I deleted it, bring it back" scenario.
               if ((liveVal === undefined || liveVal === null) && cloudObj) {
                   injectDataRaw[key] = unwrapValue(cloudObj);
                   // Update shadow to match cloud so we don't re-pull next time
                   config.shadow[key] = wrapData(unwrapValue(cloudObj), getTimestamp(cloudObj));
                   shadowUpdated = true;
                   reloadNeeded = true;
                   console.log(`[SyncExt] Key ${key} missing locally. Restoring from cloud.`);
                   return; // Done with this key
               }

               // Case A: Missing locally (Shadow missing), exists in cloud -> Pull
               if (!localObj && cloudObj) {
                   injectDataRaw[key] = unwrapValue(cloudObj);
                   // Update shadow to match cloud so we don't re-pull next time
                   config.shadow[key] = wrapData(unwrapValue(cloudObj), getTimestamp(cloudObj));
                   shadowUpdated = true;
                   reloadNeeded = true;
                   return;
               }

               // Case B: Both exist -> Compare Timestamps
               if (localObj) {
                   const localTS = getTimestamp(localObj);
                   const cloudTS = getTimestamp(cloudObj); // Returns 0 if cloudObj is missing or legacy

                   if (localTS > cloudTS) {
                       // Local is newer -> Push to Cloud
                       // Only push if value is actually different to save bandwidth
                       if (unwrapValue(localObj) !== unwrapValue(cloudObj)) {
                           newDataForCloud[key] = localObj; // Push the whole object {value, ts}
                           needsUpload = true;
                           console.log(`Pushing newer local ${key} (TS: ${localTS}) > cloud (TS: ${cloudTS})`);
                       }
                   } else if (cloudTS > localTS) {
                       // Cloud is newer -> Pull to Local
                       if (unwrapValue(localObj) !== unwrapValue(cloudObj)) {
                           injectDataRaw[key] = unwrapValue(cloudObj);
                           // Update shadow to match accepted cloud state
                           config.shadow[key] = cloudObj; 
                           shadowUpdated = true;
                           reloadNeeded = true;
                           console.log(`Pulling newer cloud ${key} (TS: ${cloudTS}) > local (TS: ${localTS})`);
                       }
                   }
               }
             }
           });
           
           if (needsUpload) {
             logToActiveTab("Uploading newer changes for", domain);
             await uploadFile(domain + '.json', newDataForCloud, file.id);
           }

           if (reloadNeeded) {
               logToActiveTab("Restoring newer keys from cloud...");
               
               // Save shadow changes before reload
               syncedSites[domain] = config;
               await chrome.storage.local.set({ syncedSites });

               await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (data) => {
                        Object.keys(data).forEach(k => {
                            if (data[k] !== undefined && data[k] !== null) {
                                localStorage.setItem(k, data[k]);
                            }
                        });
                    },
                    args: [injectDataRaw]
               });
               chrome.tabs.reload(tab.id);
           } else if (shadowUpdated) {
               // Save shadow changes if only internal state changed
               syncedSites[domain] = config;
               await chrome.storage.local.set({ syncedSites });
           }
        }
      } catch (e) {
        console.warn("Periodic sync error for tab", tab.id, e);
      }
    }
  }
}

// --- Messaging ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'check_auth') {
    getAuthToken(false).then(token => sendResponse({ success: !!token }));
    return true;
  }
  
  if (request.action === 'force_sync_current_tab') {
      performPeriodicSync(true).then(() => sendResponse({ success: true }));
      return true;
  }

  // STARTUP DATA HANDLER
  if (request.action === 'get_startup_data') {
      chrome.storage.local.get('syncedSites').then((data) => {
          const sites = data.syncedSites || {};
          const config = sites[request.domain];
          const result = {};
          
          if (config && config.keys && config.shadow) {
              Object.keys(config.keys).forEach(key => {
                  // Only send data if key is enabled AND data exists in shadow
                  if (config.keys[key] === true && config.shadow[key]) {
                      result[key] = unwrapValue(config.shadow[key]);
                  }
              });
          }
          sendResponse({ data: result });
      });
      return true; // Keep channel open for async response
  }
  
  // NEW: Debounced Instant Sync Trigger
  if (request.action === 'trigger_debounce_sync') {
      const { domain, key } = request;
      console.log(`[SyncExt Background] Trigger received for ${domain} key: ${key}`);
      
      chrome.storage.local.get('syncedSites').then((data) => {
          const sites = data.syncedSites || {};
          // Check if this specific key is enabled for sync
          if (sites[domain] && sites[domain].keys && sites[domain].keys[key] === true) {
              
              if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
              
              console.log(`[SyncExt Background] Change valid. Debouncing sync...`);
              syncDebounceTimer = setTimeout(() => {
                  console.log("[SyncExt Background] Debounce timer finished. Triggering sync.");
                  performPeriodicSync(true); 
                  syncDebounceTimer = null;
              }, 2000); 
          }
      });
      return true;
  }

  if (request.action === 'list_sites') {
    listSyncedFiles()
      .then(files => sendResponse({ files }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'get_site_data') {
    getFileContent(request.fileId)
      .then(data => sendResponse({ data }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'sync_site') {
    listSyncedFiles().then(async (files) => {
      const filename = request.domain + '.json';
      const existingFile = files.find(f => f.name === filename);
      
      try {
        // When popup manually syncs, we assume that is the "truth".
        // We wrap it in a new timestamp.
        const payload = {};
        Object.keys(request.data).forEach(k => {
            payload[k] = wrapData(unwrapValue(request.data[k]), Date.now());
        });

        await uploadFile(filename, payload, existingFile ? existingFile.id : null);
        
        // Also update local shadow to prevent immediate overwrites
        const domain = request.domain;
        const d = await chrome.storage.local.get('syncedSites');
        const s = d.syncedSites || {};
        if(s[domain]) {
            if(!s[domain].shadow) s[domain].shadow = {};
            Object.keys(payload).forEach(k => {
                s[domain].shadow[k] = payload[k];
            });
            await chrome.storage.local.set({ syncedSites: s });
        }

        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }
  
  if (request.action === 'delete_sync_data') {
    deleteFile(request.fileId)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// --- Tab Listener (Inject Logic) ---

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    // Re-run the main sync logic on load.
    // This allows the timestamp check to happen immediately.
    performPeriodicSync(); 
  }
});