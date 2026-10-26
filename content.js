let refreshInterval = null; 
let cachedImages = [];
let cachedAudio = [];
let currentBackground = "";
let currentMusic = "";

// Weather Engine Variables
let canvas, ctx;
let animationId;
let particles = [];
let currentEffect = "none";
let lightningInterval = null;

// Audio Crossfading Variables
let activeAudio = new Audio();
let inactiveAudio = new Audio();
activeAudio.loop = true; inactiveAudio.loop = true;
activeAudio.volume = 0; inactiveAudio.volume = 0;
document.body.appendChild(activeAudio); document.body.appendChild(inactiveAudio);

// Background Layer Tracking
let currentBgLayer = null;
const colorCache = {};

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
    
    <label>Refresh Frequency (Seconds)</label>
    <input type="number" id="set-frequency" value="10" min="5" />
    
    <label>Background Blur <span id="val-blur">0</span>px</label>
    <input type="range" id="set-blur" min="0" max="20" value="0" />
    
    <label>Background Dimness <span id="val-dim">0</span>%</label>
    <input type="range" id="set-dim" min="0" max="100" value="0" />
    
    <label class="manual-toggle-wrapper" style="margin-top: 10px;">
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

  // Setup Weather DOM
  const bgContainer = document.createElement("div");
  bgContainer.id = "ambient-bg-container";
  document.body.appendChild(bgContainer);

  const bgDim = document.createElement("div");
  bgDim.id = "ambient-bg-dim";
  document.body.appendChild(bgDim);

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

  // Load settings
  document.getElementById("set-api-key").value = localStorage.getItem("ambient_api_key") || "";
  document.getElementById("set-model").value = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  document.getElementById("set-proxy").value = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";
  document.getElementById("set-frequency").value = localStorage.getItem("ambient_frequency") || "10";
  
  const savedBlur = localStorage.getItem("ambient_blur") || "0";
  const savedDim = localStorage.getItem("ambient_dim") || "0";
  document.getElementById("set-blur").value = savedBlur;
  document.getElementById("set-dim").value = savedDim;
  document.getElementById("val-blur").textContent = savedBlur;
  document.getElementById("val-dim").textContent = savedDim;
  document.documentElement.style.setProperty('--ambient-blur', `${savedBlur}px`);
  document.documentElement.style.setProperty('--ambient-dim', savedDim / 100);
  
  const manualCheckbox = document.getElementById("set-manual-mode");
  manualCheckbox.checked = localStorage.getItem("ambient_manual_mode") === "true";
  document.getElementById("manual-controls").style.display = manualCheckbox.checked ? "flex" : "none";

  // UI Events
  settingsBtn.addEventListener("click", () => {
    settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("set-blur").addEventListener("input", (e) => {
    document.documentElement.style.setProperty('--ambient-blur', `${e.target.value}px`);
    document.getElementById("val-blur").textContent = e.target.value;
  });

  document.getElementById("set-dim").addEventListener("input", (e) => {
    document.documentElement.style.setProperty('--ambient-dim', e.target.value / 100);
    document.getElementById("val-dim").textContent = e.target.value;
  });

  manualCheckbox.addEventListener("change", (e) => {
    const isManual = e.target.checked;
    localStorage.setItem("ambient_manual_mode", isManual);
    document.getElementById("manual-controls").style.display = isManual ? "flex" : "none";
    if (isManual) {
      if (refreshInterval) clearInterval(refreshInterval);
      console.log("⏸️ Manual Mode Enabled. Loop stopped.");
    } else {
      startAmbientLoop();
    }
  });

  document.getElementById("manual-bg").addEventListener("change", (e) => applyAmbience({ background: e.target.value }));
  document.getElementById("manual-audio").addEventListener("change", (e) => applyAmbience({ music: e.target.value }));
  document.getElementById("manual-effect").addEventListener("change", (e) => applyAmbience({ effect: e.target.value }));

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_frequency", document.getElementById("set-frequency").value.trim());
    localStorage.setItem("ambient_blur", document.getElementById("set-blur").value);
    localStorage.setItem("ambient_dim", document.getElementById("set-dim").value);
    settingsMenu.style.display = "none";
    startAmbientLoop();
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an API key first.");
    let actualChat = getLatestChatContext() || "The group steps into a dark, gloomy forest. Rain begins to fall.";
    await askAI(actualChat, cachedImages, cachedAudio, apiKey);
  });

  // Overlay
  const overlay = document.createElement("div");
  overlay.id = "janitor-init-overlay";
  overlay.textContent = "[ initialize chat ]";
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function () {
    overlay.classList.add("fade-out");
    setTimeout(() => overlay.remove(), 500);
    
    // Start initial audio safely
    if (cachedAudio.length > 0) {
      currentMusic = cachedAudio[0];
      const url = chrome.runtime.getURL(currentMusic);
      activeAudio.src = url; activeAudio.volume = 0.5; activeAudio.play().catch(()=>{});
      inactiveAudio.src = url; inactiveAudio.volume = 0; inactiveAudio.play().catch(()=>{});
    }
    startAmbientLoop();
  });
})();

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

function startAmbientLoop() {
  if (refreshInterval) clearInterval(refreshInterval);
  if (localStorage.getItem("ambient_manual_mode") === "true") return;

  const freq = parseInt(localStorage.getItem("ambient_frequency")) || 10;
  refreshInterval = setInterval(() => {
    let currentText = getLatestChatContext() || "No new text detected. Maintain the current atmosphere.";
    const apiKey = localStorage.getItem("ambient_api_key");
    if (apiKey) askAI(currentText, cachedImages, cachedAudio, apiKey);
  }, freq * 1000);
}

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

async function askAI(chatText, availableImages, availableAudio, apiKey) {
  setIndicator("generating"); 
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";
  
  // Memory injection: read previous state
  const prevDecision = localStorage.getItem("ambient_last_decision") || "None";

  const systemPrompt = `You are an ambient engine. Based on the chat, choose a background, music, and weather effect. 
  Output ONLY a valid JSON object with the exact keys "background", "music", "effect", and "reasoning". Do not output any markdown.
  "reasoning" should be a short, immersive sentence explaining why you chose these elements.
  
  Previously chosen state: ${prevDecision}
  If the chat context remains in the same location or situation, KEEP the previous state to avoid jarring changes.
  
  Available backgrounds: ${JSON.stringify(availableImages)}
  Available music: ${JSON.stringify(availableAudio)}
  Available effects: ["none", "rain", "fog", "thunderstorm", "fiery", "snow", "blizzard"]`;

  console.log("%c📤 SENDING CONTEXT TO AI:", "color: #00ffff; font-weight: bold; font-size: 14px;");
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
      if (decision.reasoning) console.log(`%c🧠 AI Reasoning: ${decision.reasoning}`, "color: #eab308; font-weight: bold;");
      
      // Save memory
      localStorage.setItem("ambient_last_decision", aiMessage);
      
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

// --- NEW: SEAMLESS BACKGROUND & COLOR EXTRACTION ---
function changeBackground(newBgPath) {
  const url = chrome.runtime.getURL(newBgPath);
  const newLayer = document.createElement("div");
  newLayer.className = "bg-layer";
  newLayer.style.backgroundImage = `url("${url}")`;
  
  const container = document.getElementById("ambient-bg-container");
  container.appendChild(newLayer);
  
  // Force reflow to trigger transition
  void newLayer.offsetWidth;
  newLayer.classList.add("active");
  
  if (currentBgLayer) {
    const oldLayer = currentBgLayer;
    oldLayer.classList.remove("active");
    setTimeout(() => oldLayer.remove(), 1600); // Wait for 1.5s transition
  }
  currentBgLayer = newLayer;
  
  extractThemeColor(url);
}

function extractThemeColor(imageUrl) {
  if (colorCache[imageUrl]) {
    document.documentElement.style.setProperty('--ambient-accent', colorCache[imageUrl]);
    return;
  }
  
  const img = new Image();
  img.crossOrigin = "Anonymous";
  img.src = imageUrl;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 50; canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 50, 50);
    const data = ctx.getImageData(0, 0, 50, 50).data;
    let r = 0, g = 0, b = 0, count = 0;
    
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
      if (brightness > 30 && brightness < 220) {
        r += data[i]; g += data[i+1]; b += data[i+2]; count++;
      }
    }
    
    if (count === 0) return;
    r = Math.min(255, Math.floor((r / count) * 1.2)); // Boost saturation
    g = Math.min(255, Math.floor((g / count) * 1.2));
    b = Math.min(255, Math.floor((b / count) * 1.2));
    
    const colorString = `rgb(${r}, ${g}, ${b})`;
    colorCache[imageUrl] = colorString;
    document.documentElement.style.setProperty('--ambient-accent', colorString);
  };
}

// --- NEW: AUDIO CROSSFADE ---
function crossfadeAudio(newMusicPath) {
  if (newMusicPath === currentMusic) return;
  currentMusic = newMusicPath;
  
  const url = chrome.runtime.getURL(newMusicPath);
  
  inactiveAudio.src = url;
  inactiveAudio.volume = 0;
  inactiveAudio.play().catch(e => console.log("Audio play blocked:", e));
  
  let step = 0;
  const fadeInterval = setInterval(() => {
    step++;
    const targetVol = 0.5;
    const currentInactiveVol = (step / 50) * targetVol;
    const currentActiveVol = targetVol - currentInactiveVol;
    
    activeAudio.volume = Math.max(0, currentActiveVol);
    inactiveAudio.volume = Math.min(targetVol, currentInactiveVol);
    
    if (step >= 50) {
      clearInterval(fadeInterval);
      activeAudio.pause();
      activeAudio.src = url;
      activeAudio.currentTime = inactiveAudio.currentTime;
      
      const temp = activeAudio;
      activeAudio = inactiveAudio;
      inactiveAudio = temp;
      activeAudio.volume = 0.5;
    }
  }, 50); // 50 steps * 50ms = 2.5 seconds crossfade
}

function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  if (decision.background && decision.background !== currentBackground) {
    currentBackground = decision.background;
    changeBackground(currentBackground);
  }

  if (decision.music && decision.music !== currentMusic) {
    crossfadeAudio(decision.music);
  }

  if (decision.effect && decision.effect !== currentEffect) {
    setWeather(decision.effect);
  }
}

// --- NEW: WEATHER TRANSITIONS ---
function setWeather(effect) {
  currentEffect = effect;
  console.log("Setting Weather:", effect);
  
  const cvs = document.getElementById("ambient-weather-canvas");
  const fog = document.getElementById("ambient-fog-overlay");
  const fire = document.getElementById("ambient-fiery-overlay");
  const light = document.getElementById("ambient-lightning-overlay");

  // Fade everything out
  cvs.style.opacity = 0;
  fog.style.opacity = 0;
  fire.style.opacity = 0;
  light.style.opacity = 0;

  // Wait for fade out (800ms), then swap and fade in
  setTimeout(() => {
      cancelAnimationFrame(animationId);
      particles = [];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      fog.style.display = "none";
      fire.style.display = "none";
      if (lightningInterval) clearInterval(lightningInterval);

      if (effect === "none") {
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "fog") {
          fog.style.display = "block";
          setTimeout(() => { fog.style.opacity = 0.6; }, 50); 
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "fiery") {
          fire.style.display = "block";
          setTimeout(() => { fire.style.opacity = 1; }, 50);
          for (let i = 0; i < 60; i++) particles.push(new Particle("ember"));
          animateWeather();
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "thunderstorm") {
          for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
          animateWeather();
          lightningInterval = setInterval(() => {
            if (Math.random() > 0.7) {
              light.style.opacity = Math.random() * 0.5 + 0.3;
              setTimeout(() => light.style.opacity = 0, 100);
              setTimeout(() => {
                  light.style.opacity = Math.random() * 0.4 + 0.2;
                  setTimeout(() => light.style.opacity = 0, 150);
              }, 200);
            }
          }, 4000);
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "rain") {
          for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
          animateWeather();
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "snow") {
          for (let i = 0; i < 100; i++) particles.push(new Particle("snow"));
          animateWeather();
          cvs.style.opacity = 1;
          return;
      }
      if (effect === "blizzard") {
          for (let i = 0; i < 250; i++) particles.push(new Particle("blizzard"));
          animateWeather();
          cvs.style.opacity = 1;
          return;
      }
  }, 800); 
}

class Particle {
  constructor(type) {
    this.type = type;
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    
    if (type === "rain") {
      this.vy = Math.random() * 8 + 10;
      this.vx = -2;
      this.length = Math.random() * 20 + 10;
    } else if (type === "snow") {
      this.vy = Math.random() * 1.5 + 1;
      this.vx = Math.random() * 1 - 0.5;
      this.radius = Math.random() * 3 + 1;
    } else if (type === "blizzard") {
      this.vy = Math.random() * 4 + 3;
      this.vx = Math.random() * 4 - 2;
      this.radius = Math.random() * 3 + 1;
    } else if (type === "ember") {
      this.y = canvas.height + Math.random() * 100;
      this.vy = -(Math.random() * 1.5 + 0.5);
      this.vx = Math.random() * 1 - 0.5;
      this.radius = Math.random() * 2 + 1;
      this.opacity = Math.random();
    }
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;

    if (this.type === "rain" && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if ((this.type === "snow" || this.type === "blizzard") && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if (this.type === "ember" && this.y < -20) { this.y = canvas.height + 20; this.x = Math.random() * canvas.width; }
  }

  draw() {
    if (this.type === "rain") {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + this.vx, this.y + this.length);
      ctx.strokeStyle = "rgba(150, 180, 255, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (this.type === "snow" || this.type === "blizzard") {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${this.type === "blizzard" ? 0.8 : 0.6})`;
      ctx.fill();
    } else if (this.type === "ember") {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, ${Math.floor(Math.random() * 100 + 50)}, 0, ${this.opacity})`;
      ctx.fill();
    }
  }
}

function animateWeather() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => {
    p.update();
    p.draw();
  });
  animationId = requestAnimationFrame(animateWeather);
}
