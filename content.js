let cachedAudio = [];

// Weather Engine Variables
let canvas, ctx;
let animationId = null;
let particles = [];
let currentEffect = "none";
let lightningInterval = null;
let currentBackgroundPrompt = "";
let currentMusic = "";
let lastDecision = null; 
let isGeneratingBg = false;
let isAnimating = false; // Prevents scroll freezes

// --- 0. FETCH AUDIO ASSETS EARLY ---
(async function loadAssetsEarly() {
  try {
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    cachedAudio = data.audio || [];
    populateManualDropdowns();
  } catch (e) {
    console.error("Failed to load assets.json early:", e);
  }
})();

(function () {
  // --- CHANGE TAB ICON (FAVICON) ---
  try {
    const faviconUrl = chrome.runtime.getURL("images/tabIcon.png");
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = faviconUrl;
  } catch (e) {
    console.warn("Could not load tab icon:", e);
  }

  // --- 1. INJECT UI ---
  const uiWrapper = document.createElement("div");
  uiWrapper.id = "ambient-ui-wrapper";

  const settingsBtn = document.createElement("button");
  settingsBtn.id = "ambient-settings-btn";
  settingsBtn.innerHTML = "⚙️";

  const indicators = document.createElement("div");
  indicators.id = "ambient-indicators";
  indicators.innerHTML = `
    <div class="dot idle" id="dot-orch"></div>
    <div class="dot idle" id="dot-cf"></div>
    <div class="dot idle" id="dot-poll"></div>
  `;

  uiWrapper.appendChild(settingsBtn);
  uiWrapper.appendChild(indicators);

  const settingsMenu = document.createElement("div");
  settingsMenu.id = "ambient-settings-menu";
  settingsMenu.innerHTML = `
    <h2>Ambient Engine</h2>
    <label>OpenRouter API Key</label>
    <input type="password" id="set-api-key" placeholder="sk-or-v1-..." />
    
    <label>OpenRouter Model</label>
    <input type="text" id="set-model" placeholder="nvidia/nemotron-3-ultra-550b-a55b:free" />
    
    <label>OpenRouter Proxy URL</label>
    <input type="text" id="set-proxy" value="https://openrouter.ai/api/v1/chat/completions" />

    <hr style="border: 0; border-top: 1px solid #333; margin: 10px 0;">

    <label>Cloudflare Account ID</label>
    <input type="text" id="set-cf-account" placeholder="Your Account ID" />
    
    <label>Cloudflare API Token</label>
    <input type="password" id="set-cf-token" placeholder="Your API Token" />

    <hr style="border: 0; border-top: 1px solid #333; margin: 10px 0;">

    <label>Background Blur (<span id="blur-val">10</span>px)</label>
    <input type="range" id="set-blur" min="0" max="30" value="10" />
    
    <label>Background Dimness (<span id="dim-val">40</span>%)</label>
    <input type="range" id="set-dim" min="0" max="90" value="40" />
    
    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:10px;">
      <input type="checkbox" id="set-manual-mode" /> 
      <span style="color:#fff; font-size:13px;">Enable Manual Mode</span>
    </label>

    <div id="manual-controls" style="display: none; flex-direction: column; gap: 12px; margin-top: 10px;">
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
  document.getElementById("set-cf-account").value = localStorage.getItem("ambient_cf_account") || "";
  document.getElementById("set-cf-token").value = localStorage.getItem("ambient_cf_token") || "";
  
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

  document.getElementById("manual-audio").addEventListener("change", (e) => applyAmbience({ music: e.target.value }));
  document.getElementById("manual-effect").addEventListener("change", (e) => applyAmbience({ effect: e.target.value }));

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_cf_account", document.getElementById("set-cf-account").value.trim());
    localStorage.setItem("ambient_cf_token", document.getElementById("set-cf-token").value.trim());
    localStorage.setItem("ambient_blur", document.getElementById("set-blur").value);
    localStorage.setItem("ambient_dim", document.getElementById("set-dim").value);
    settingsMenu.style.display = "none";
  });

  document.getElementById("test-ai-btn").addEventListener("click", async () => {
    const apiKey = localStorage.getItem("ambient_api_key");
    if (!apiKey) return alert("Please enter and save an OpenRouter API key first.");
    let actualChat = getLatestChatContext() || "The group steps into a dark, gloomy forest. Rain begins to fall.";
    await askAI(actualChat, cachedAudio, apiKey);
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
    // Initial image generation is removed. It will wait for the AI.
  });

  // --- 6. LISTEN FOR NETWORK TRIGGERS ---
  let networkDebounce = null;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "chat_updated") {
      if (localStorage.getItem("ambient_manual_mode") === "true") return;

      clearTimeout(networkDebounce);
      
      networkDebounce = setTimeout(() => {
        console.log("⚡ Bot message saved. Scraping finalized chat...");
        let currentText = getLatestChatContext();
        if (currentText) {
          const apiKey = localStorage.getItem("ambient_api_key");
          if (apiKey) askAI(currentText, cachedAudio, apiKey);
        }
      }, 1000); 
    }
  });
})();

// --- HELPER: Dot State Logic ---
function setDotState(dotId, state) {
  const dot = document.getElementById(dotId);
  if (!dot) return;
  dot.className = "dot " + state;
  if (state === "success" || state === "error") {
    setTimeout(() => {
      if (dot.classList.contains(state)) dot.className = "dot idle";
    }, 2000);
  }
}

// --- HELPER: Live Visual Settings ---
function applyVisualSettings(blur, dim) {
  document.documentElement.style.setProperty('--ambient-blur', `${blur}px`);
  document.documentElement.style.setProperty('--ambient-dim', dim / 100);
}

function populateManualDropdowns() {
  const audioSelect = document.getElementById("manual-audio");
  if (!audioSelect) return;
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

// --- AI FUNCTION ---
async function askAI(chatText, availableAudio, apiKey) {
  setDotState("dot-orch", "loading"); 
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  let memoryPrompt = "";
  if (lastDecision) {
    memoryPrompt = `\nIMPORTANT MEMORY: The previous background was "${currentBackgroundPrompt}". If the characters are still in the same location, output "none" for the background. Do not change the background or music unless the chat explicitly describes a major scene change (e.g., moving to a new location).`;
  }

  const systemPrompt = `You are an ambient engine for a roleplay. Based on the chat, decide the background, music, and weather.
  Output ONLY a valid JSON object with the exact keys "background", "music", "effect", and "reasoning".

  CRITICAL RULES FOR BACKGROUNDS:
  1. "background" must be a concise visual description (max 10 words) for an image generator.
  2. The style MUST be an anime visual novel background.
  3. NEVER include living beings. (NO humans, NO characters, NO animals).
  4. ONLY provide a new background prompt if the scene drastically changes location. If they stay in the same place, output "none" for the background to save API calls.
  5. STRICTLY FORBIDDEN WORDS: Never use words related to anatomy, biology, violence, or gore. (e.g., instead of "veins", use "cracks" or "lines"; instead of "flesh", use "stone" or "wood"). The image generator has a strict safety filter.

  CRITICAL RULES FOR WEATHER EFFECTS:
  1. Outdoor weather (rain, snow, thunderstorm, blizzard) must ONLY be used if the characters are currently outside. If they are indoors, output "none" for the effect.
  2. "fog" and "fiery" can be used indoors or outdoors if contextually appropriate.

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
      setDotState("dot-orch", "error"); return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 Raw AI Response:", aiMessage);
    
    try {
      let cleanJson = aiMessage.replace(/```json/g, "").replace(/```/g, "").trim();
      const decision = JSON.parse(cleanJson);
      
      lastDecision = decision; 
      
      if (decision.reasoning) {
        console.log(`%c🧠 AI Reasoning: ${decision.reasoning}`, "color: #eab308; font-weight: bold;");
      }

      applyAmbience(decision);
      setDotState("dot-orch", "success"); 
    } catch (e) {
      console.error("Failed to parse JSON:", e);
      setDotState("dot-orch", "error");
    }
  } catch (e) {
    console.error("Fetch failed:", e);
    setDotState("dot-orch", "error");
  }
}

// --- AMBIENCE ENGINE ---
function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  if (decision.background && decision.background.toLowerCase() !== "none" && decision.background !== currentBackgroundPrompt) {
    currentBackgroundPrompt = decision.background;
    generateCloudflareBackground(currentBackgroundPrompt);
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

// --- IMAGE GENERATOR (Cloudflare -> Pollinations) ---
async function generateCloudflareBackground(prompt) {
  if (isGeneratingBg) return; 
  
  const accountId = localStorage.getItem("ambient_cf_account");
  const cfToken = localStorage.getItem("ambient_cf_token");
  
  if (!accountId || !cfToken) {
    console.warn("⚠️ Cloudflare keys missing. Falling straight to Pollinations.");
  }

  isGeneratingBg = true;
  setDotState("dot-cf", "loading");
  setDotState("dot-poll", "idle");

  try {
    const response = await chrome.runtime.sendMessage({
      action: "generate_image",
      prompt: prompt,
      accountId: accountId,
      apiToken: cfToken
    });

    if (!response.success) throw new Error(response.error);

    if (response.provider === 'cloudflare') {
      setDotState("dot-cf", "success");
    } else if (response.provider === 'pollinations') {
      setDotState("dot-cf", "error");
      setDotState("dot-poll", "loading");
    }

    const imageUrl = response.imageUrl;
    
    const img = new Image();
    img.onload = () => {
      isGeneratingBg = false;
      if (response.provider === 'pollinations') setDotState("dot-poll", "success");
      
      const layer1 = document.getElementById("bg-layer-1");
      const layer2 = document.getElementById("bg-layer-2");
      const activeLayer = layer1.classList.contains("active") ? layer1 : layer2;
      const inactiveLayer = activeLayer === layer1 ? layer2 : layer1;

      inactiveLayer.style.backgroundImage = `url("${imageUrl}")`;
      void inactiveLayer.offsetWidth; 

      activeLayer.classList.remove("active");
      inactiveLayer.classList.add("active");
    };

    img.onerror = () => {
      isGeneratingBg = false;
      if (response.provider === 'cloudflare') setDotState("dot-cf", "error");
      if (response.provider === 'pollinations') setDotState("dot-poll", "error");
      console.error("❌ Failed to load generated image into browser.");
    };

    img.src = imageUrl;

  } catch (error) {
    isGeneratingBg = false;
    setDotState("dot-cf", "error");
    setDotState("dot-poll", "error");
    console.error("❌ Total image generation failure:", error);
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

// --- WEATHER ENGINE (Improved Particles & Scroll Freeze Fix) ---
function setWeather(effect) {
  currentEffect = effect;
  console.log("Setting Weather:", effect);
  
  canvas.style.opacity = 0;
  
  // Stop the current animation loop safely
  isAnimating = false;
  if (animationId) cancelAnimationFrame(animationId);

  setTimeout(() => {
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
      for (let i = 0; i < 80; i++) particles.push(new Particle("ember"));
      isAnimating = true;
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "thunderstorm") {
      for (let i = 0; i < 200; i++) particles.push(new Particle("rain"));
      isAnimating = true;
      animateWeather();
      canvas.style.opacity = 1;
      lightningInterval = setInterval(() => {
        if (Math.random() > 0.7) {
          const lightningOverlay = document.getElementById("ambient-lightning-overlay");
          lightningOverlay.style.opacity = Math.random() * 0.6 + 0.4;
          setTimeout(() => lightningOverlay.style.opacity = 0, 100);
          setTimeout(() => {
            lightningOverlay.style.opacity = Math.random() * 0.4 + 0.2;
            setTimeout(() => lightningOverlay.style.opacity = 0, 150);
          }, 200);
        }
      }, 3000);
      return;
    }

    if (effect === "rain") {
      for (let i = 0; i < 200; i++) particles.push(new Particle("rain"));
      isAnimating = true;
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "snow") {
      for (let i = 0; i < 150; i++) particles.push(new Particle("snow"));
      isAnimating = true;
      animateWeather();
      canvas.style.opacity = 1;
      return;
    }

    if (effect === "blizzard") {
      for (let i = 0; i < 300; i++) particles.push(new Particle("blizzard"));
      isAnimating = true;
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
    this.depth = Math.random() * 0.8 + 0.2; 

    if (type === "rain" || type === "thunderstorm") {
      this.vy = (Math.random() * 10 + 15) * this.depth;
      this.vx = -3 * this.depth;
      this.length = (Math.random() * 20 + 10) * this.depth;
      this.opacity = Math.random() * 0.3 + 0.2;
    } else if (type === "snow") {
      this.vy = (Math.random() * 1.5 + 1) * this.depth;
      this.vx = (Math.random() * 1 - 0.5) * this.depth;
      this.radius = (Math.random() * 3 + 1) * this.depth;
      this.sway = Math.random() * Math.PI * 2;
      this.swaySpeed = Math.random() * 0.02 + 0.01;
    } else if (type === "blizzard") {
      this.vy = (Math.random() * 5 + 4) * this.depth;
      this.vx = (Math.random() * 6 - 3) * this.depth;
      this.radius = (Math.random() * 3 + 1) * this.depth;
      this.sway = Math.random() * Math.PI * 2;
      this.swaySpeed = Math.random() * 0.05 + 0.02;
    } else if (type === "ember") {
      this.y = canvas.height + Math.random() * 100;
      this.vy = -(Math.random() * 1.5 + 0.5) * this.depth;
      this.vx = (Math.random() * 1 - 0.5) * this.depth;
      this.radius = (Math.random() * 2 + 1) * this.depth;
      this.opacity = Math.random();
    }
  }

  update() {
    this.x += this.vx; 
    this.y += this.vy;

    if (this.type === "snow" || this.type === "blizzard") {
      this.sway += this.swaySpeed;
      this.x += Math.sin(this.sway) * 1.5;
    }

    if (this.type === "rain" && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if ((this.type === "snow" || this.type === "blizzard") && this.y > canvas.height) { this.y = -20; this.x = Math.random() * canvas.width; }
    if (this.type === "ember" && this.y < -20) { this.y = canvas.height + 20; this.x = Math.random() * canvas.width; }
  }

  draw() {
    if (this.type === "rain") {
      ctx.beginPath(); 
      ctx.moveTo(this.x, this.y); 
      ctx.lineTo(this.x + this.vx, this.y + this.length);
      ctx.strokeStyle = `rgba(180, 210, 255, ${this.opacity})`; 
      ctx.lineWidth = this.depth * 1.5; 
      ctx.lineCap = "round";
      ctx.stroke();
    } else if (this.type === "snow" || this.type === "blizzard") {
      ctx.beginPath(); 
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${this.depth * 0.8})`;
      ctx.shadowBlur = this.depth * 10; 
      ctx.shadowColor = "white";
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (this.type === "ember") {
      ctx.beginPath(); 
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, ${Math.floor(Math.random() * 100 + 50)}, 0, ${this.opacity})`;
      ctx.shadowBlur = 15; 
      ctx.shadowColor = "orange";
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

function animateWeather() {
  if (!isAnimating) return; // Stops the loop if we switched effects
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => { p.update(); p.draw(); });
  animationId = requestAnimationFrame(animateWeather);
}
