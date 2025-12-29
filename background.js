// background.js - Handles Google Drive Auth & Sync Logic

let authToken = null;

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
  if (!token) throw new Error("Not authenticated");

  const query = "trashed = false and 'appDataFolder' in parents";
  const url = `${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id, name, modifiedTime, size)&spaces=appDataFolder`;

  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (response.status === 401) {
    chrome.identity.removeCachedAuthToken({ token }, () => {});
    return listSyncedFiles();
  }

  const data = await response.json();
  return data.files || [];
}

async function getFileContent(fileId) {
  const token = await getAuthToken(false);
  const response = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return await response.json();
}

async function uploadFile(filename, contentJson, fileId = null) {
  const token = await getAuthToken(true);
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
  const token = await getAuthToken(true);
  await fetch(`${DRIVE_API}/${fileId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

// --- Messaging with Popup/Content ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'login') {
    getAuthToken(true).then(token => sendResponse({ success: !!token }));
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

// --- Tab Listener (Auto-Sync) ---

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    const url = new URL(tab.url);
    const domain = url.hostname;

    const storageData = await chrome.storage.local.get('syncedSites');
    const syncedSites = storageData.syncedSites || {};
    
    // Check if site is configured AND enabled
    if (syncedSites[domain] && syncedSites[domain].enabled) {
      console.log(`Auto-syncing detected for ${domain}`);
      
      const files = await listSyncedFiles().catch(() => []);
      const file = files.find(f => f.name === domain + '.json');
      
      if (file) {
        const data = await getFileContent(file.id);
        
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: (dataToInject) => {
            console.log("Applying synced data...", dataToInject);
            Object.keys(dataToInject).forEach(key => {
               localStorage.setItem(key, dataToInject[key]);
            });
          },
          args: [data]
        });
      }
    }
  }
});