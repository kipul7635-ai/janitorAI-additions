(async function () {
  try {
    // --- 1. SETUP SETTINGS UI ---
    const settingsBtn = document.createElement("button");
    settingsBtn.id = "ambient-settings-btn";
    settingsBtn.textContent = "⚙️ Ambient Settings";

    const settingsMenu = document.createElement("div");
    settingsMenu.id = "ambient-settings-menu";
    settingsMenu.innerHTML = `
      <h2>Ambient Engine Settings</h2>
      
      <label>API Key</label>
      <input type="password" id="set-api-key" placeholder="sk-or-v1-..." />
      
      <label>Model</label>
      <input type="text" id="set-model" placeholder="meta-llama/llama-3-8b-instruct:free" />
      
      <label>Proxy URL</label>
      <input type="text" id="set-proxy" value="https://openrouter.ai/api/v1/chat/completions" />
      
      <button id="save-settings">Save & Close</button>
    `;

    // Attach UI to the page
    document.body.appendChild(settingsBtn);
    document.body.appendChild(settingsMenu);

    // Load saved settings into inputs
    const savedKey = localStorage.getItem("ambient_api_key") || "";
    const savedModel = localStorage.getItem("ambient_model") || "meta-llama/llama-3-8b-instruct:free";
    const savedProxy = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

    document.getElementById("set-api-key").value = savedKey;
    document.getElementById("set-model").value = savedModel;
    document.getElementById("set-proxy").value = savedProxy;

    // Toggle Menu
    settingsBtn.addEventListener("click", () => {
      settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
    });

    // Save Settings
    document.getElementById("save-settings").addEventListener("click", () => {
      localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
      localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
      localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
      settingsMenu.style.display = "none";
      console.log("✅ Settings saved.");
    });


    // --- 2. SETUP OVERLAY & AUDIO ---
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    const images = data.images || [];
    const audioFiles = data.audio || [];

    const audio = new Audio();
    audio.loop = true;
    audio.volume = 0.5;
    audio.style.display = "none";
    document.body.appendChild(audio);

    const overlay = document.createElement("div");
    overlay.id = "janitor-init-overlay";
    overlay.textContent = "[ initialize chat ]";
    document.body.appendChild(overlay);

    // --- 3. ON CLICK / INITIALIZE ---
    overlay.addEventListener("click", function () {
      overlay.classList.add("fade-out");
      setTimeout(() => overlay.remove(), 500);

      // Play default/first audio
      if (audioFiles.length > 0) {
        audio.src = chrome.runtime.getURL(audioFiles[0]);
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }

      // Check if API key exists before asking AI
      const apiKey = localStorage.getItem("ambient_api_key");
      if (apiKey) {
        const testChat = "The group steps into a dark, gloomy forest. Rain begins to fall. 'We should find shelter,' the rogue whispers.";
        askAI(testChat, images, audioFiles, apiKey);
      } else {
        console.log("No API key set. Open settings (⚙️) to add one.");
      }
    });

  } catch (e) {
    console.error("Theme error:", e);
  }
})();

// --- 4. THE AI FUNCTION ---
async function askAI(chatText, availableImages, availableAudio, apiKey) {
  console.log("🧠 Asking AI...");
  
  const model = localStorage.getItem("ambient_model") || "meta-llama/llama-3-8b-instruct:free";
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
      return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 AI responded with:", aiMessage);
    
    try {
      const decision = JSON.parse(aiMessage);
      console.log("✅ Parsed decision:", decision);
    } catch (e) {
      console.error("Failed to parse AI JSON:", e);
    }

  } catch (e) {
    console.error("Fetch to API failed:", e);
  }
}
