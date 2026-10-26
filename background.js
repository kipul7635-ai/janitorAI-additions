// background.js
chrome.webRequest.onCompleted.addListener(
  function(details) {
    // We only care about POST requests to the messages endpoint (saving a new message)
    // This prevents triggering on GET requests (loading the chat history)
    if (details.method === "POST" && details.url.includes("/messages")) {
      
      if (details.tabId !== -1) {
        chrome.tabs.sendMessage(details.tabId, { action: "chat_updated" }).catch(() => {
          // Ignore errors if the tab was closed
        });
      }
    }
  },
  { urls: ["*://*.janitorai.com/*"] }
);
