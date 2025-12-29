// content.js - Helper to read/write localStorage

// Listen for requests from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_all_storage") {
    // Send all localStorage back
    sendResponse({ data: { ...localStorage } });
  }
  
  if (request.action === "set_storage_items") {
    // Update specific keys
    const items = request.items;
    let count = 0;
    Object.keys(items).forEach(key => {
      localStorage.setItem(key, items[key]);
      count++;
    });
    sendResponse({ success: true, count });
  }
});