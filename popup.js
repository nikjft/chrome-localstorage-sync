// popup.js

let currentTab = null;
let currentHostname = null;
let driveFiles = []; // Cache of synced files
let syncedSites = {}; // Object: { "example.com": { enabled: true } }
let currentSiteLocalStorage = {}; // Data from the current page

// --- Elements ---
const views = {
  loading: document.getElementById('loading-view'),
  login: document.getElementById('login-view'),
  list: document.getElementById('list-view'),
  detail: document.getElementById('detail-view')
};
const els = {
  loginBtn: document.getElementById('login-btn'),
  currentHostname: document.getElementById('current-hostname'),
  addCurrentBtn: document.getElementById('add-current-btn'),
  configCurrentBtn: document.getElementById('config-current-btn'),
  currentSyncedBadge: document.getElementById('current-site-synced-badge'),
  currentDisabledBadge: document.getElementById('current-site-disabled-badge'),
  sitesList: document.getElementById('sites-list'),
  emptyState: document.getElementById('empty-state'),
  // Detail View
  backBtn: document.getElementById('back-btn'),
  detailHostname: document.getElementById('detail-hostname'),
  keysList: document.getElementById('keys-list'),
  siteMasterToggle: document.getElementById('site-master-toggle'),
  deleteSiteBtn: document.getElementById('delete-site-btn'),
  // Modals
  conflictModal: document.getElementById('conflict-modal'),
  deleteModal: document.getElementById('delete-modal'),
};

// --- Initialization ---

async function init() {
  // 1. Get Current Tab Info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  
  if (tab.url.startsWith('http')) {
    currentHostname = new URL(tab.url).hostname;
    els.currentHostname.textContent = currentHostname;
  } else {
    currentHostname = null;
    document.getElementById('current-site-section').classList.add('hidden');
  }

  // 2. Check Auth Status
  chrome.runtime.sendMessage({ action: 'login' }, (response) => {
    if (response && response.success) {
      loadData();
    } else {
      showView('login');
    }
  });
}

// --- Navigation ---

function showView(viewName) {
  Object.values(views).forEach(el => el.classList.add('hidden'));
  views[viewName].classList.remove('hidden');
}

// --- Logic ---

async function loadData() {
  showView('loading');
  
  // 1. Get Local Config
  const localData = await chrome.storage.local.get('syncedSites');
  syncedSites = localData.syncedSites || {};

  // 2. Get Remote Files (Drive)
  chrome.runtime.sendMessage({ action: 'list_sites' }, (response) => {
    if (response.error) {
      console.error(response.error);
      // Fallback if drive fails, just show local config
      renderDashboard();
      showView('list');
      return;
    }
    
    driveFiles = response.files || [];
    renderDashboard();
    showView('list');
  });
}

function renderDashboard() {
  const domains = Object.keys(syncedSites);

  // Update Current Site Status
  if (currentHostname) {
    const siteConfig = syncedSites[currentHostname];
    
    if (siteConfig) {
      els.addCurrentBtn.classList.add('hidden');
      els.configCurrentBtn.classList.remove('hidden');
      
      if (siteConfig.enabled) {
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

  // Render List
  els.sitesList.innerHTML = '';
  if (domains.length === 0) {
    els.emptyState.classList.remove('hidden');
  } else {
    els.emptyState.classList.add('hidden');
    domains.forEach(domain => {
      const config = syncedSites[domain];
      
      // Find Drive status
      const file = driveFiles.find(f => f.name === domain + '.json');
      const lastSynced = file ? new Date(file.modifiedTime).toLocaleDateString() : 'Pending Sync';
      const statusText = config.enabled ? `Last synced: ${lastSynced}` : `Sync Paused`;
      
      const item = document.createElement('div');
      item.className = `site-item ${config.enabled ? 'enabled' : 'disabled'}`;
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

// --- Add Site Flow ---

els.addCurrentBtn.addEventListener('click', async () => {
  if (!currentHostname) return;
  
  // 1. Fetch LocalStorage from page
  const data = await getPageLocalStorage();
  currentSiteLocalStorage = data;

  // 2. Check if file exists in Drive (Conflict Check)
  const existingFile = driveFiles.find(f => f.name === currentHostname + '.json');
  
  if (existingFile) {
    document.getElementById('conflict-domain').textContent = currentHostname;
    els.conflictModal.classList.remove('hidden');
  } else {
    await addSite(currentHostname, data, true); // True = overwrite/upload local
  }
});

els.configCurrentBtn.addEventListener('click', () => {
  openDetail(currentHostname);
});

async function addSite(domain, data, uploadToDrive = true) {
  // Update Local List with "Enabled"
  syncedSites[domain] = { enabled: true };
  await chrome.storage.local.set({ syncedSites });

  if (uploadToDrive) {
    // Upload to Drive
    chrome.runtime.sendMessage({ 
      action: 'sync_site', 
      domain: domain, 
      data: data 
    }, (resp) => {
      loadData(); // Reload UI
    });
  } else {
    loadData();
  }
}

// --- Detail View ---

async function openDetail(domain) {
  els.detailHostname.textContent = domain;
  const config = syncedSites[domain];
  
  // Set Toggle State
  els.siteMasterToggle.checked = config ? config.enabled : false;
  
  // Handle Toggle Change
  els.siteMasterToggle.onclick = async () => {
    const isEnabled = els.siteMasterToggle.checked;
    syncedSites[domain] = { ...syncedSites[domain], enabled: isEnabled };
    await chrome.storage.local.set({ syncedSites });
    // Note: We don't delete data when disabling, per requirements
  };

  // Load Remote Keys
  const file = driveFiles.find(f => f.name === domain + '.json');
  let remoteData = {};
  
  if (file) {
    const resp = await new Promise(resolve => 
      chrome.runtime.sendMessage({ action: 'get_site_data', fileId: file.id }, resolve)
    );
    remoteData = resp.data || {};
  }
  
  renderKeys(remoteData);
  showView('detail');
  
  // Set delete handlers
  els.deleteSiteBtn.onclick = () => {
    els.deleteModal.classList.remove('hidden');
    
    document.getElementById('delete-browser-only').onclick = async () => {
       delete syncedSites[domain];
       await chrome.storage.local.set({ syncedSites });
       els.deleteModal.classList.add('hidden');
       loadData();
    };

    document.getElementById('delete-remote-data').onclick = async () => {
       delete syncedSites[domain];
       await chrome.storage.local.set({ syncedSites });
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

function renderKeys(data) {
  els.keysList.innerHTML = '';
  const keys = Object.keys(data);
  
  if (keys.length === 0) {
    els.keysList.innerHTML = '<div style="padding:10px; color:#888;">No data synced yet.</div>';
    return;
  }

  keys.forEach(key => {
    const row = document.createElement('div');
    row.className = 'key-item';
    row.innerHTML = `
      <div class="key-name">${key}</div>
    `;
    els.keysList.appendChild(row);
  });
}

// --- Helpers ---

async function getPageLocalStorage() {
  if (!currentTab) return {};
  
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: () => { return { ...localStorage }; }
  });
  
  return result.result || {};
}

// --- Event Listeners ---

els.loginBtn.addEventListener('click', init);
els.backBtn.addEventListener('click', () => showView('list'));

// Conflict Resolution
document.getElementById('conflict-use-local').addEventListener('click', async () => {
  els.conflictModal.classList.add('hidden');
  await addSite(currentHostname, currentSiteLocalStorage, true);
});

document.getElementById('conflict-use-remote').addEventListener('click', async () => {
  els.conflictModal.classList.add('hidden');
  
  // 1. Add to local config (enabled)
  syncedSites[currentHostname] = { enabled: true };
  await chrome.storage.local.set({ syncedSites });

  // 2. Fetch remote data and apply to browser
  const file = driveFiles.find(f => f.name === currentHostname + '.json');
  if (file) {
    const resp = await new Promise(resolve => 
      chrome.runtime.sendMessage({ action: 'get_site_data', fileId: file.id }, resolve)
    );
    const remoteData = resp.data || {};
    
    chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: (d) => { Object.keys(d).forEach(k => localStorage.setItem(k, d[k])); },
      args: [remoteData]
    });
  }
  
  loadData();
});

// Start
init();