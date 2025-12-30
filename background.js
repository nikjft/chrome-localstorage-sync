// background.js - Handles Google Drive Auth & Sync Logic

let authToken = null;

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
    await performPeriodicSync();
  }
});

async function performPeriodicSync() {
  console.log("Running periodic sync...");
  logToActiveTab("Running periodic sync...");
  
  const tabs = await chrome.tabs.query({ active: true });
  
  for (const tab of tabs) {
    if (!tab.url || !tab.url.startsWith('http')) continue;
    
    const url = new URL(tab.url);
    const domain = url.hostname;
    
    const storageData = await chrome.storage.local.get('syncedSites');
    const syncedSites = storageData.syncedSites || {};
    const config = syncedSites[domain];
    
    // Explicitly check for at least one active key
    if (config && config.keys && Object.values(config.keys).some(v => v === true)) {
      try {
        // 1. Fetch current local data from page
        const localData = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({...localStorage})
        });
        
        if (!localData || !localData[0] || !localData[0].result) continue;
        const currentLocal = localData[0].result;
        
        // 2. Fetch remote
        const files = await listSyncedFiles().catch(() => []);
        const file = files.find(f => f.name === domain + '.json');
        
        if (file) {
           const remoteData = await getFileContent(file.id);
           let needsUpload = false;
           let newData = { ...remoteData };
           let reloadNeeded = false;
           let injectData = {};
           
           // 3. Compare enabled keys - RULE: Local Edit overwrites Server
           Object.keys(config.keys).forEach(key => {
             if (config.keys[key] === true) {
               // Only push if local exists and differs
               if (currentLocal[key] !== undefined && currentLocal[key] !== remoteData[key]) {
                 newData[key] = currentLocal[key];
                 needsUpload = true;
               } 
               // Protection: Restore if local is missing but remote exists
               else if (currentLocal[key] === undefined && remoteData[key] !== undefined) {
                   injectData[key] = remoteData[key];
                   reloadNeeded = true;
               }
             }
           });
           
           if (needsUpload) {
             logToActiveTab("Uploading changes for", domain);
             await uploadFile(domain + '.json', newData, file.id);
           }

           if (reloadNeeded) {
               logToActiveTab("Restoring missing local keys from cloud...");
               await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: (data) => {
                        Object.keys(data).forEach(k => {
                            if (data[k] !== undefined && data[k] !== null) {
                                localStorage.setItem(k, data[k]);
                            }
                        });
                    },
                    args: [injectData]
               });
               chrome.tabs.reload(tab.id);
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
      performPeriodicSync().then(() => sendResponse({ success: true }));
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
        await uploadFile(filename, request.data, existingFile ? existingFile.id : null);
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
    const url = new URL(tab.url);
    const domain = url.hostname;

    const storageData = await chrome.storage.local.get('syncedSites');
    const syncedSites = storageData.syncedSites || {};
    const config = syncedSites[domain];

    // RULE: On Load -> Load Server Data (if key enabled)
    if (config && config.keys && Object.values(config.keys).some(v => v === true)) {
      console.log(`Auto-syncing detected for ${domain}`);
      
      const files = await listSyncedFiles().catch(() => []);
      const file = files.find(f => f.name === domain + '.json');
      
      if (file) {
        try {
            const remoteData = await getFileContent(file.id);
            
            const dataToInject = {};
            Object.keys(config.keys).forEach(key => {
                // Strict check: Key must be explicitly checked in config
                if (config.keys[key] === true && remoteData.hasOwnProperty(key)) {
                    dataToInject[key] = remoteData[key];
                }
            });

            if (Object.keys(dataToInject).length > 0) {
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (data) => {
                        let changed = false;
                        Object.keys(data).forEach(key => {
                            // Fix: Don't inject undefined/null blindly, check if it matters
                            if (data[key] !== undefined && data[key] !== null) {
                                if (localStorage.getItem(key) !== data[key]) {
                                    console.log("Overwriting key:", key);
                                    localStorage.setItem(key, data[key]);
                                    changed = true;
                                }
                            }
                        });
                        return changed;
                    },
                    args: [dataToInject]
                }, (results) => {
                    if (results && results[0] && results[0].result === true) {
                        logToActiveTab("Data injected from cloud, reloading page...");
                        chrome.tabs.reload(tabId);
                    }
                });
            }
        } catch (e) {
            console.warn("Sync failed (likely auth):", e);
        }
      }
    }
  }
});