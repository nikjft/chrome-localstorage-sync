// content.js - Helper to read/write localStorage

// We can add a listener here if we want to push changes proactively, 
// but for now relying on the 1-minute alarm in background.js is safer 
// to avoid "chatty" network calls.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_all_storage") {
    sendResponse({ data: { ...localStorage } });
  }
  
  if (request.action === "set_storage_items") {
    const items = request.items;
    let count = 0;
    Object.keys(items).forEach(key => {
      localStorage.setItem(key, items[key]);
      count++;
    });
    sendResponse({ success: true, count });
  }
});