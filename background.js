// background.js

// 1. Watch for bot messages being saved
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (details.method === "POST" && details.url.includes("/messages")) {
      if (details.requestBody && details.requestBody.raw) {
        try {
          const decoder = new TextDecoder("utf-8");
          const rawBody = decoder.decode(details.requestBody.raw[0].bytes);
          const bodyJson = JSON.parse(rawBody);
          
          // Only trigger for AI messages
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

// 2. Listen for image generation requests from content.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "generate_image") {
    fetchCloudflareImage(request.prompt, request.accountId, request.apiToken)
      .then(imageUrl => sendResponse({ success: true, imageUrl: imageUrl }))
      .catch(error => sendResponse({ success: false, error: error.message }));
      
    return true; // Indicates an asynchronous response
  }
});

// 3. The Cloudflare fetch function (runs in the background to avoid CORS)
async function fetchCloudflareImage(prompt, accountId, apiToken) {
  const styleModifiers = ", anime visual novel background, highly detailed, scenic, clean line art, no humans, no animals, empty landscape, no characters";
  const fullPrompt = prompt + styleModifiers;
  const model = "@cf/black-forest-labs/flux-1-schnell";
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt: fullPrompt })
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.errors?.[0]?.message || "Failed to generate image via Cloudflare");
  }

  return `data:image/jpeg;base64,${data.result.image}`;
}
