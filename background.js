// background.js
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    // We only care about POST requests to the messages endpoint
    if (details.method === "POST" && details.url.includes("/messages")) {
      
      // Check if the request body is available
      if (details.requestBody && details.requestBody.raw) {
        try {
          // Decode the raw request body
          const decoder = new TextDecoder("utf-8");
          const rawBody = decoder.decode(details.requestBody.raw[0].bytes);
          const bodyJson = JSON.parse(rawBody);

          // Only trigger if the message is from the bot
          if (bodyJson.is_bot === true) {
            if (details.tabId !== -1) {
              chrome.tabs.sendMessage(details.tabId, { action: "chat_updated" }).catch(() => {});
            }
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }
  },
  { urls: ["*://*.janitorai.com/*"] },
  ["requestBody"]
);
