(function ambientEngineMain() {
// Guard: the background script may inject this file again after in-site (SPA) navigation.
if (window.__ambientEngineLoaded) return;
window.__ambientEngineLoaded = true;

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
let isAnimating = false;

// ===== VN: STATE =====
const vn = {
  active: false,     // a bot message is currently being revealed paragraph by paragraph
  pending: false,    // bot message was just saved, waiting for it to be present in the DOM
  pendingSince: 0,
  startedAt: 0,
  msgEl: null,       // the <li> of the message being revealed
  text: "",          // text signature of that message (detects swipes / re-mounts)
  revealed: 1,       // how many paragraphs are currently visible
  total: 0,
  ignoreSignalsUntil: 0
};
let isCuttingMessage = false;
let vnBypass = false;        // lets our own auto-send click through the interceptor
let vnObserver = null;
let vnSyncQueued = false;
const VN_OBS_OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const vnEnabled = () => localStorage.getItem("ambient_vn_mode") === "true";
const vnAutoSend = () => localStorage.getItem("ambient_vn_autosend") !== "false"; // default ON
const isChatPage = () => location.pathname.startsWith("/chats/");
function vnLog(...args) {
  if (localStorage.getItem("ambient_vn_debug") === "true") console.log("%c[VN]", "color:#a855f7;font-weight:bold", ...args);
}

// <pure-cut-logic>
// ===== VN: PURE TEXT LOGIC (no DOM access, unit-tested) =====
const ALNUM = /[\p{L}\p{N}]/u;

// Letters+digits only, lowercased. Markdown, punctuation, whitespace and quotes all vanish,
// so rendered text and raw markdown can be compared without caring how either is formatted.
function normText(str) {
  let out = "";
  for (const ch of (str || "")) if (ALNUM.test(ch)) out += ch.toLowerCase();
  return out;
}

// Same normalisation for the raw markdown, but also remembers where every kept char lived in the
// raw string, and skips HTML tags and {{macros}} (which never show up as-is in the rendered DOM).
function buildRawIndex(raw, names) {
  names = names || {};
  let norm = "";
  const map = [];
  const macro = /\{\{\s*(user|char|bot)\s*\}\}|<\s*(user|char|bot)\s*>/iy;
  const tag = /<\/?[a-zA-Z][^>\n]{0,200}>|\{\{[^}\n]{0,80}\}\}/y;
  let i = 0;
  while (i < raw.length) {
    const ch = String.fromCodePoint(raw.codePointAt(i));
    if (ch === "<" || ch === "{") {
      macro.lastIndex = i;
      let m = macro.exec(raw);
      if (m) {
        // {{user}} / {{char}} are rendered as real names -> substitute them so paragraphs match exactly
        const key = (m[1] || m[2]).toLowerCase();
        const name = key === "user" ? names.user : names.char;
        const end = i + m[0].length;
        if (name) for (const c of normText(name)) { norm += c; map.push(end - 1); }
        i = end;
        continue;
      }
      tag.lastIndex = i;
      m = tag.exec(raw);
      if (m) { i += m[0].length; continue; }          // HTML tags / other {{macros}} never show up as-is
    }
    if (ALNUM.test(ch)) {
      const low = ch.toLowerCase();
      for (let k = 0; k < low.length; k++) { norm += low[k]; map.push(i + ch.length - 1); }
    }
    i += ch.length;
  }
  return { norm, map };
}

// Where does this rendered paragraph end inside the normalised raw text? (-1 = can't tell)
function locateBlockEnd(rawNorm, n, cursor) {
  if (!n) return cursor;                               // paragraph with no letters at all ("***", "—")
  let i = rawNorm.indexOf(n, cursor);
  if (i !== -1) return i + n.length;                   // exact match
  const A = 24;
  if (n.length > A) {
    i = rawNorm.indexOf(n.slice(-A), cursor);          // tail anchor (e.g. a {{user}} earlier in the paragraph)
    if (i !== -1) return i + A;
    for (const d of [3, 6, 10, 16]) {                  // {{user}} right at the end: skip back past the name
      const stop = n.length - d;
      if (stop < A) break;
      i = rawNorm.indexOf(n.slice(stop - A, stop), cursor);
      if (i !== -1) return i + A;                      // lands inside the paragraph's last line; caller snaps to line end
    }
  }
  return -1;
}

// Plan B: split the raw text on blank lines. Only trusted when the chunk count equals the number
// of rendered paragraphs, because then the two are certainly aligned.
function structuralCut(raw, visibleCount, totalBlocks) {
  const seps = [];
  const re = /\r?\n[ \t]*\r?\n/g;
  let m;
  while ((m = re.exec(raw))) seps.push(m.index);
  if (seps.length + 1 !== totalBlocks) return -1;
  return visibleCount >= 1 && visibleCount <= seps.length ? seps[visibleCount - 1] : -1;
}

// Returns the raw-string index to cut at (everything after it is dropped), or -1 if unsure.
function computeCutIndex(raw, visibleTexts, totalBlocks, names) {
  const { norm, map } = buildRawIndex(raw, names);
  let cursor = 0, ok = true;
  for (const t of visibleTexts) {
    const end = locateBlockEnd(norm, normText(t), cursor);
    if (end === -1) { ok = false; break; }
    cursor = end;
  }
  if (ok && cursor > 0 && cursor <= map.length) {
    const lastChar = map[cursor - 1] + 1;              // just after the last visible letter
    const nl = raw.indexOf("\n", lastChar);            // keep closing * " ) etc. -> finish the line
    return nl === -1 ? raw.length : nl;
  }
  return structuralCut(raw, visibleTexts.length, totalBlocks);
}
// </pure-cut-logic>

// ===== VN: DOM HELPERS =====
const VN_BLOCK_SEL = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote";
const isThoughtEl = (el) => !!el.closest('[class*="thought"], [class*="reasoning"]');

function getMessageItems() {
  return Array.from(document.querySelectorAll('li[class*="messageDisplayWrapper"]'));
}

function getTextContainer(li) {
  return li.querySelector(".css-7w4zgl") || li.querySelector('[class*="messageBody"]');
}

// The paragraphs of a message, in order. Innermost blocks only (so a <p> inside a <blockquote> or
// <li> is counted once), hidden ones INCLUDED (the old code dropped them, which broke the button).
function getVNBlocks(li) {
  const container = li && getTextContainer(li);
  if (!container) return [];
  let blocks = Array.from(container.querySelectorAll(VN_BLOCK_SEL)).filter(el => !isThoughtEl(el));
  blocks = blocks.filter(el => !blocks.some(o => o !== el && el.contains(o)));
  blocks = blocks.filter(el => el.textContent.trim().length > 0);
  if (blocks.length === 0) {
    const kids = Array.from(container.children).filter(el => el.textContent.trim() && !isThoughtEl(el));
    blocks = kids.length > 1 ? kids : [container];
  }
  return blocks;
}

// {{char}} = name on the bot's message header, {{user}} = the other name in the chat (if any user message exists)
function getChatNames(li) {
  const nameOf = (el) => { const n = el.querySelector('[class*="nameText"]'); return n ? n.textContent.trim() : ""; };
  const char = li ? nameOf(li) : "";
  let user = "";
  for (const it of getMessageItems()) { const n = nameOf(it); if (n && n !== char) { user = n; break; } }
  return { char, user };
}

const fullText = (blocks) => blocks.map(b => b.textContent.trim()).join("\n");
function sameStart(a, b) {
  const n = Math.min(30, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

function findButton(root, label) {
  if (!root) return null;
  const exact = root.querySelector(
    `button[title="${label}" i], button[aria-label="${label}" i], [role="button"][aria-label="${label}" i]`
  );
  if (exact) return exact;
  const l = label.toLowerCase();
  return Array.from(root.querySelectorAll('button, [role="button"]')).find(b =>
    ((b.getAttribute("title") || "") + " " + (b.getAttribute("aria-label") || "") + " " + (b.textContent || ""))
      .toLowerCase().includes(l)
  ) || null;
}

function showVnToast(text, isError) {
  const t = document.getElementById("vn-toast");
  if (!t) return;
  t.textContent = text;
  t.style.background = isError ? "#ef4444" : "#22c55e";
  t.style.display = "block";
  clearTimeout(showVnToast._t);
  showVnToast._t = setTimeout(() => { t.style.display = "none"; }, 4000);
}

// ===== CHANGED: enumerate audio/ folder via hidden iframe (works in Kiwi Browser) =====
// --- 0. ENUMERATE AUDIO FOLDER ---
(async function loadAudioFolder() {
  try {
    cachedAudio = await listAudioFilesViaIframe();
    populateManualDropdowns();
    if (cachedAudio.length === 0) {
      console.log("[Ambient] No audio files in audio/ folder — music will be disabled.");
    } else {
      console.log(`[Ambient] Found ${cachedAudio.length} audio file(s).`);
    }
  } catch (e) {
    console.error("[Ambient] Failed to enumerate audio folder:", e);
    cachedAudio = [];
  }
})();

function listAudioFilesViaIframe() {
  return new Promise((resolve) => {
    // Create a hidden iframe that points to reader.html (which has the real API access).
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('reader.html');
    document.body.appendChild(iframe);

    // Listen for the message from the iframe.
    const messageHandler = (event) => {
      if (event.data && event.data.type === 'AUDIO_FILES') {
        window.removeEventListener('message', messageHandler);
        iframe.remove();
        const files = event.data.files
          .filter(n => /\.(mp3|ogg|m4a|wav|flac)$/i.test(n))
          .map(n => 'audio/' + encodeURIComponent(n));
        resolve(files);
      }
    };
    window.addEventListener('message', messageHandler);

    // Safety timeout: if the iframe never responds, resolve with an empty list.
    setTimeout(() => {
      if (document.body.contains(iframe)) {
        window.removeEventListener('message', messageHandler);
        iframe.remove();
        resolve([]);
      }
    }, 5000);
  });
}
// ===== END CHANGED =====

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
  } catch (e) {}

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
    
    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:5px;">
      <input type="checkbox" id="set-vn-mode" /> 
      <span style="color:#fff; font-size:13px;">Visual Novel Text Mode</span>
    </label>

    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:5px;">
      <input type="checkbox" id="set-vn-autosend" /> 
      <span style="color:#fff; font-size:13px;">VN: auto-send right after a cut</span>
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

  // VN Continue Button
  const vnBtn = document.createElement("button");
  vnBtn.id = "vn-continue-btn";
  vnBtn.innerHTML = "▼";
  vnBtn.addEventListener("click", advanceVNText);
  document.body.appendChild(vnBtn);

  // VN "Cut" Notification Banner
  const vnToast = document.createElement("div");
  vnToast.id = "vn-toast";
  vnToast.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #22c55e; color: white; padding: 10px 20px; border-radius: 8px;
    font-weight: bold; z-index: 2147483647; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  `;
  vnToast.textContent = "✂️ Text cut! Hit Send again.";
  document.body.appendChild(vnToast);

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

  const vnCheckbox = document.getElementById("set-vn-mode");
  vnCheckbox.checked = localStorage.getItem("ambient_vn_mode") === "true";

  const vnAutoSendCheckbox = document.getElementById("set-vn-autosend");
  vnAutoSendCheckbox.checked = vnAutoSend();

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

  vnCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_vn_mode", e.target.checked);
    if (!e.target.checked) vnReset();   // switching it off un-hides everything straight away
  });

  vnAutoSendCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_vn_autosend", e.target.checked);
  });

  document.getElementById("manual-audio").addEventListener("change", (e) => {
    if (!e.target.value) return;   // CHANGED: ignore the disabled "(no audio)" placeholder
    applyAmbience({ music: e.target.value });
  });
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
  });

  // --- 6. LISTEN FOR NETWORK TRIGGERS ---
  let networkDebounce = null;

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action !== "chat_updated") return;
    if (!isChatPage() || isCuttingMessage || Date.now() < vn.ignoreSignalsUntil) return;

    // Visual novel mode: a bot message was just saved -> start revealing it paragraph by paragraph.
    // (Manual mode used to return before reaching this, which silently disabled VN mode.)
    if (vnEnabled()) {
      vn.pending = true;
      vn.pendingSince = Date.now();
      vnLog("bot message saved, waiting for it to appear in the page");
      queueVNSync();
    }

    // Ambient engine (not in manual mode)
    if (localStorage.getItem("ambient_manual_mode") === "true") return;
    clearTimeout(networkDebounce);
    networkDebounce = setTimeout(() => {
      console.log("⚡ Bot message saved.");
      const currentText = getLatestChatContext();
      if (currentText) {
        const apiKey = localStorage.getItem("ambient_api_key");
        if (apiKey) askAI(currentText, cachedAudio, apiKey);
      }
    }, 1500);
  });

  // --- 7. INTERCEPT SEND (cut the message at the last paragraph you read) ---
  document.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest && e.target.closest('button[aria-label="Send" i], button[title="Send" i]')) handleIntercept(e);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const t = e.target;
    // The main chat box only (the old code matched a hashed class name that changes on every Janitor deploy)
    if (t && t.tagName === "TEXTAREA" && !t.closest("li")) handleIntercept(e);
  }, true);

  startVNObserver();
})();

// ===== VISUAL NOVEL ENGINE =====

// Run DOM changes without our own MutationObserver reacting to them.
function vnMutate(fn) {
  if (vnObserver) vnObserver.disconnect();
  try { fn(); } finally { if (vnObserver) vnObserver.observe(document.body, VN_OBS_OPTS); }
}

function queueVNSync() {
  if (vnSyncQueued) return;
  vnSyncQueued = true;
  requestAnimationFrame(vnSync);
}

function startVNObserver() {
  vnObserver = new MutationObserver(queueVNSync);   // React re-renders / streaming / swipes all land here
  vnObserver.observe(document.body, VN_OBS_OPTS);
  setInterval(queueVNSync, 1000);                   // safety net (also catches SPA navigation)
}

function clearHidden() {
  document.querySelectorAll(".vn-hidden-text").forEach(el => el.classList.remove("vn-hidden-text"));
}

function vnReset() {
  vn.active = false;
  vn.pending = false;
  vn.msgEl = null;
  vn.total = 0;
  if (document.querySelector(".vn-hidden-text")) vnMutate(clearHidden);
  const btn = document.getElementById("vn-continue-btn");
  if (btn) btn.style.display = "none";
}

// The message being revealed: the remembered <li> if it is still on the page, otherwise (React
// re-mounted it / the list was virtualised away and back) the last <li> if its text matches.
function findVNMessage(items) {
  if (vn.msgEl && vn.msgEl.isConnected) return vn.msgEl;
  const last = items[items.length - 1];
  if (last && vn.text) {
    const t = fullText(getVNBlocks(last));
    if (t && sameStart(t, vn.text)) return last;
  }
  return null;
}

// Show paragraphs [0, vn.revealed), hide the rest. Safe to call as often as we like.
function applyVN(blocks) {
  const btn = document.getElementById("vn-continue-btn");
  vn.total = blocks.length;
  if (!blocks.length) { if (btn) btn.style.display = "none"; return; }
  if (vn.revealed > blocks.length) vn.revealed = blocks.length;
  if (vn.revealed < 1) vn.revealed = 1;

  vnMutate(() => {
    const live = new Set(blocks);
    document.querySelectorAll(".vn-hidden-text").forEach(el => { if (!live.has(el)) el.classList.remove("vn-hidden-text"); });
    blocks.forEach((b, i) => b.classList.toggle("vn-hidden-text", i >= vn.revealed));
  });
  if (btn) btn.style.display = vn.revealed < blocks.length ? "flex" : "none";
}

// Called (throttled) on every DOM change. Starts a reveal when a bot message was just saved, and
// keeps the hidden/visible state correct if React redraws the message underneath us.
function vnSync() {
  vnSyncQueued = false;
  if (isCuttingMessage) return;
  const btn = document.getElementById("vn-continue-btn");
  if (!btn) return;

  if (!vnEnabled() || !isChatPage()) { if (vn.active || vn.pending) vnReset(); return; }
  if (!vn.active && !vn.pending) return;

  const items = getMessageItems();

  if (vn.pending) {
    if (Date.now() - vn.pendingSince > 15000) { vn.pending = false; vnLog("gave up waiting for the new message"); return; }
    const last = items[items.length - 1];
    const blocks = last ? getVNBlocks(last) : [];
    if (!blocks.length) return;                       // not rendered yet - the observer will call us again
    vn.pending = false;
    vn.active = true;
    vn.msgEl = last;
    vn.revealed = 1;
    vn.startedAt = Date.now();
    vn.text = fullText(blocks);
    vnLog("started:", blocks.length, "paragraphs");
    applyVN(blocks);
    return;
  }

  let li = findVNMessage(items);
  if (!li) { btn.style.display = "none"; return; }    // message scrolled out of the list; state is kept

  // We started on the user's own message because the bot's one wasn't in the DOM yet -> retry.
  if (Date.now() - vn.startedAt < 4000 && li === vn.msgEl && items[items.length - 1] !== li) {
    vnLog("a newer message showed up right after start, retrying");
    vnReset();
    vn.pending = true; vn.pendingSince = Date.now();
    queueVNSync();
    return;
  }

  vn.msgEl = li;
  const blocks = getVNBlocks(li);
  const t = fullText(blocks);
  if (!sameStart(t, vn.text)) { vn.revealed = 1; vnLog("message text was replaced (swipe/regenerate) -> restarting"); }
  vn.text = t;
  applyVN(blocks);
}

function advanceVNText() {
  if (!vn.active) return;
  const li = findVNMessage(getMessageItems());
  if (!li) return;
  const blocks = getVNBlocks(li);              // includes hidden paragraphs, so this can actually reveal them
  vn.revealed = Math.min(vn.revealed + 1, blocks.length);
  applyVN(blocks);
  const shown = blocks[vn.revealed - 1];
  if (shown) shown.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ===== CUT THE MESSAGE WHEN THE USER SENDS EARLY =====
async function cancelEdit(li) {
  const cancel = findButton(li, "cancel");
  if (cancel) cancel.click();
  else {
    const ta = li && li.querySelector("textarea");
    if (ta) ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  }
  await sleep(300);
}

// Returns { ok, reason?, unchanged? }. Never leaves the message stuck in edit mode.
async function cutMessage(li, blocks) {
  const visibleTexts = blocks.slice(0, vn.revealed).map(b => b.textContent);
  const total = blocks.length;
  const names = getChatNames(li);
  const cur = () => (li.isConnected ? li : (getMessageItems().pop() || null));

  const editBtn = findButton(li, "edit");
  if (!editBtn) return { ok: false, reason: "couldn't find the Edit button" };
  editBtn.click();

  let ta = null;
  for (let i = 0; i < 30 && !ta; i++) {
    await sleep(100);
    const c = cur();
    ta = c && c.querySelector("textarea");
  }
  if (!ta) return { ok: false, reason: "the edit box never opened" };

  const raw = ta.value;
  const cutIdx = computeCutIndex(raw, visibleTexts, total, names);
  vnLog("cut index", cutIdx, "of", raw.length, "| revealed", visibleTexts.length, "of", total);

  if (cutIdx < 1) {
    await cancelEdit(cur());
    return { ok: false, reason: "couldn't match what you read to the message source, left it untouched" };
  }
  const newText = raw.slice(0, cutIdx).trimEnd();
  if (!newText) { await cancelEdit(cur()); return { ok: false, reason: "cut would have been empty" }; }
  if (newText.length >= raw.trimEnd().length) { await cancelEdit(cur()); return { ok: true, unchanged: true }; }

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  ta.focus();
  setter.call(ta, newText);                              // React-safe
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);

  const saveBtn = findButton(cur(), "save");
  if (saveBtn) saveBtn.click();
  else ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));

  for (let i = 0; i < 40; i++) {                          // wait for edit mode to close (max ~4s)
    await sleep(100);
    const c = cur();
    if (!c || !c.querySelector("textarea")) break;
  }
  const c = cur();
  if (c && c.querySelector("textarea")) {
    await cancelEdit(c);
    return { ok: false, reason: "saving the edit didn't go through" };
  }
  await sleep(500);                                       // let the re-render settle
  return { ok: true };
}

async function handleIntercept(e) {
  if (vnBypass) return;                                   // our own auto-send
  if (isCuttingMessage) { e.preventDefault(); e.stopPropagation(); return; }   // swallow double-clicks mid-cut
  if (!vnEnabled() || !isChatPage() || !vn.active) return;

  const li = findVNMessage(getMessageItems());
  if (!li) return;
  const blocks = getVNBlocks(li);
  if (vn.revealed >= blocks.length) return;               // already read everything -> normal send

  e.preventDefault();                                     // must happen before the first await
  e.stopPropagation();
  isCuttingMessage = true;
  const btn = document.getElementById("vn-continue-btn");
  if (btn) btn.style.display = "none";

  const readCount = vn.revealed;
  let result;
  try { result = await cutMessage(li, blocks); }
  catch (err) { console.error("[VN] cut crashed:", err); result = { ok: false, reason: "unexpected error (see console)" }; }

  vn.ignoreSignalsUntil = Date.now() + 3000;
  isCuttingMessage = false;
  vnReset();                                              // un-hide everything; the message is now exactly what was read

  if (!result.ok) {
    showVnToast("✂️ Not cut: " + result.reason, true);
    return;
  }

  if (vnAutoSend()) {
    await sleep(250);
    const sendBtn = document.querySelector('button[aria-label="Send" i], button[title="Send" i]');
    if (sendBtn && !sendBtn.disabled) {
      showVnToast(result.unchanged ? "Sent" : `✂️ Cut after paragraph ${readCount}/${blocks.length}, sent`, false);
      vnBypass = true;
      try { sendBtn.click(); } finally { vnBypass = false; }
      return;
    }
  }
  showVnToast(result.unchanged ? "Hit Send again." : `✂️ Cut after paragraph ${readCount}/${blocks.length}. Hit Send again.`, false);
}

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

// ===== CHANGED: friendlier labels + graceful empty state =====
function populateManualDropdowns() {
  const audioSelect = document.getElementById("manual-audio");
  if (!audioSelect) return;

  if (cachedAudio.length === 0) {
    audioSelect.innerHTML = `<option value="" disabled selected>(no audio files in audio folder)</option>`;
    return;
  }

  audioSelect.innerHTML = cachedAudio.map(aud => {
    const label = decodeURIComponent(aud.replace(/^audio\//, ""));
    return `<option value="${aud}">${label}</option>`;
  }).join('');
}
// ===== END CHANGED =====

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

// ===== CHANGED: audio safeguard in applyAmbience =====
// --- AMBIENCE ENGINE ---
function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  if (decision.background && decision.background.toLowerCase() !== "none" && decision.background !== currentBackgroundPrompt) {
    currentBackgroundPrompt = decision.background;
    generateCloudflareBackground(currentBackgroundPrompt);
  }

  if (decision.music && decision.music.toLowerCase() !== "none" && decision.music !== currentMusic) {
    if (cachedAudio.length === 0) {
      // Safeguard: audio/ folder is empty (or unreadable) -> never try to play anything.
      console.log("[Ambient] Music requested but no audio files are available — skipping.");
    } else if (!cachedAudio.includes(decision.music)) {
      // Safeguard: AI hallucinated a filename that isn't in the folder.
      console.warn("[Ambient] Music requested but not in audio folder:", decision.music);
    } else {
      currentMusic = decision.music;
      const newAudioUrl = chrome.runtime.getURL(currentMusic);
      crossfadeAudio(newAudioUrl);
    }
  }

  if (decision.effect && decision.effect !== currentEffect) {
    setWeather(decision.effect);
  }
}
// ===== END CHANGED =====

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

// --- WEATHER ENGINE ---
function setWeather(effect) {
  currentEffect = effect;
  console.log("Setting Weather:", effect);
  
  canvas.style.opacity = 0;
  
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
  if (!isAnimating) return; 
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => { p.update(); p.draw(); });
  animationId = requestAnimationFrame(animateWeather);
}

})();
