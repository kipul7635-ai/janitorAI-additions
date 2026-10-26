// background.js
chrome.webRequest.onCompleted.addListener(
  function(details) {
    // Look for the exact network endpoints Janitor AI uses to generate and save messages
    if (details.url.includes("generateAlpha") || details.url.includes("/completions") || details.url.includes("/messages")) {
      
      // Ensure the request happened in a specific tab, not a background system task
      if (details.tabId !== -1) {
        // Send a message to the content script in that tab
        chrome.tabs.sendMessage(details.tabId, { action: "chat_updated" }).catch(() => {
          // Ignore errors if the tab was closed or navigating
        });
      }
    }
  },
  { urls: ["*://*.janitorai.com/*"] }
);
