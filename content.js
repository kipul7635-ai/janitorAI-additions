(function () {
  // --- 1. INJECT UI IMMEDIATELY ---
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
    <button id="test-ai-btn">⚡ Test AI Connection</button>
  `;

  document.body.appendChild(settingsBtn);
  document.body.appendChild(settingsMenu);

  // Load settings
  document.getElementById("set-api-key").value = localStorage.getItem("ambient_api_key") || "";
  document.getElementById("set-model").value = localStorage.getItem("ambient_model") || "meta-llama/llama-3-8b-instruct:free";
  document.getElementById("set-proxy").value = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  // Menu toggles
  settingsBtn.addEventListener("click", () => {
    settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    settingsMenu.style.display = "none";
    console.log("✅ Settings saved.");
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an API key first.");
    
    // Fetch assets dynamically for the test
    try {
      const res = await fetch(chrome.runtime.getURL("assets.json"));
      const data = await res.json();
      const testChat = "The group steps into a dark, gloomy forest. Rain begins to fall.";
      await askAI(testChat, data.images || [], data.audio || [], apiKey);
    } catch (e) {
      console.error("Could not load assets.json for test", e);
    }
  });


  // --- 2. INJECT OVERLAY IMMEDIATELY ---
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
      const images = data.images || [];
      const audioFiles = data.audio || [];

      if (audioFiles.length > 0) {
        audio.src = chrome.runtime.getURL(audioFiles[0]);
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }

      const apiKey = localStorage.getItem("ambient_api_key");
      if (apiKey) {
        const testChat = "The group steps into a dark, gloomy forest. Rain begins to fall.";
        askAI(testChat, images, audioFiles, apiKey);
      }
    } catch (e) {
      console.error("Error during initialization:", e);
    }
  });
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
      alert("API Error: " + result.error.message);
      return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 AI responded with:", aiMessage);
    
    try {
      const decision = JSON.parse(aiMessage);
      console.log("✅ Parsed decision:", decision);
      alert("AI Decided:\n" + JSON.stringify(decision, null, 2));
    } catch (e) {
      console.error("Failed to parse AI JSON:", e);
      alert("AI didn't return valid JSON. Check console.");
    }

  } catch (e) {
    console.error("Fetch to API failed:", e);
    alert("Network error. Check console.");
  }
}
