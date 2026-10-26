let cachedImages = [];
let cachedAudio = [];

// Weather Engine Variables
let canvas, ctx;
let animationId;
let particles = [];
let currentEffect = "none";
let lightningInterval = null;
let currentBackground = "";
let currentMusic = "";
let lastDecision = null; // AI Memory

// --- 0. FETCH ASSETS EARLY ---
(async function loadAssetsEarly() {
  try {
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    cachedImages = data.images || [];
    cachedAudio = data.audio || [];
    populateManualDropdowns();
  } catch (e) {
    console.error("Failed to load assets.json early:", e);
  }
})();

(function () {
  // --- 1. INJECT UI ---
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

    <label>Background Blur (<span id="blur-val">10</span>px)</label>
    <input type="range" id="set-blur" min="0" max="30" value="10" />
    
    <label>Background Dimness (<span id="dim-val">40</span>%)</label>
    <input type="range" id="set-dim" min="0" max="90" value="40" />
    
    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:10px;">
      <input type="checkbox" id="set-manual-mode" /> 
      <span style="color:#fff; font-size:13px;">Enable Manual Mode</span>
    </label>

    <div id="manual-controls" style="display: none; flex-direction: column; gap: 12px; margin-top: 10px;">
      <label>Background</label>
      <select id="manual-bg"></select>
      
      <label>Audio</label>
      <select id="manual-audio"></select>
      
      <label>Weather Effect</label>
      <select id="manual-effect">
        <option value="none">none</option>
        <option value="rain">rain</option>
        <option value="fog">fog</option>
        <option value="thunderstorm">thunderstorm</option>
        <option value="fiery">fiery</option>
        <option value="snow">snow</option>
        <option value="blizzard">blizzard</option>
      </select>
    </div>

    <button id="save-settings" style="margin-top: 10px;">Save</button>
    <button id="test-ai-btn">Test Connection</button>
  `;

  document.body.appendChild(uiWrapper);
  document.body.appendChild(settingsMenu);

  // --- 2. SETUP BACKGROUND & WEATHER DOM ---
  const bgWrapper = document.createElement("div");
  bgWrapper.id = "ambient-bg-wrapper";
  bgWrapper.innerHTML = `
    <div class="ambient-bg-img" id="bg-layer-1"></div>
    <div class="ambient-bg-img" id="bg-layer-2"></div>
    <div id="ambient-dim-overlay"></div>
  `;
  document.body.appendChild(bgWrapper);

  canvas = document.createElement("canvas");
  canvas.id = "ambient-weather-canvas";
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");

  const fogOverlay = document.createElement("div");
  fogOverlay.id = "ambient-fog-overlay";
  document.body.appendChild(fogOverlay);

  const lightningOverlay = document.createElement("div");
  lightningOverlay.id = "ambient-lightning-overlay";
  document.body.appendChild(lightningOverlay);

  const fieryOverlay = document.createElement("div");
  fieryOverlay.id = "ambient-fiery-overlay";
  document.body.appendChild(fieryOverlay);

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // --- 3. LOAD SETTINGS ---
  document.getElementById("set-api-key").value = localStorage.getItem("ambient_api_key") || "";
  document.getElementById("set-model").value = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  document.getElementById("set-proxy").value = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";
  
  const savedBlur = localStorage.getItem("ambient_blur") || "10";
  const savedDim = localStorage.getItem("ambient_dim") || "40";
  document.getElementById("set-blur").value = savedBlur;
  document.getElementById("set-dim").value = savedDim;
  document.getElementById("blur-val").textContent = savedBlur;
  document.getElementById("dim-val").textContent = savedDim;
  
  applyVisualSettings(savedBlur, savedDim);

  const manualCheckbox = document.getElementById("set-manual-mode");
  manualCheckbox.checked = localStorage.getItem("ambient_manual_mode") === "true";
  document.getElementById("manual-controls").style.display = manualCheckbox.checked ? "flex" : "none";

  // --- 4. EVENT LISTENERS ---
  settingsBtn.addEventListener("click", () => {
    settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("set-blur").addEventListener("input", (e) => {
    document.getElementById("blur-val").textContent = e.target.value;
    applyVisualSettings(e.target.value, document.getElementById("set-dim").value);
  });
  
  document.getElementById("set-dim").addEventListener("input", (e) => {
    document.getElementById("dim-val").textContent = e.target.value;
    applyVisualSettings(document.getElementById("set-blur").value, e.target.value);
  });

  manualCheckbox.addEventListener("change", (e) => {
    const isManual = e.target.checked;
    localStorage.setItem("ambient_manual_mode", isManual);
    document.getElementById("manual-controls").style.display = isManual ? "flex" : "none";
  });

  document.getElementById("manual-bg").addEventListener("change", (e) => applyAmbience({ background: e.target.value }));
  document.getElementById("manual-audio").addEventListener("change", (e) => applyAmbience({ music: e.target.value }));
  document.getElementById("manual-effect").addEventListener("change", (e) => applyAmbience({ effect: e.target.value }));

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_blur", document.getElementById("set-blur").value);
    localStorage.setItem("ambient_dim", document.getElementById("set-dim").value);
    settingsMenu.style.display = "none";
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an API key first.");
    let actualChat = getLatestChatContext() || "The group steps into a dark, gloomy forest. Rain begins to fall.";
    await askAI(actualChat, cachedImages, cachedAudio, apiKey);
  });

  // --- 5. OVERLAY & AUDIO ---
  const overlay = document.createElement("div");
  overlay.id = "janitor-init-overlay";
  overlay.textContent = "[ initialize chat ]";
  document.body.appendChild(overlay);

  const audio = new Audio();
  audio.id = "ambient-audio-player";
  audio.loop = true;
  audio.volume = 0; 
  audio.style.display = "none";
  document.body.appendChild(audio);

  overlay.addEventListener("click", function () {
    overlay.classList.add("fade-out");
    setTimeout(() => overlay.remove(), 500);
  });

  // --- 6. LISTEN FOR NETWORK TRIGGERS (Debounced) ---
  let networkDebounce = null;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "chat_updated") {
      // Ignore if manual mode is enabled
      if (localStorage.getItem("ambient_manual_mode") === "true") return;

      // Clear any existing timer
      clearTimeout(networkDebounce);
      
      // Wait 1 second after the *last* message save event before scraping
networkDebounce = setTimeout(() => {
  console.log("⚡ Messages endpoint caught. Scraping finalized chat...");
  
        let currentText = getLatestChatContext();
        if (currentText) {
          const apiKey = localStorage.getItem("ambient_api_key");
          if (apiKey) askAI(currentText, cachedImages, cachedAudio, apiKey);
        }
      }, 1000); 
    }
  });
})();

// --- HELPER: Live Visual Settings ---
function applyVisualSettings(blur, dim) {
  document.documentElement.style.setProperty('--ambient-blur', `${blur}px`);
  document.documentElement.style.setProperty('--ambient-dim', dim / 100);
}

// --- HELPER: Populate Dropdowns ---
function populateManualDropdowns() {
  const bgSelect = document.getElementById("manual-bg");
  const audioSelect = document.getElementById("manual-audio");
  if (!bgSelect || !audioSelect) return;
  bgSelect.innerHTML = cachedImages.map(img => `<option value="${img}">${img}</option>`).join('');
  audioSelect.innerHTML = cachedAudio.map(aud => `<option value="${aud}">${aud}</option>`).join('');
}

function resizeCanvas() {
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
}

// --- SCRAPER ---
function getLatestChatContext() {
  const messages = document.querySelectorAll('li[class*="messageDisplayWrapper"]');
  if (messages.length === 0) return null;
  const recentMessages = Array.from(messages).slice(-3);
  let contextText = "";
  recentMessages.forEach(msg => {
    const nameEl = msg.querySelector('[class*="nameText"]');
    const name = nameEl ? nameEl.innerText.trim() : "Unknown";
    const textContainer = msg.querySelector('.css-7w4zgl') || msg.querySelector('[class*="messageBody"]');
    const text = textContainer ? textContainer.innerText.trim() : msg.innerText.trim();
    contextText += `[${name}]: ${text}\n\n`;
  });
  return contextText.trim();
}

function setIndicator(state) {
  const ind = document.getElementById("ambient-indicator");
  if (ind) ind.className = state;
}

// --- AI FUNCTION ---
async function askAI(chatText, availableImages, availableAudio, apiKey) {
  setIndicator("generating"); 
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  let memoryPrompt = "";
  if (lastDecision) {
    memoryPrompt = `\nIMPORTANT MEMORY: The previous ambience was ${JSON.stringify(lastDecision)}. Do not change the background or music unless the chat explicitly describes a major scene change.`;
  }

  const systemPrompt = `You are an ambient engine. Based on the chat, choose a background, music, and weather effect. 
  Output ONLY a valid JSON object with the exact keys "background", "music", "effect", and "reasoning". Do not output any markdown.
  "reasoning" should be a short, immersive sentence explaining why you chose these elements.
  Available backgrounds: ${JSON.stringify(availableImages)}
  Available music: ${JSON.stringify(availableAudio)}
  Available effects: ["none", "rain", "fog", "thunderstorm", "fiery", "snow", "blizzard"]${memoryPrompt}`;

  console.log("%c📤 SENDING CONTEXT TO AI:", "color: #00ffff; font-weight: bold;");
  console.log(chatText);

  try {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
      setIndicator("error"); setTimeout(() => setIndicator("idle"), 3000); return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 Raw AI Response:", aiMessage);
    
    try {
      const decision = JSON.parse(aiMessage);
      lastDecision = decision; 
      
      if (decision.reasoning) {
        console.log(`%c🧠 AI Reasoning: ${decision.reasoning}`, "color: #eab308; font-weight: bold;");
      }

      applyAmbience(decision);
      setIndicator("idle"); 
    } catch (e) {
      console.error("Failed to parse JSON:", e);
      setIndicator("error"); setTimeout(() => setIndicator("idle"), 3000);
    }
  } catch (e) {
    console.error("Fetch failed:", e);
    setIndicator("error"); setTimeout(() => setIndicator("idle"), 3000);
  }
}

// --- AMBIENCE ENGINE ---
function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  if (decision.background && decision.background !== currentBackground) {
    const oldBg = currentBackground;
    currentBackground = decision.background;
    const url = chrome.runtime.getURL(currentBackground);

    const layer1 = document.getElementById("bg-layer-1");
    const layer2 = document.getElementById("bg-layer-2");
    const activeLayer = layer1.classList.contains("active") ? layer1 : layer2;
    const inactiveLayer = activeLayer === layer1 ? layer2 : layer1;

    inactiveLayer.style.backgroundImage = `url("${url}")`;
    void inactiveLayer.offsetWidth; 

    activeLayer.classList.remove("active");
    inactiveLayer.classList.add("active");

    if (oldBg !== currentBackground) {
      extractDominantColor(url);
    }
  }

  if (decision.music && decision.music !== currentMusic) {
    currentMusic = decision.music;
    const newAudioUrl = chrome.runtime.getURL(currentMusic);
    crossfadeAudio(newAudioUrl);
  }

  if (decision.effect && decision.effect !== currentEffect) {
    setWeather(decision.effect);
  }
}

// --- COLOR EXTRACTOR ---
async function extractDominantColor(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, 1, 1);
    
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    
    const color = `rgb(${r}, ${g}, ${b})`;
    const colorBright = `rgb(${Math.min(255, r+40)}, ${Math.min(255, g+40)}, ${Math.min(255, b+40)})`;

    const root = document.documentElement;
    root.style.setProperty('--colour-purple-500', color);
    root.style.setProperty('--colour-purple-400', colorBright);
    root.style.setProperty('--colour-purple-600', color);
    root.style.setProperty('--colour-pink-500', colorBright);
    root.style.setProperty('--bg-purple', color);
    root.style.setProperty('--accent-primary', color);
    root.style.setProperty('--button-primary', colorBright);
    root.style.setProperty('--border-active', colorBright);

    console.log(`🎨 Recolored UI to match background: ${color}`);
  } catch (e) {
    console.warn("Could not extract color (CORS issue?), skipping recolor.", e);
  }
}

// --- AUDIO CROSSFADER ---
function crossfadeAudio(newUrl) {
  const audio = document.getElementById("ambient-audio-player");
  if (!audio) return;

  let vol = audio.volume;
  const fadeOutInterval = setInterval(() => {
    vol -= 0.05;
    if (vol <= 0) {
      clearInterval(fadeOutInterval);
      audio.volume = 0;
      audio.src = newUrl;
      audio.play().catch(e => console.log("Play blocked:", e));
      
      let inVol = 0;
      const fadeInInterval = setInterval(() => {
        inVol += 0.05;
        if (inVol >= 0.5) {
          clearInterval(fadeInInterval);
          audio.volume = 0.5;
        } else {
          audio.volume = inVol;
        }
      }, 50);
    } else {
      audio.volume = vol;
    }
  }, 50);
}

// --- WEATHER ENGINE ---
function setWeather(effect) {
  currentEffect = effect;
  console.log("Setting Weather:", effect);
  
  canvas.style.opacity = 0;
  setTimeout(() => {
    cancelAnimationFrame(animationId);
    particles = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const fogOverlay = document.getElementById("ambient-fog-overlay");
    const fieryOverlay = document.getElementById("ambient-fiery-overlay");
    
    fogOverlay.style.opacity = 0;
    fieryOverlay.style.opacity = 0;
    if (lightningInterval) clearInterval(lightningInterval);

    if (effect === "none") { canvas.style.opacity = 1; return; }

    if (effect === "fog") {
      fogOverlay.style.opacity = 1;
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "fiery") {
      fieryOverlay.style.opacity = 1;
      for (let i = 0; i < 60; i++) particles.push(new Particle("ember"));
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "thunderstorm") {
      for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
      animateWeather();
      canvas.style.opacity = 1;
      lightningInterval = setInterval(() => {
        if (Math.random() > 0.7) {
          const lightningOverlay = document.getElementById("ambient-lightning-overlay");
          lightningOverlay.style.opacity = Math.random() * 0.5 + 0.3;
          setTimeout(() => lightningOverlay.style.opacity = 0, 100);
        }
      }, 4000);
      return;
    }

    if (effect === "rain") {
      for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "snow") {
      for (let i = 0; i < 100; i++) particles.push(new Particle("snow"));
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "blizzard") {
      for (let i = 0; i < 250; i++) particles.push(new Particle("blizzard"));
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }
  }, 1500); 
}

class Particle {
  constructor(type) {
    this.type = type;
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    
    if (type === "rain") {
      this.vy = Math.random() * 8 + 10; this.vx = -2; this.length = Math.random() * 20 + 10;
    } else if (type === "snow") {
      this.vy = Math.random() * 1.5 + 1; this.vx = Math.random() * 1 - 0.5; this.radius = Math.random() * 3 + 1;
    } else if (type === "blizzard") {
      this.vy = Math.random() * 4 + 3; this.vx = Math.random() * 4 - 2; this.radius = Math.random() * 3 + 1;
    } else if (type === "ember") {
      this.y = canvas.height + Math.random() * 100; this.vy = -(Math.random() * 1.5 + 0.5); this.vx = Math.random() * 1 - 0.5; this.radius = Math.random() * 2 + 1; this.opacity = Math.random();
    }
  }

  update() {
    this.x += this.vx; this.y += this.vy;
    if (this.type === "rain" && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if ((this.type === "snow" || this.type === "blizzard") && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if (this.type === "ember" && this.y < -20) { this.y = canvas.height + 20; this.x = Math.random() * canvas.width; }
  }

  draw() {
    if (this.type === "rain") {
      ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(this.x + this.vx, this.y + this.length);
      ctx.strokeStyle = "rgba(150, 180, 255, 0.5)"; ctx.lineWidth = 1.5; ctx.stroke();
    } else if (this.type === "snow" || this.type === "blizzard") {
      ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${this.type === "blizzard" ? 0.8 : 0.6})`; ctx.fill();
    } else if (this.type === "ember") {
      ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, ${Math.floor(Math.random() * 100 + 50)}, 0, ${this.opacity})`; ctx.fill();
    }
  }
}

function animateWeather() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => { p.update(); p.draw(); });
  animationId = requestAnimationFrame(animateWeather);
}
