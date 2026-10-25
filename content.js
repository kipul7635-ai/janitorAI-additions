let refreshInterval = null; 
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

  // Setup Weather DOM Elements
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

  settingsBtn.addEventListener("click", () => {
    settingsMenu.style.display = settingsMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_frequency", document.getElementById("set-frequency").value.trim());
    settingsMenu.style.display = "none";
    startAmbientLoop();
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an API key first.");
    await askAI("The group steps into a dark, gloomy forest. Rain begins to fall.", cachedImages, cachedAudio, apiKey);
  });

  // --- 2. INJECT OVERLAY & AUDIO ---
  const overlay = document.createElement("div");
  overlay.id = "janitor-init-overlay";
  overlay.textContent = "[ initialize chat ]";
  document.body.appendChild(overlay);

  const audio = new Audio();
  audio.id = "ambient-audio-player";
  audio.loop = true;
  audio.volume = 0.5;
  audio.style.display = "none";
  document.body.appendChild(audio);

  overlay.addEventListener("click", async function () {
    overlay.classList.add("fade-out");
    setTimeout(() => overlay.remove(), 500);

    try {
      const res = await fetch(chrome.runtime.getURL("assets.json"));
      const data = await res.json();
      cachedImages = data.images || [];
      cachedAudio = data.audio || [];
      startAmbientLoop();
    } catch (e) {
      console.error("Error during initialization:", e);
    }
  });
})();

// --- HELPER: Canvas Resizing ---
function resizeCanvas() {
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
}

// --- 4. THE POLLING LOOP ---
function startAmbientLoop() {
  if (refreshInterval) clearInterval(refreshInterval);
  const freq = parseInt(localStorage.getItem("ambient_frequency")) || 10;

  refreshInterval = setInterval(() => {
    let currentText = getLatestAIMessage();
    if (!currentText) currentText = "No new text detected. Maintain the current atmosphere.";
    
    const apiKey = localStorage.getItem("ambient_api_key");
    if (apiKey) askAI(currentText, cachedImages, cachedAudio, apiKey);
  }, freq * 1000);
}

function getLatestAIMessage() {
  const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
  if (!scroller) return null;
  const textBlocks = scroller.querySelectorAll('div');
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const text = textBlocks[i].innerText.trim();
    if (text.length > 30 && !text.includes("Press button to send chat") && !text.includes("Token")) return text;
  }
  return null;
}

function setIndicator(state) {
  const ind = document.getElementById("ambient-indicator");
  if (ind) ind.className = state;
}


// --- 5. THE AI FUNCTION ---
async function askAI(chatText, availableImages, availableAudio, apiKey) {
  setIndicator("generating"); 
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  const systemPrompt = `You are an ambient engine. Based on the chat, choose a background, music, and weather effect. 
  Output ONLY a valid JSON object with the exact keys "background", "music", and "effect". Do not output any markdown.
  Available backgrounds: ${JSON.stringify(availableImages)}
  Available music: ${JSON.stringify(availableAudio)}
  Available effects: ["none", "rain", "fog", "thunderstorm", "fiery", "snow", "blizzard"]`;

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
    console.log("🤖 Orchestral AI responded:", aiMessage);
    
    try {
      const decision = JSON.parse(aiMessage);
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


// --- 6. APPLY AMBIENCE (Background, Music, Effects) ---
function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  // 1. Apply Background
  if (decision.background && decision.background !== currentBackground) {
    currentBackground = decision.background;
    const url = chrome.runtime.getURL(currentBackground);
    let bgStyle = document.getElementById("ambient-bg-style");
    if (!bgStyle) {
      bgStyle = document.createElement("style");
      bgStyle.id = "ambient-bg-style";
      document.head.appendChild(bgStyle);
    }
    bgStyle.textContent = `
      html, body {
        background-image: url("${url}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-attachment: fixed !important;
        background-color: transparent !important;
      }
      #root, #__next, main, [class*="layout"], [class*="Layout"], [class*="container"], [class*="wrapper"], [data-testid="virtuoso-scroller"] { background: transparent !important; }
    `;
  }

  // 2. Apply Music
  if (decision.music && decision.music !== currentMusic) {
    currentMusic = decision.music;
    const audio = document.getElementById("ambient-audio-player");
    if (audio) {
      audio.src = chrome.runtime.getURL(currentMusic);
      audio.play().catch(e => console.log("Audio play blocked:", e));
    }
  }

  // 3. Apply Weather Effect
  if (decision.effect && decision.effect !== currentEffect) {
    setWeather(decision.effect);
  }
}


// --- 7. THE WEATHER ENGINE ---
function setWeather(effect) {
  currentEffect = effect;
  console.log("Setting Weather:", effect);
  
  // Reset everything
  cancelAnimationFrame(animationId);
  particles = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const fogOverlay = document.getElementById("ambient-fog-overlay");
  const fieryOverlay = document.getElementById("ambient-fiery-overlay");
  const lightningOverlay = document.getElementById("ambient-lightning-overlay");
  
  fogOverlay.style.display = "none";
  fieryOverlay.style.display = "none";
  lightningOverlay.style.opacity = 0;
  if (lightningInterval) clearInterval(lightningInterval);

  if (effect === "none") return;

  if (effect === "fog") {
    fogOverlay.style.display = "block";
    return;
  }

  if (effect === "fiery") {
    fieryOverlay.style.display = "block";
    // Create embers
    for (let i = 0; i < 60; i++) particles.push(new Particle("ember"));
    animateWeather();
    return;
  }

  if (effect === "thunderstorm") {
    for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
    animateWeather();
    // Lightning logic
    lightningInterval = setInterval(() => {
      if (Math.random() > 0.7) {
        lightningOverlay.style.opacity = Math.random() * 0.5 + 0.3;
        setTimeout(() => lightningOverlay.style.opacity = 0, 100);
        setTimeout(() => {
            lightningOverlay.style.opacity = Math.random() * 0.4 + 0.2;
            setTimeout(() => lightningOverlay.style.opacity = 0, 150);
        }, 200);
      }
    }, 4000);
    return;
  }

  if (effect === "rain") {
    for (let i = 0; i < 150; i++) particles.push(new Particle("rain"));
    animateWeather();
    return;
  }

  if (effect === "snow") {
    for (let i = 0; i < 100; i++) particles.push(new Particle("snow"));
    animateWeather();
    return;
  }

  if (effect === "blizzard") {
    for (let i = 0; i < 250; i++) particles.push(new Particle("blizzard"));
    animateWeather();
    return;
  }
}

// Particle Class
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
      this.vx = Math.random() * 4 - 2; // Strong wind
      this.radius = Math.random() * 3 + 1;
    } else if (type === "ember") {
      this.y = canvas.height + Math.random() * 100; // Start at bottom
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
