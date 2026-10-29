// background.js

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (details.method === "POST" && details.url.includes("/messages")) {
      if (details.requestBody && details.requestBody.raw) {
        try {
          const decoder = new TextDecoder("utf-8");
          const rawBody = decoder.decode(details.requestBody.raw[0].bytes);
          const bodyJson = JSON.parse(rawBody);
          
          if (bodyJson.is_bot === true) {
            if (details.tabId !== -1) {
              chrome.tabs.sendMessage(details.tabId, { action: "chat_updated" }).catch(() => {});
            }
          }
        } catch (e) {}
      }
    }
  },
  { urls: ["*://*.janitorai.com/*"] },
  ["requestBody"]
);

// --- Re-inject after in-site navigation ---
// JanitorAI is a single-page app: opening a chat from the homepage / a character page changes the URL
// WITHOUT loading the page, so manifest content_scripts never run and the extension "randomly" does
// nothing until you hit refresh. content.js guards against double-loading, so injecting again is safe.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!/^https?:\/\/([^/]+\.)?janitorai\.com\/chats\//.test(changeInfo.url)) return;
  chrome.scripting.insertCSS({ target: { tabId }, files: ["styles.css"] }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "generate_image") {
    fetchImage(request.prompt, request.accountId, request.apiToken)
      .then(result => sendResponse({ success: true, imageUrl: result.imageUrl, provider: result.provider }))
      .catch(error => sendResponse({ success: false, error: error.message }));
      
    return true;
  }
});

async function fetchImage(prompt, accountId, apiToken) {
  const styleModifiers = ", safe for work, family friendly, environment concept art, background scenery, anime visual novel background, eye-level wide view, lighting that matches the described time of day, highly detailed, clean line art, empty unoccupied scene, no humans, no animals, no creatures, no characters, no people, no anatomy, empty landscape";
  const fullPrompt = prompt + styleModifiers;

  // --- ATTEMPT 1: CLOUDFLARE (FLUX) ---
  if (accountId && apiToken) {
    try {
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

      if (response.ok && data.success) {
        return { imageUrl: `data:image/jpeg;base64,${data.result.image}`, provider: 'cloudflare' };
      } else {
        throw new Error(data.errors?.[0]?.message || "Cloudflare generation failed");
      }
    } catch (error) {
      console.warn("⚠️ Cloudflare generation failed. Falling back to Pollinations. Reason:", error.message);
    }
  }

  // --- ATTEMPT 2: POLLINATIONS (Fallback) ---
  const seed = Math.floor(Math.random() * 100000);
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1080&height=1920&nologo=true&seed=${seed}`;
  
  console.log("🔄 Using Pollinations fallback:", pollinationsUrl);
  return { imageUrl: pollinationsUrl, provider: 'pollinations' };
}
