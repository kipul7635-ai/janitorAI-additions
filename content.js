let refreshInterval = null; 
let cachedImages = [];
let cachedAudio = [];

(function () {
  // --- 1. INJECT UI IMMEDIATELY ---
  const uiWrapper = document.createElement("div");
  uiWrapper.id = "ambient-ui-wrapper";

  const settingsBtn = document.createElement("button");
  settingsBtn.id = "ambient-settings-btn";
  settingsBtn.innerHTML = "⚙️";

  const indicator = document.createElement("div");
  indicator.id = "ambient-indicator";
  indicator.className = "idle";

  uiWrapper.appendChild(settingsBtn);
  uiWrapper.appendChild(indicator);

  const settingsMenu = document.createElement("div");
  settingsMenu.id = "ambient-settings-menu";
  settingsMenu.innerHTML = `
    <h2>Ambient Engine</h2>
    <label>API Key</label>
    <input type="password" id="set-api-key" placeholder="sk-or-v1-..." />
    
    <label>Model</label>
    <input type="text" id="set-model" placeholder="nvidia/nemotron-3-ultra-550b-a55b:free" />
    
    <label>Proxy URL</label>
    <input type="text" id="set-proxy" value="https://openrouter.ai/api/v1/chat/completions" />
    
    <label>Refresh Frequency (Seconds)</label>
    <input type="number" id="set-frequency" value="10" min="5" />
    
    <button id="save-settings">Save</button>
    <button id="test-ai-btn">Test Connection</button>
  `;

  document.body.appendChild(uiWrapper);
  document.body.appendChild(settingsMenu);

  // Load settings
  document.getElementById("set-api-key").value = localStorage.getItem("ambient_api_key") || "";
  document.getElementById("set-model").value = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  document.getElementById("set-proxy").value = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";
  document.getElementById("set-frequency").value = localStorage.getItem("ambient_frequency") || "10";

  // Menu toggles
  settingsBtn.addEventListener("click", () => {
    settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_frequency", document.getElementById("set-frequency").value.trim());
    settingsMenu.style.display = "none";
    console.log("✅ Settings saved.");
    
    startAmbientLoop();
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an API key first.");
    await askAI("The group steps into a dark, gloomy forest.", cachedImages, cachedAudio, apiKey);
  });


  // --- 2. INJECT OVERLAY & AUDIO ---
  const overlay = document.createElement("div");
  overlay.id = "janitor-init-overlay";
  overlay.textContent = "[ initialize chat ]";
  document.body.appendChild(overlay);

  const audio = new Audio();
  audio.loop = true;
  audio.volume = 0.5;
  audio.style.display = "none";
  document.body.appendChild(audio);


  // --- 3. ON CLICK / INITIALIZE ---
  overlay.addEventListener("click", async function () {
    overlay.classList.add("fade-out");
    setTimeout(() => overlay.remove(), 500);

    try {
      const res = await fetch(chrome.runtime.getURL("assets.json"));
      const data = await res.json();
      cachedImages = data.images || [];
      cachedAudio = data.audio || [];

      if (cachedAudio.length > 0) {
        audio.src = chrome.runtime.getURL(cachedAudio[0]);
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }

      startAmbientLoop();
      
    } catch (e) {
      console.error("Error during initialization:", e);
    }
  });
})();


// --- 4. THE GUARANTEED POLLING LOOP ---
function startAmbientLoop() {
  if (refreshInterval) clearInterval(refreshInterval);

  const freq = parseInt(localStorage.getItem("ambient_frequency")) || 10;
  console.log(`⏱️ Starting GUARANTEED ambient loop every ${freq} seconds.`);

  refreshInterval = setInterval(() => {
    // 1. Try to get the latest message
    let currentText = getLatestAIMessage();
    
    // 2. Fallback so the AI always has something to read (in case the scraper fails)
    if (!currentText) {
        currentText = "No new text detected. Maintain the current atmosphere.";
    }

    // 3. Fire the API unconditionally
    const apiKey = localStorage.getItem("ambient_api_key");
    if (apiKey) {
      askAI(currentText, cachedImages, cachedAudio, apiKey);
    }

  }, freq * 1000);
}

// --- HELPER: Get Last Message ---
function getLatestAIMessage() {
  const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
  if (!scroller) return null;
  
  const textBlocks = scroller.querySelectorAll('div');
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const text = textBlocks[i].innerText.trim();
    if (text.length > 30 && !text.includes("Press button to send chat") && !text.includes("Token")) {
      return text;
    }
  }
  return null;
}

// --- HELPER: Update Indicator ---
function setIndicator(state) {
  const ind = document.getElementById("ambient-indicator");
  if (ind) ind.className = state;
}


// --- 5. THE AI FUNCTION ---
async function askAI(chatText, availableImages, availableAudio, apiKey) {
  setIndicator("generating"); // Turn Green
  
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  const systemPrompt = `You are an ambient engine. Based on the chat, choose a background and music. 
  Output ONLY a valid JSON object with the exact keys "background" and "music". Do not output any markdown or extra text.
  Available backgrounds: ${JSON.stringify(availableImages)}
  Available music: ${JSON.stringify(availableAudio)}`;

  try {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Recent chat:\n${chatText}` }
        ]
      })
    });

    const result = await response.json();
    
    if (result.error) {
      console.error("API Error:", result.error);
      setIndicator("error"); 
      setTimeout(() => setIndicator("idle"), 3000); 
      return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 Orchestral AI responded with:", aiMessage);
    
    try {
      const decision = JSON.parse(aiMessage);
      console.log("✅ Parsed decision:", decision);
      setIndicator("idle"); // Success
      
      // NEXT STEP: applyAmbience(decision);
      
    } catch (e) {
      console.error("Failed to parse AI JSON:", e);
      setIndicator("error");
      setTimeout(() => setIndicator("idle"), 3000);
    }

  } catch (e) {
    console.error("Fetch to API failed:", e);
    setIndicator("error");
    setTimeout(() => setIndicator("idle"), 3000);
  }
}
