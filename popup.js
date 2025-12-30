// popup.js

let currentTab = null;
let currentHostname = null;
let driveFiles = [];
let syncedSites = {}; 
let currentSiteLocalStorage = {};
let remoteSiteData = {}; 

const views = {
  loading: document.getElementById('loading-view'),
  login: document.getElementById('login-view'),
  list: document.getElementById('list-view'),
  detail: document.getElementById('detail-view')
};

const els = {
  headerTitle: document.querySelector('header .logo'), 
  loginBtn: document.getElementById('login-btn'),
  currentHostname: document.getElementById('current-hostname'),
  addCurrentBtn: document.getElementById('add-current-btn'),
  configCurrentBtn: document.getElementById('config-current-btn'),
  currentSyncedBadge: document.getElementById('current-site-synced-badge'),
  currentDisabledBadge: document.getElementById('current-site-disabled-badge'),
  sitesList: document.getElementById('sites-list'),
  emptyState: document.getElementById('empty-state'),
  backBtn: document.getElementById('back-btn'),
  detailHostname: document.getElementById('detail-hostname'),
  keysList: document.getElementById('keys-list'),
  siteMasterToggle: document.getElementById('site-master-toggle'),
  deleteSiteBtn: document.getElementById('delete-site-btn'),
  conflictModal: document.getElementById('conflict-modal'),
  deleteModal: document.getElementById('delete-modal'),
  inspectorModal: document.getElementById('inspector-modal'),
  conflictMessage: document.getElementById('conflict-message'),
  conflictDomain: document.getElementById('conflict-domain'),
  conflictCloseBtn: document.getElementById('conflict-close-btn') // Added close btn
};

// --- Logger Helper ---
function logToTab(msg, ...args) {
  console.log(msg, ...args); 
  if (currentTab && currentTab.id) {
    chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: (m, a) => console.log('[SyncExt Popup]:', m, ...a),
      args: [msg, args]
    }).catch(() => {});
  }
}

// --- Initialization ---

async function init() {
  logToTab("Popup initializing...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (tab && tab.url && tab.url.startsWith('http')) {
    currentHostname = new URL(tab.url).hostname;
    els.currentHostname.textContent = currentHostname;
    logToTab("Current hostname:", currentHostname);
  } else {
    currentHostname = null;
    document.getElementById('current-site-section').classList.add('hidden');
    logToTab("No valid hostname found");
  }

  // Check auth silently
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (chrome.runtime.lastError || !token) {
      logToTab("Auth check failed or no token, showing login view");
      showView('login');
    } else {
      logToTab("Auth check success, loading data...");
      loadData();
    }
  });
}

// --- Navigation ---

function showView(viewName) {
  Object.values(views).forEach(el => el.classList.add('hidden'));
  views[viewName].classList.remove('hidden');
}

// --- Logic ---

function handleLoginClick() {
  showView('loading');
  logToTab("User clicked login...");
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError || !token) {
      console.error("Login failed:", chrome.runtime.lastError);
      showView('login');
      alert("Login failed. Check internet or extension ID.");
    } else {
      logToTab("Interactive login success");
      loadData();
    }
  });
}

async function loadData() {
  showView('loading');

  const localData = await chrome.storage.local.get('syncedSites');
  syncedSites = localData.syncedSites || {};
  logToTab("Loaded local syncedSites:", syncedSites);

  chrome.runtime.sendMessage({ action: 'list_sites' }, (response) => {
    if (!response || response.error) {
      console.error("List sites failed:", response ? response.error : chrome.runtime.lastError);
      driveFiles = [];
      renderDashboard();
      showView('list');
      return;
    }

    driveFiles = (response && response.files) ? response.files : [];
    logToTab("Loaded drive files:", driveFiles.length);
    renderDashboard();
    showView('list');
  });
}

function formatTime(isoString) {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderDashboard() {
  const domains = Object.keys(syncedSites);

  if (currentHostname) {
    const siteConfig = syncedSites[currentHostname];

    if (siteConfig) {
      els.addCurrentBtn.classList.add('hidden');
      els.configCurrentBtn.classList.remove('hidden');

      const hasEnabledKeys = siteConfig.keys && Object.values(siteConfig.keys).some(v => v === true);

      if (hasEnabledKeys) {
        els.currentSyncedBadge.classList.remove('hidden');
        els.currentDisabledBadge.classList.add('hidden');
      } else {
        els.currentSyncedBadge.classList.add('hidden');
        els.currentDisabledBadge.classList.remove('hidden');
      }
    } else {
      els.addCurrentBtn.classList.remove('hidden');
      els.currentSyncedBadge.classList.add('hidden');
      els.currentDisabledBadge.classList.add('hidden');
      els.configCurrentBtn.classList.add('hidden');
    }
  }

  els.sitesList.innerHTML = '';
  if (domains.length === 0) {
    els.emptyState.classList.remove('hidden');
  } else {
    els.emptyState.classList.add('hidden');
    domains.forEach(domain => {
      const config = syncedSites[domain];
      const file = driveFiles.find(f => f.name === domain + '.json');
      const lastSynced = file ? formatTime(file.modifiedTime) : 'Pending Sync';
      const hasEnabledKeys = config.keys && Object.values(config.keys).some(v => v === true);
      const statusText = hasEnabledKeys ? `Last synced: ${lastSynced}` : `Sync Paused`;

      const item = document.createElement('div');
      item.className = `site-item ${hasEnabledKeys ? 'enabled' : 'disabled'}`;
      item.innerHTML = `
        <div class="site-info">
          <span class="site-url">${domain}</span>
          <span class="site-status">${statusText}</span>
        </div>
        <div class="icon-btn">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
      `;
      item.onclick = () => openDetail(domain);
      els.sitesList.appendChild(item);
    });
  }
}

// --- Add / Config Flow ---

els.addCurrentBtn.addEventListener('click', async () => {
  if (!currentHostname) return;
  logToTab("Adding current site:", currentHostname);
  
  const localData = await chrome.storage.local.get('syncedSites');
  syncedSites = localData.syncedSites || {};

  if (!syncedSites[currentHostname]) {
    syncedSites[currentHostname] = { keys: {} };
    await chrome.storage.local.set({ syncedSites });
    logToTab("Initialized new site config");
    renderDashboard();
  }
  openDetail(currentHostname);
});

els.configCurrentBtn.addEventListener('click', () => {
  openDetail(currentHostname);
});

async function openDetail(domain) {
  logToTab("Opening detail for:", domain);
  els.detailHostname.textContent = domain;
  
  const localData = await chrome.storage.local.get('syncedSites');
  syncedSites = localData.syncedSites || {};
  let config = syncedSites[domain] || { keys: {} };
  
  if (els.siteMasterToggle) {
      els.siteMasterToggle.parentElement.parentElement.style.display = 'none'; // Hide master toggle per request
  }

  showView('loading');
  
  // 1. Get Local Page Data
  let localPageData = {};
  if (domain === currentHostname && currentTab) {
      localPageData = await getPageLocalStorage();
      logToTab("Fetched local page data keys:", Object.keys(localPageData));
  }

  // 2. Get Remote Drive Data
  const file = driveFiles.find(f => f.name === domain + '.json');
  let remoteData = {};
  if (file) {
    logToTab("Fetching remote data for file ID:", file.id);
    const resp = await new Promise(resolve => 
      chrome.runtime.sendMessage({ action: 'get_site_data', fileId: file.id }, resolve)
    );
    remoteData = (resp && resp.data) ? resp.data : {};
    remoteSiteData = remoteData; 
    logToTab("Fetched remote data keys:", Object.keys(remoteData));
  } else {
    logToTab("No remote file found for domain");
    remoteSiteData = {};
  }

  // 3. Merge Keys
  const allKeys = new Set([...Object.keys(localPageData), ...Object.keys(remoteData)]);
  logToTab("Total unique keys found:", allKeys.size);
  
  const freshData = await chrome.storage.local.get('syncedSites');
  config = (freshData.syncedSites || {})[domain] || { keys: {} };
  
  renderKeyList(Array.from(allKeys), localPageData, remoteData, config);
  showView('detail');

  setupDeleteHandlers(domain, file);
}

function renderKeyList(allKeys, localData, remoteData, config) {
  els.keysList.innerHTML = '';
  
  if (allKeys.length === 0) {
    els.keysList.innerHTML = '<div style="padding:10px; color:#888;">No localStorage data found.</div>';
    return;
  }

  allKeys.forEach(key => {
    const isSynced = config.keys && config.keys[key] === true;
    const localVal = localData[key];
    const remoteVal = remoteData[key];
    
    const row = document.createElement('div');
    row.className = 'key-item';
    const safeId = 'chk-' + Math.random().toString(36).substr(2, 9);
    
    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; width:100%;">
        <input type="checkbox" id="${safeId}" ${isSynced ? 'checked' : ''}>
        <div class="key-info" style="flex:1; overflow:hidden;">
            <label for="${safeId}" class="key-name" title="${key}" style="cursor:pointer; font-weight:500;">${key}</label>
            <div class="key-status" style="font-size:10px; color:#666;">
                ${localVal !== undefined ? 'Browser: Present' : 'Browser: -'} | 
                ${remoteVal !== undefined ? 'Cloud: Present' : 'Cloud: -'}
            </div>
        </div>
        <button class="icon-btn inspector-btn" title="Inspect Data">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        </button>
      </div>
    `;

    const checkbox = row.querySelector('input');
    const inspectBtn = row.querySelector('.inspector-btn');

    inspectBtn.onclick = () => {
        showInspector(key, localVal, remoteVal);
    };

    checkbox.onchange = async () => {
        logToTab(`Checkbox changed for ${key}. Checked: ${checkbox.checked}`);
        
        if (checkbox.checked) {
            // Enabling Sync
            // Strict Conflict Check: Always prompt if remote exists
            if (remoteVal !== undefined) {
                 logToTab("Remote data exists for this key. Prompting.");
                 promptConflict(els.detailHostname.textContent, key, localVal, remoteVal, checkbox);
                 return;
            }
            
            // If remote doesn't exist, we can safely push local
            logToTab("Remote empty. Pushing local.");
            await updateKeyConfig(els.detailHostname.textContent, key, true);
            if (localVal !== undefined) {
                await syncSingleKeyToCloud(els.detailHostname.textContent, key, localVal);
            }
        } else {
            logToTab("Disabling sync for key:", key);
            await updateKeyConfig(els.detailHostname.textContent, key, false);
        }
    };

    els.keysList.appendChild(row);
  });
}

function showInspector(key, localVal, remoteVal) {
    els.inspectorModal.querySelector('.modal-title').textContent = key;
    
    // Safely format JSON or just show string
    const safeFormat = (val) => {
        if(!val) return 'null';
        try { return JSON.stringify(JSON.parse(val), null, 2); }
        catch(e) { return val; }
    };

    els.inspectorModal.querySelector('#inspect-local').textContent = safeFormat(localVal);
    els.inspectorModal.querySelector('#inspect-remote').textContent = safeFormat(remoteVal);
    els.inspectorModal.classList.remove('hidden');
}

document.getElementById('inspector-close').onclick = () => {
    els.inspectorModal.classList.add('hidden');
};

async function updateKeyConfig(domain, key, enabled) {
    logToTab(`Updating config for ${domain}, key: ${key}, enabled: ${enabled}`);
    const data = await chrome.storage.local.get('syncedSites');
    let sites = data.syncedSites || {};
    
    if (!sites[domain]) sites[domain] = { keys: {} };
    if (!sites[domain].keys) sites[domain].keys = {};
    
    sites[domain].keys[key] = enabled;
    
    syncedSites = sites; 
    await chrome.storage.local.set({ syncedSites: sites });
    logToTab("Storage updated");
    renderDashboard(); 
}

async function syncSingleKeyToCloud(domain, key, value) {
    logToTab("Syncing single key to cloud:", key);
    remoteSiteData[key] = value;
    chrome.runtime.sendMessage({ 
      action: 'sync_site', 
      domain: domain, 
      data: remoteSiteData 
    });
}

async function injectKeyToPage(key, value) {
    if (!currentTab) return;
    await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: (k, v) => localStorage.setItem(k, v),
        args: [key, value]
    });
}

// --- Conflict Handling ---

let pendingConflict = null;

function promptConflict(domain, key, localVal, remoteVal, checkboxEl) {
    logToTab("Prompting conflict for:", key);
    pendingConflict = { domain, key, localVal, remoteVal, checkboxEl };
    
    if(els.conflictDomain) els.conflictDomain.textContent = domain;
    
    // Prevent premature enabling. User must choose an action.
    checkboxEl.checked = false; 
    
    if(els.conflictMessage) {
        els.conflictMessage.innerHTML = `Cloud data found for <b>${key}</b>.<br>Do you want to overwrite your browser data with cloud data, or overwrite cloud data with browser data?`;
    }

    els.conflictModal.classList.remove('hidden');
}

// Close Button Logic
if(els.conflictCloseBtn) {
    els.conflictCloseBtn.addEventListener('click', () => {
        logToTab("Conflict dialog cancelled via close button.");
        els.conflictModal.classList.add('hidden');
        // Clear pending conflict. The checkbox was already unchecked in promptConflict.
        pendingConflict = null;
    });
}

document.getElementById('conflict-use-local').addEventListener('click', async () => {
    logToTab("Resolving conflict: USE LOCAL");
    if(!pendingConflict) return;
    const { domain, key, localVal, checkboxEl } = pendingConflict;
    
    await updateKeyConfig(domain, key, true);
    await syncSingleKeyToCloud(domain, key, localVal);
    
    checkboxEl.checked = true;
    els.conflictModal.classList.add('hidden');
    pendingConflict = null;
    
    chrome.runtime.sendMessage({ action: 'force_sync_current_tab' });
});

document.getElementById('conflict-use-remote').addEventListener('click', async () => {
    logToTab("Resolving conflict: USE REMOTE");
    if(!pendingConflict) return;
    const { domain, key, remoteVal, checkboxEl } = pendingConflict;
    
    await updateKeyConfig(domain, key, true);
    await injectKeyToPage(key, remoteVal);
    chrome.tabs.reload(currentTab.id);
    
    checkboxEl.checked = true;
    els.conflictModal.classList.add('hidden');
    pendingConflict = null;
    
    chrome.runtime.sendMessage({ action: 'force_sync_current_tab' });
});

function setupDeleteHandlers(domain, file) {
  els.deleteSiteBtn.onclick = () => {
    els.deleteModal.classList.remove('hidden');
    document.getElementById('delete-browser-only').onclick = async () => {
       const d = await chrome.storage.local.get('syncedSites');
       let s = d.syncedSites || {};
       delete s[domain];
       await chrome.storage.local.set({ syncedSites: s });
       els.deleteModal.classList.add('hidden');
       loadData();
    };
    document.getElementById('delete-remote-data').onclick = async () => {
       const d = await chrome.storage.local.get('syncedSites');
       let s = d.syncedSites || {};
       delete s[domain];
       await chrome.storage.local.set({ syncedSites: s });
       if (file) {
         chrome.runtime.sendMessage({ action: 'delete_sync_data', fileId: file.id });
       }
       els.deleteModal.classList.add('hidden');
       loadData();
    };
    document.getElementById('delete-cancel').onclick = () => {
      els.deleteModal.classList.add('hidden');
    };
  };
}

async function getPageLocalStorage() {
  if (!currentTab) return {};
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: () => { return { ...localStorage }; }
  });
  return result.result || {};
}

if(els.headerTitle) {
    els.headerTitle.style.cursor = 'pointer';
    els.headerTitle.onclick = () => {
        if(confirm("Force sync now?")) {
            loadData();
            chrome.runtime.sendMessage({ action: 'force_sync_current_tab' });
        }
    };
}

els.loginBtn.addEventListener('click', handleLoginClick);
els.backBtn.addEventListener('click', () => {
    loadData();
    showView('list');
});

init();