// background.js
chrome.webRequest.onCompleted.addListener(
  function(details) {
    // Look specifically for the "track" endpoint
    if (details.url.includes("track")) {
      
      if (details.tabId !== -1) {
        // Send a message to the content script in that tab
        chrome.tabs.sendMessage(details.tabId, { action: "chat_updated" }).catch(() => {
          // Ignore errors if the tab was closed
        });
      }
    }
  },
  { urls: ["*://*.janitorai.com/*"] }
);
