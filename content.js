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
let currentIntensity = 80;   // 0-100 effect intensity
let lightningInterval = null;
let currentBackgroundPrompt = "";
let currentMusic = "";
let lastDecision = null; 
let isGeneratingBg = false;
let isAnimating = false;

// ===== NAME COLORS: STATE =====
let nameColors = {};
try { 
  const stored = JSON.parse(localStorage.getItem("ambient_name_colors") || "{}");
  for (const [k, v] of Object.entries(stored)) nameColors[k.toLowerCase()] = v;
} catch(e) {}

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
  ignoreSignalsUntil: 0,
  typewriterTimer: null,
  restoreData: null,
  _restoreOriginal: null
};
let isCuttingMessage = false;
let vnBypass = false;        // lets our own auto-send click through the interceptor
let vnObserver = null;
let vnSyncQueued = false;
const VN_OBS_OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const vnEnabled = () => localStorage.getItem("ambient_vn_mode") === "true";
const vnAutoSend = () => localStorage.getItem("ambient_vn_autosend") !== "false"; // default ON
const vnPunctPercent = () => { const v = Number(localStorage.getItem("ambient_vn_punct_pause")); return localStorage.getItem("ambient_vn_punct_pause") === null || isNaN(v) ? 100 : v; };
const vnCutNoteEnabled = () => localStorage.getItem("ambient_vn_cutnote_on") === "true"; // default OFF
const vnCutNoteText = () => (localStorage.getItem("ambient_vn_cutnote") ?? VN_CUTNOTE_DEFAULT).trim();
const VN_CUTNOTE_DEFAULT = "*{{user}} cuts in.*";
const isChatPage = () => location.pathname.startsWith("/chats/");
function vnLog(...args) {
  if (localStorage.getItem("ambient_vn_debug") === "true") console.log("%c[VN]", "color:#a855f7;font-weight:bold", ...args);
}

// <pure-cut-logic>
// ===== VN: PURE TEXT LOGIC (no DOM access, unit-tested) =====
const ALNUM = /[\p{L}\p{N}]/u;

function normText(str) {
  let out = "";
  for (const ch of (str || "")) if (ALNUM.test(ch)) out += ch.toLowerCase();
  return out;
}

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
        const key = (m[1] || m[2]).toLowerCase();
        const name = key === "user" ? names.user : names.char;
        const end = i + m[0].length;
        if (name) for (const c of normText(name)) { norm += c; map.push(end - 1); }
        i = end;
        continue;
      }
      tag.lastIndex = i;
      m = tag.exec(raw);
      if (m) { i += m[0].length; continue; }
    }
    if (ALNUM.test(ch)) {
      const low = ch.toLowerCase();
      for (let k = 0; k < low.length; k++) { norm += low[k]; map.push(i + ch.length - 1); }
    }
    i += ch.length;
  }
  return { norm, map };
}

function locateBlockEnd(rawNorm, n, cursor) {
  if (!n) return cursor;
  let i = rawNorm.indexOf(n, cursor);
  if (i !== -1) return i + n.length;
  const A = 24;
  if (n.length > A) {
    i = rawNorm.indexOf(n.slice(-A), cursor);
    if (i !== -1) return i + A;
    for (const d of [3, 6, 10, 16]) {
      const stop = n.length - d;
      if (stop < A) break;
      i = rawNorm.indexOf(n.slice(stop - A, stop), cursor);
      if (i !== -1) return i + A;
    }
  }
  return -1;
}

function structuralCut(raw, visibleCount, totalBlocks) {
  const seps = [];
  const re = /\r?\n[ \t]*\r?\n/g;
  let m;
  while ((m = re.exec(raw))) seps.push(m.index);
  if (seps.length + 1 !== totalBlocks) return -1;
  return visibleCount >= 1 && visibleCount <= seps.length ? seps[visibleCount - 1] : -1;
}

function computeCutIndex(raw, visibleTexts, totalBlocks, names) {
  const { norm, map } = buildRawIndex(raw, names);
  let cursor = 0, ok = true;
  for (const t of visibleTexts) {
    const end = locateBlockEnd(norm, normText(t), cursor);
    if (end === -1) { ok = false; break; }
    cursor = end;
  }
  if (ok && cursor > 0 && cursor <= map.length) {
    const lastChar = map[cursor - 1] + 1;
    const nl = raw.indexOf("\n", lastChar);
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

// ===== NAME COLORS: CORE =====
function saveNameColors() {
  localStorage.setItem("ambient_name_colors", JSON.stringify(nameColors));
}

function applyNameColors() {
  if (Object.keys(nameColors).length === 0) return;

  const items = document.querySelectorAll('li[class*="messageDisplayWrapper"]');
  
  const sortedNames = Object.keys(nameColors).sort((a,b) => b.length - a.length);
  const escapedNames = sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`\\b(${escapedNames.join('|')})\\b`, 'gi');

  items.forEach(li => {
    const nameEl = li.querySelector('[class*="nameText"], [class*="author"], [class*="userName"]');
    if (nameEl && !nameEl.closest('[class*="messageBody"], .css-7w4zgl')) {
      const name = nameEl.textContent.trim();
      const key = name.toLowerCase();
      if (nameColors[key]) {
        if (nameEl.dataset.colored !== nameColors[key]) {
          nameEl.style.setProperty("color", nameColors[key], "important");
          nameEl.style.setProperty("text-shadow", `0 0 10px ${nameColors[key]}`, "important");
          nameEl.dataset.colored = nameColors[key];
        }
      } else if (nameEl.dataset.colored) {
        nameEl.style.removeProperty("color");
        nameEl.style.removeProperty("text-shadow");
        delete nameEl.dataset.colored;
      }
    }

    const container = getTextContainer(li);
    if (!container) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (node.parentElement.closest('[class*="thought"], [class*="reasoning"], .ambient-colored-name')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodesToReplace = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      regex.lastIndex = 0;
      if (regex.test(node.nodeValue)) {
        nodesToReplace.push(node);
      }
    }

    nodesToReplace.forEach(node => {
      let text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = regex.lastIndex;
        const matchedText = match[0];
        const lowerName = matchedText.toLowerCase();

        if (matchStart > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, matchStart)));
        }

        if (nameColors[lowerName]) {
          const span = document.createElement('span');
          span.className = 'ambient-colored-name';
          span.style.setProperty('color', nameColors[lowerName], 'important');
          span.style.setProperty('text-shadow', `0 0 8px ${nameColors[lowerName]}`, 'important');
          span.textContent = matchedText;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(matchedText));
        }
        lastIdx = matchEnd;
      }

      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }

      if (node.parentNode) {
        node.parentNode.replaceChild(frag, node);
      }
    });
  });
}

// ===== CHANGED: enumerate audio/ folder via hidden iframe =====
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
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = chrome.runtime.getURL('reader.html');
    document.body.appendChild(iframe);

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
      <input type="checkbox" id="set-cinematic-mode" /> 
      <span style="color:#fff; font-size:13px;">Cinematic Mode (Hide UI)</span>
    </label>

    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:5px;">
      <input type="checkbox" id="set-vn-typewriter" />
      <span style="color:#fff; font-size:13px;">VN: typewriter text reveal</span>
    </label>

    <label style="display:flex; flex-direction:column; gap:6px; margin:8px 0 10px;">
      <span style="color:#fff; font-size:13px; text-transform:none !important;">Typewriter speed: <b id="vn-speed-value">45 ms/word</b></span>
      <input type="range" id="set-vn-typewriter-speed" min="15" max="180" step="5" value="45" />
      <span style="color:#999; font-size:11px; text-transform:none !important;">Lower is faster. Tap the screen to finish the current paragraph.</span>
    </label>

    <label style="display:flex; flex-direction:column; gap:6px; margin:8px 0 10px;">
      <span style="color:#fff; font-size:13px; text-transform:none !important;">Punctuation pause: <b id="vn-punct-value">100%</b></span>
      <input type="range" id="set-vn-punct-pause" min="0" max="250" step="10" value="100" />
      <span style="color:#999; font-size:11px; text-transform:none !important;">How long the text lingers on commas, full stops, dashes and ellipses. 0% turns it off.</span>
    </label>

    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:5px;">
      <input type="checkbox" id="set-vn-autosend" /> 
      <span style="color:#fff; font-size:13px;">VN: auto-send right after a cut</span>
    </label>

    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-top:5px;">
      <input type="checkbox" id="set-vn-cutnote-on" /> 
      <span style="color:#fff; font-size:13px;">VN: add a "cut in" note to messages I cut</span>
    </label>
    <input type="text" id="set-vn-cutnote" placeholder="*{{user}} cuts in.*" />

    <div id="manual-controls" style="display: none; flex-direction: column; gap: 12px; margin-top: 10px;">
      <label>Audio</label>
      <select id="manual-audio"></select>
      
      <label>Weather Effect</label>
      <select id="manual-effect">
        <option value="none">none</option>
        <option value="rain">rain</option>
        <option value="fog">fog</option>
        <option value="thunderstorm">thunderstorm</option>
        <option value="fiery">fiery — orange</option>
        <option value="fire-red">fiery — red</option>
        <option value="fire-yellow">fiery — yellow</option>
        <option value="fire-green">fiery — green</option>
        <option value="fire-blue">fiery — blue</option>
        <option value="fire-cyan">fiery — cyan</option>
        <option value="fire-purple">fiery — purple</option>
        <option value="fire-pink">fiery — pink</option>
        <option value="fire-white">fiery — white</option>
        <option value="fire-black">fiery — shadow</option>
        <option value="snow">snow</option>
        <option value="blizzard">blizzard</option>
        <option value="petal-pink">cherry blossom petals</option>
        <option value="leaf-orange">autumn leaves</option>
        <option value="leaf-red">red leaves</option>
        <option value="leaf-yellow">yellow leaves</option>
        <option value="leaf-green">green leaves</option>
        <option value="leaf-cyan">cyan leaves</option>
        <option value="leaf-blue">blue leaves</option>
        <option value="leaf-purple">purple leaves</option>
        <option value="leaf-white">white leaves</option>
        <option value="leaf-gold">golden leaves</option>
        <option value="leaf-black">shadow leaves</option>
        <option value="lovely-hearts">lovely hearts</option>
        <option value="darkness">darkness</option>
        <option value="stars">stardust</option>
        <option value="aurora">aurora</option>
        <option value="magic-red">magic — red</option>
        <option value="magic-orange">magic — orange</option>
        <option value="magic-yellow">magic — yellow</option>
        <option value="magic-green">magic — green</option>
        <option value="magic-cyan">magic — cyan</option>
        <option value="magic-blue">magic — blue</option>
        <option value="magic-purple">magic — purple</option>
        <option value="magic-pink">magic — pink</option>
        <option value="magic-white">magic — white</option>
        <option value="magic-gold">magic — gold</option>
        <option value="magic-black">magic — void</option>
      </select>

      <label>Effect Intensity (<span id="intensity-val">80</span>%)</label>
      <input type="range" id="set-intensity" min="0" max="100" step="5" value="80" />
      <span style="color:#999; font-size:11px; text-transform:none !important;">How strong the current effect is. 0% = barely there, 100% = maximum.</span>
    </div>

    <button id="save-settings" style="margin-top: 10px;">Save</button>
    <button id="test-ai-btn">Test Connection</button>
  `;

  document.body.appendChild(uiWrapper);
  document.body.appendChild(settingsMenu);

  // ===== NAME COLORS UI =====
  const nameColorBtn = document.createElement("button");
  nameColorBtn.id = "ambient-name-color-btn";
  nameColorBtn.innerHTML = "🎨";
  document.body.appendChild(nameColorBtn);

  const nameColorMenu = document.createElement("div");
  nameColorMenu.id = "ambient-name-colors-menu";
  nameColorMenu.innerHTML = `
    <h2>Name Colors</h2>
    <label class="manual-toggle-wrapper" style="display:flex; gap:10px; margin-bottom:10px;">
      <input type="checkbox" id="set-ai-name-colors" /> 
      <span style="color:#fff; font-size:13px;">Let AI assign colors</span>
    </label>
    <div id="name-color-list" style="display:flex; flex-direction:column; gap:8px; max-height:200px; overflow-y:auto;"></div>
    <hr style="border: 0; border-top: 1px solid #333; margin: 10px 0;">
    <div style="display:flex; gap:8px; align-items:center;">
      <input type="text" id="new-name-input" placeholder="Character Name" style="flex:1; padding:8px;" />
      <input type="color" id="new-color-input" value="#ffffff" />
      <button id="add-name-color-btn" style="padding: 8px 12px;">+</button>
    </div>
    <button id="update-last-msg-btn" style="margin-top:10px; background: #333 !important; color: #fff !important; border: 1px solid #555 !important;">Apply to Latest Message</button>
  `;
  document.body.appendChild(nameColorMenu);

  function renderNameColorList() {
    const list = document.getElementById("name-color-list");
    list.innerHTML = "";
    const sortedKeys = Object.keys(nameColors).sort();
    
    for (const key of sortedKeys) {
      const color = nameColors[key];
      const display = key.charAt(0).toUpperCase() + key.slice(1);
      
      const row = document.createElement("div");
      row.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.4); padding:4px 8px; border-radius:6px;";
      row.innerHTML = `
        <span style="color:${color}; font-weight:bold; text-shadow: 0 0 5px ${color};">${display}</span>
        <button class="del-name-btn" data-name="${key}" style="background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:16px; line-height:1;">×</button>
      `;
      list.appendChild(row);
    }
    
    list.querySelectorAll(".del-name-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const name = e.target.getAttribute("data-name");
        delete nameColors[name];
        saveNameColors();
        renderNameColorList();
        applyNameColors();
      });
    });
  }
  renderNameColorList();

  nameColorBtn.addEventListener("click", () => {
    nameColorMenu.style.display = nameColorMenu.style.display === "flex" ? "none" : "flex";
  });

  document.getElementById("add-name-color-btn").addEventListener("click", () => {
    const nameInput = document.getElementById("new-name-input");
    const colorInput = document.getElementById("new-color-input");
    const name = nameInput.value.trim().toLowerCase();
    const color = colorInput.value;
    if (name) {
      nameColors[name] = color;
      saveNameColors();
      nameInput.value = "";
      renderNameColorList();
      applyNameColors();
    }
  });

  document.getElementById("update-last-msg-btn").addEventListener("click", () => {
    applyNameColors();
    showVnToast("Colors applied to visible messages.", false);
  });
  // ===== END NAME COLORS UI =====

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
  fogOverlay.innerHTML = '<div class="fog-layer fog-far"></div><div class="fog-layer fog-mid"></div><div class="fog-layer fog-near"></div><div class="fog-glow"></div>';
  document.body.appendChild(fogOverlay);

  const hazeOverlay = document.createElement("div");
  hazeOverlay.id = "ambient-haze-overlay";
  document.body.appendChild(hazeOverlay);

  const lightningOverlay = document.createElement("div");
  lightningOverlay.id = "ambient-lightning-overlay";
  document.body.appendChild(lightningOverlay);

  const fieryOverlay = document.createElement("div");
  fieryOverlay.id = "ambient-fiery-overlay";
  document.body.appendChild(fieryOverlay);

  const lovelyHeartsOverlay = document.createElement("div");
  lovelyHeartsOverlay.id = "ambient-lovely-hearts-overlay";
  document.body.appendChild(lovelyHeartsOverlay);

  const darknessOverlay = document.createElement("div");
  darknessOverlay.id = "ambient-darkness-overlay";
  document.body.appendChild(darknessOverlay);

  const vnBtn = document.createElement("button");
  vnBtn.id = "vn-continue-btn";
  vnBtn.innerHTML = "▼";
  vnBtn.addEventListener("click", advanceVNText);
  document.body.appendChild(vnBtn);

  const vnBackBtn = document.createElement("button");
  vnBackBtn.id = "vn-back-btn";
  vnBackBtn.innerHTML = "▲";
  vnBackBtn.title = "Back one paragraph";
  vnBackBtn.addEventListener("click", retreatVNText);
  document.body.appendChild(vnBackBtn);

  const vnParagraphIndicator = document.createElement("div");
  vnParagraphIndicator.id = "vn-paragraph-indicator";
  vnParagraphIndicator.textContent = "1 / 1";
  document.body.appendChild(vnParagraphIndicator);

  const vnRestoreBtn = document.createElement("button");
  vnRestoreBtn.id = "vn-restore-btn";
  vnRestoreBtn.textContent = "↶ Restore";
  vnRestoreBtn.title = "Restore the last message before it was cut";
  vnRestoreBtn.style.display = "none";
  vnRestoreBtn.addEventListener("click", restoreLastCutMessage);
  document.body.appendChild(vnRestoreBtn);

  const vnToast = document.createElement("div");
  vnToast.id = "vn-toast";
  vnToast.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #22c55e; color: white; padding: 10px 20px; border-radius: 8px;
    font-weight: bold; z-index: 2147483647; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  `;
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

  const savedIntensity = localStorage.getItem("ambient_intensity") || "80";
  document.getElementById("set-intensity").value = savedIntensity;
  document.getElementById("intensity-val").textContent = savedIntensity;

  const manualCheckbox = document.getElementById("set-manual-mode");
  manualCheckbox.checked = localStorage.getItem("ambient_manual_mode") === "true";
  document.getElementById("manual-controls").style.display = manualCheckbox.checked ? "flex" : "none";

  const vnCheckbox = document.getElementById("set-vn-mode");
  vnCheckbox.checked = localStorage.getItem("ambient_vn_mode") === "true";

  const cinematicCheckbox = document.getElementById("set-cinematic-mode");
  cinematicCheckbox.checked = localStorage.getItem("ambient_cinematic_mode") === "true";
  document.body.classList.toggle("ambient-cinematic-active", cinematicCheckbox.checked);

  const vnTypewriterCheckbox = document.getElementById("set-vn-typewriter");
  vnTypewriterCheckbox.checked = localStorage.getItem("ambient_vn_typewriter") === "true";

  const vnTypewriterSpeed = document.getElementById("set-vn-typewriter-speed");
  vnTypewriterSpeed.value = localStorage.getItem("ambient_vn_typewriter_speed") || "45";
  document.getElementById("vn-speed-value").textContent = `${vnTypewriterSpeed.value} ms/word`;
  vnTypewriterSpeed.addEventListener("input", e => {
    localStorage.setItem("ambient_vn_typewriter_speed", e.target.value);
    document.getElementById("vn-speed-value").textContent = `${e.target.value} ms/word`;
  });

  const vnPunctPause = document.getElementById("set-vn-punct-pause");
  vnPunctPause.value = String(vnPunctPercent());
  document.getElementById("vn-punct-value").textContent = `${vnPunctPause.value}%`;
  vnPunctPause.addEventListener("input", e => {
    localStorage.setItem("ambient_vn_punct_pause", e.target.value);
    document.getElementById("vn-punct-value").textContent = `${e.target.value}%`;
  });

  const vnAutoSendCheckbox = document.getElementById("set-vn-autosend");
  vnAutoSendCheckbox.checked = vnAutoSend();

  const cutNoteOnCheckbox = document.getElementById("set-vn-cutnote-on");
  cutNoteOnCheckbox.checked = vnCutNoteEnabled();
  const cutNoteInput = document.getElementById("set-vn-cutnote");
  cutNoteInput.value = localStorage.getItem("ambient_vn_cutnote") ?? VN_CUTNOTE_DEFAULT;
  cutNoteInput.disabled = !cutNoteOnCheckbox.checked;

  const aiNameColorsCheckbox = document.getElementById("set-ai-name-colors");
  aiNameColorsCheckbox.checked = localStorage.getItem("ambient_ai_name_colors") === "true";

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
    if (!e.target.checked) vnReset();
  });

  cinematicCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_cinematic_mode", e.target.checked);
    document.body.classList.toggle("ambient-cinematic-active", e.target.checked);
  });

  vnTypewriterCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_vn_typewriter", e.target.checked);
  });

  vnAutoSendCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_vn_autosend", e.target.checked);
  });

  cutNoteOnCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_vn_cutnote_on", e.target.checked);
    cutNoteInput.disabled = !e.target.checked;
  });
  cutNoteInput.addEventListener("input", (e) => {
    localStorage.setItem("ambient_vn_cutnote", e.target.value);
  });

  aiNameColorsCheckbox.addEventListener("change", (e) => {
    localStorage.setItem("ambient_ai_name_colors", e.target.checked);
  });

  document.getElementById("manual-audio").addEventListener("change", (e) => {
    if (!e.target.value) return;
    applyAmbience({ music: e.target.value });
  });

  document.getElementById("manual-effect").addEventListener("change", (e) => {
    const intensity = Number(localStorage.getItem("ambient_intensity") || 80);
    applyAmbience({ effect: e.target.value, intensity: intensity });
  });

  let intensityDebounce = null;
  document.getElementById("set-intensity").addEventListener("input", (e) => {
    localStorage.setItem("ambient_intensity", e.target.value);
    document.getElementById("intensity-val").textContent = e.target.value;
    clearTimeout(intensityDebounce);
    intensityDebounce = setTimeout(() => {
      if (localStorage.getItem("ambient_manual_mode") === "true" && currentEffect !== "none") {
        setWeather(currentEffect, Number(e.target.value));
      }
    }, 250);
  });

  document.getElementById("save-settings").addEventListener("click", () => {
    localStorage.setItem("ambient_api_key", document.getElementById("set-api-key").value.trim());
    localStorage.setItem("ambient_model", document.getElementById("set-model").value.trim());
    localStorage.setItem("ambient_proxy", document.getElementById("set-proxy").value.trim());
    localStorage.setItem("ambient_cf_account", document.getElementById("set-cf-account").value.trim());
    localStorage.setItem("ambient_cf_token", document.getElementById("set-cf-token").value.trim());
    localStorage.setItem("ambient_blur", document.getElementById("set-blur").value);
    localStorage.setItem("ambient_dim", document.getElementById("set-dim").value);
    localStorage.setItem("ambient_intensity", document.getElementById("set-intensity").value);
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

    if (vnEnabled()) {
      vn.pending = true;
      vn.pendingSince = Date.now();
      vnLog("bot message saved, waiting for it to appear in the page");
      queueVNSync();
    }

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
    if (t && t.tagName === "TEXTAREA" && !t.closest("li")) handleIntercept(e);
  }, true);

  startVNObserver();
  setInterval(applyNameColors, 1000); // Syncs names every second
})();

// ===== VISUAL NOVEL ENGINE =====
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
  vnObserver = new MutationObserver(queueVNSync);
  vnObserver.observe(document.body, VN_OBS_OPTS);
  setInterval(queueVNSync, 1000);
}

function clearHidden() {
  document.querySelectorAll(".vn-hidden-text").forEach(el => el.classList.remove("vn-hidden-text"));
  document.querySelectorAll(".vn-read-text").forEach(el => el.classList.remove("vn-read-text")); // <-- Added
}

function vnReset() {
  vn.active = false;
  vn.pending = false;
  vn.msgEl = null;
  vn.total = 0;
  stopVNTypewriter();
  if (document.querySelector(".vn-hidden-text, .vn-read-text")) vnMutate(clearHidden);
  const btn = document.getElementById("vn-continue-btn");
  if (btn) btn.style.display = "none";
  const back = document.getElementById("vn-back-btn");
  if (back) back.style.display = "none";
}

function findVNMessage(items) {
  if (vn.msgEl && vn.msgEl.isConnected) return vn.msgEl;
  const last = items[items.length - 1];
  if (last && vn.text) {
    const t = fullText(getVNBlocks(last));
    if (t && sameStart(t, vn.text)) return last;
  }
  return null;
}

let vnTypingBlock = null;
let vnTypingTimer = null;
let vnTypingWords = [];
let vnTypingIndex = 0;
let vnTypingFast = false;

function stopVNTypewriter() {
  if (vnTypingTimer) clearTimeout(vnTypingTimer);
  if (vnTypingBlock) {
    vnTypingWords.forEach(w => { w.style.visibility = "visible"; });
    vnTypingBlock.dataset.vnTypedOnce = "1";
    delete vnTypingBlock.dataset.vnTyping;
  }
  vnTypingTimer = null;
  vnTypingBlock = null;
  vnTypingWords = [];
  vnTypingIndex = 0;
  vnTypingFast = false;
}

function finishVNTypewriter() {
  if (!vnTypingBlock) return;
  if (vnTypingTimer) clearTimeout(vnTypingTimer);
  vnTypingTimer = null;
  vnTypingWords.forEach(w => { w.style.visibility = "visible"; });
  vnTypingBlock.dataset.vnTypedOnce = "1";
  delete vnTypingBlock.dataset.vnTyping;
  vnTypingBlock = null;
  vnTypingWords = [];
  vnTypingIndex = 0;
  vnTypingFast = false;
}

function vnPunctuationPause(raw) {
  const w = raw.replace(/[\s"'\u201d\u2019\u00bb)\]}*_~`]+$/g, "");
  if (!w) return 0;
  if (/^(mr|mrs|ms|dr|st|prof|sr|jr|vs|etc|e\.g|i\.e)\.$/i.test(w)) return 0;
  if (/(\.{2,}|\u2026)$/.test(w)) return 780;
  if (/[?!]{2,}$|[?!]\.+$/.test(w)) return 680;
  if (/[.!?]$/.test(w)) return 540;
  if (/(\u2014|\u2013|--)$/.test(w)) return 280;
  if (/[;:]$/.test(w)) return 320;
  if (/,$/.test(w)) return 200;
  return 0;
}

function startVNTypewriter(block) {
  stopVNTypewriter();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const words = [];
  nodes.forEach(node => {
    if (!node.nodeValue || !node.nodeValue.trim()) return;
    const frag = document.createDocumentFragment();
    const pieces = node.nodeValue.match(/\s+|[^\s]+/g) || [];
    pieces.forEach(piece => {
      if (/^\s+$/.test(piece)) { frag.appendChild(document.createTextNode(piece)); return; }
      const span = document.createElement("span");
      span.className = "vn-typeword";
      span.textContent = piece;
      span.style.visibility = "hidden";
      frag.appendChild(span);
      words.push(span);
    });
    node.parentNode.replaceChild(frag, node);
  });
  if (!words.length) { block.dataset.vnTypedOnce = "1"; return; }
  vnTypingBlock = block;
  block.dataset.vnTypedOnce = "typing";
  vnTypingWords = words;
  vnTypingIndex = 0;
  block.dataset.vnTyping = "1";
  const tick = () => {
    if (!vnTypingBlock || !vnTypingBlock.isConnected) { stopVNTypewriter(); return; }
    const word = vnTypingWords[vnTypingIndex];
    if (!word) { finishVNTypewriter(); return; }
    word.style.visibility = "visible";
    vnTypingIndex++;
    const text = word.textContent;
    let pause = Number(localStorage.getItem("ambient_vn_typewriter_speed") || 45);
    pause += Math.max(0, text.length - 6) * 4;
    pause += vnPunctuationPause(text) * (vnPunctPercent() / 100);
    pause *= 0.88 + Math.random() * 0.24;
    if (vnTypingFast) pause = Math.min(8, pause / 8);
    vnTypingTimer = setTimeout(tick, pause);
  };
  tick();
}

document.addEventListener("pointerdown", e => {
  if (!vnTypingBlock) return;
  if (e.target.closest("#ambient-settings-menu, #ambient-settings-btn, #vn-continue-btn, #vn-back-btn, #vn-restore-btn, input, textarea, button, select, a")) return;
  finishVNTypewriter();
}, true);

function applyVN(blocks) {
  const btn = document.getElementById("vn-continue-btn");
  const back = document.getElementById("vn-back-btn");
  vn.total = blocks.length;
  if (!blocks.length) { if (btn) btn.style.display = "none"; if (back) back.style.display = "none"; return; }
  if (vn.revealed > blocks.length) vn.revealed = blocks.length;
  if (vn.revealed < 1) vn.revealed = 1;

  vnMutate(() => {
    const live = new Set(blocks);
    document.querySelectorAll(".vn-hidden-text, .vn-read-text").forEach(el => { 
      if (!live.has(el)) { el.classList.remove("vn-hidden-text"); el.classList.remove("vn-read-text"); }
    });
    blocks.forEach((b, i) => {
      b.classList.toggle("vn-hidden-text", i >= vn.revealed);
      // <-- Added: previous paragraphs become 50% transparent
      b.classList.toggle("vn-read-text", i < vn.revealed - 1); 
      
      if (i === vn.revealed - 1 && localStorage.getItem("ambient_vn_typewriter") === "true" && !b.dataset.vnTypedOnce) {
        startVNTypewriter(b);
      }
    });
  });
  if (btn) btn.style.display = vn.revealed < blocks.length ? "flex" : "none";
  if (back) back.style.display = vn.revealed > 1 ? "flex" : "none";
  const indicator = document.getElementById("vn-paragraph-indicator");
  if (indicator) { indicator.textContent = `${vn.revealed} / ${blocks.length}`; indicator.style.display = blocks.length ? "block" : "none"; }
}

function vnSync() {
  vnSyncQueued = false;
  if (isCuttingMessage) return;
  applyNameColors();
  const btn = document.getElementById("vn-continue-btn");
  if (!btn) return;

  if (!vnEnabled() || !isChatPage()) { if (vn.active || vn.pending) vnReset(); return; }
  if (!vn.active && !vn.pending) return;

  const items = getMessageItems();

  if (vn.pending) {
    if (Date.now() - vn.pendingSince > 15000) { vn.pending = false; vnLog("gave up waiting for the new message"); return; }
    const last = items[items.length - 1];
    const blocks = last ? getVNBlocks(last) : [];
    if (!blocks.length) return;
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
  if (!li) {
    btn.style.display = "none";
    const back = document.getElementById("vn-back-btn");
    if (back) back.style.display = "none";
    return;
  }

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
  const blocks = getVNBlocks(li);
  vn.revealed = Math.min(vn.revealed + 1, blocks.length);
  applyVN(blocks);
  const shown = blocks[vn.revealed - 1];
  if (shown) shown.scrollIntoView({ behavior: "smooth", block: "center" });
}

function retreatVNText() {
  if (!vn.active) return;
  const li = findVNMessage(getMessageItems());
  if (!li) return;
  const blocks = getVNBlocks(li);
  vn.revealed = Math.max(vn.revealed - 1, 1);
  applyVN(blocks);
  const shown = blocks[vn.revealed - 1];
  if (shown) shown.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function restoreLastCutMessage() {
  if (!vn.restoreData) return;
  const li = getMessageItems().pop();
  if (!li) { showVnToast("Can't find the message to restore.", true); return; }
  const editBtn = findButton(li, "edit");
  if (!editBtn) { showVnToast("Couldn't find the message's Edit button.", true); return; }
  editBtn.click();
  let ta = null;
  for (let i = 0; i < 30 && !ta; i++) { await sleep(100); const c = getMessageItems().pop(); ta = c && c.querySelector("textarea"); }
  if (!ta) { showVnToast("The edit box didn't open.", true); return; }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  ta.focus(); setter.call(ta, vn.restoreData.original);
  ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(350);
  const current = getMessageItems().pop(); const saveBtn = findButton(current, "save");
  if (saveBtn) saveBtn.click(); else ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  for (let i = 0; i < 40; i++) { await sleep(100); const c = getMessageItems().pop(); if (!c || !c.querySelector("textarea")) break; }
  vn.restoreData = null; const btn = document.getElementById("vn-restore-btn"); if (btn) btn.style.display = "none";
  showVnToast("↶ Original message restored.", false);
}

async function cancelEdit(li) {
  const cancel = findButton(li, "cancel");
  if (cancel) cancel.click();
  else {
    const ta = li && li.querySelector("textarea");
    if (ta) ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  }
  await sleep(300);
}

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
  vn._restoreOriginal = raw;
  const cutIdx = computeCutIndex(raw, visibleTexts, total, names);
  vnLog("cut index", cutIdx, "of", raw.length, "| revealed", visibleTexts.length, "of", total);

  if (cutIdx < 1) {
    await cancelEdit(cur());
    return { ok: false, reason: "couldn't match what you read to the message source, left it untouched" };
  }
  const newText = raw.slice(0, cutIdx).trimEnd();
  if (!newText) { await cancelEdit(cur()); return { ok: false, reason: "cut would have been empty" }; }
  if (newText.length >= raw.trimEnd().length) { await cancelEdit(cur()); return { ok: true, unchanged: true }; }

  let finalText = newText;
  if (vnCutNoteEnabled()) {
    const note = vnCutNoteText();
    if (note) finalText = newText + "\n\n" + note;
  }

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  ta.focus();
  setter.call(ta, finalText);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);

  const saveBtn = findButton(cur(), "save");
  if (saveBtn) saveBtn.click();
  else ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));

  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const c = cur();
    if (!c || !c.querySelector("textarea")) break;
  }
  const c = cur();
  if (c && c.querySelector("textarea")) {
    await cancelEdit(c);
    return { ok: false, reason: "saving the edit didn't go through" };
  }
  await sleep(500);
  return { ok: true };
}

async function handleIntercept(e) {
  if (vnBypass) return;
  if (isCuttingMessage) { e.preventDefault(); e.stopPropagation(); return; }
  if (!vnEnabled() || !isChatPage() || !vn.active) return;

  const li = findVNMessage(getMessageItems());
  if (!li) return;
  const blocks = getVNBlocks(li);
  if (vn.revealed >= blocks.length) return;

  e.preventDefault();
  e.stopPropagation();
  isCuttingMessage = true;
  const btn = document.getElementById("vn-continue-btn");
  if (btn) btn.style.display = "none";
  const backBtn = document.getElementById("vn-back-btn");
  if (backBtn) backBtn.style.display = "none";

  const readCount = vn.revealed;
  let result;
  try { result = await cutMessage(li, blocks); }
  catch (err) { console.error("[VN] cut crashed:", err); result = { ok: false, reason: "unexpected error (see console)" }; }

  vn.ignoreSignalsUntil = Date.now() + 3000;
  isCuttingMessage = false;
  vnReset();

  if (!result.ok) {
    vn._restoreOriginal = null;
    return;
  }

  if (!result.unchanged && vn._restoreOriginal) {
    vn.restoreData = { original: vn._restoreOriginal, createdAt: Date.now() };
    const restoreBtn = document.getElementById("vn-restore-btn");
    if (restoreBtn) restoreBtn.style.display = "block";
  }
  vn._restoreOriginal = null;

  if (vnAutoSend()) {
    await sleep(250);
    const sendBtn = document.querySelector('button[aria-label="Send" i], button[title="Send" i]');
    if (sendBtn && !sendBtn.disabled) {
      vnBypass = true;
      try { sendBtn.click(); } finally { vnBypass = false; }
      return;
    }
  }
}

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

function applyVisualSettings(blur, dim) {
  document.documentElement.style.setProperty('--ambient-blur', `${blur}px`);
  document.documentElement.style.setProperty('--ambient-dim', dim / 100);
}

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

function resizeCanvas() {
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
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

async function askAI(chatText, availableAudio, apiKey) {
  setDotState("dot-orch", "loading"); 
  const model = localStorage.getItem("ambient_model") || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const proxyUrl = localStorage.getItem("ambient_proxy") || "https://openrouter.ai/api/v1/chat/completions";

  let memoryPrompt = "";
  if (lastDecision) {
    memoryPrompt = `\nIMPORTANT MEMORY: The previous background prompt was "${currentBackgroundPrompt}". Only output a new background if the location, the user's viewpoint, or the time of day / lighting has clearly changed (see background rule 6); otherwise output "none". Do not change the music unless the scene or mood changes substantially.`;
  }

  const systemPrompt = `You are an ambient engine for a roleplay. Based on the chat, decide the background, music, weather, and its intensity.
  Output ONLY a valid JSON object with the exact keys "background", "music", "effect", "intensity", "name_colors", and "reasoning".

  CRITICAL RULES FOR BACKGROUNDS:
  1. "background" is a prompt for an image generator: 20-35 words, comma-separated phrases, in this order:
     (a) the specific place,
     (b) the viewpoint: what the user's eyes would see from where they are right now (e.g. "eye-level view from the doorway looking across the room", "wide view from the porch steps down the garden path"),
     (c) the time of day and the light it casts,
     (d) the weather / atmosphere that is visible,
     (e) 2-4 concrete, inanimate details that are mentioned or strongly implied in the recent messages (furniture, props, architecture, plants, food, parked vehicles with nobody in them).
  2. TIME OF DAY: work it out from the chat (explicit mentions, sky, light sources, lamps, candles, meals, sunrise/sunset, activities). Use specific lighting words such as "pale dawn light", "harsh midday sun", "warm golden hour", "deep blue dusk", "moonlit night", "dim candlelight", "overcast grey daylight". If nothing indicates the time, keep the time of day of the previous background; if there is none, pick one that fits the mood.
  3. VIEWPOINT: base it on the MOST RECENT messages. Where is the user standing or sitting right now, and what is in front of them? Indoors: the room as seen from their position. Outdoors: the vista in front of them. It must read as a still, wide, eye-level visual novel background.
  4. The style MUST be an anime visual novel background.
  5. ABSOLUTELY NO living beings: no humans, characters, silhouettes, crowds, faces, body parts, animals, birds, insects or creatures, not even tiny or distant ones. No statues, portraits, mannequins or dolls either. Describe only places and objects. If characters are in the scene, describe their surroundings and leave the spot where they stand empty.
  6. Only provide a new background prompt when the scene meaningfully changes: a new location, a different viewpoint inside the same location (e.g. moved from the room to the balcony), or a clear shift in time of day / lighting (e.g. afternoon turning to dusk). Otherwise output "none" to save API calls. When you do output a new one, reuse the wording of anything that has not changed (place, props) so consecutive scenes stay consistent.
  7. The weather you mention in the background must match the "effect" you choose (e.g. wet ground and grey sky when raining, drifting mist when foggy) so the image and the animated overlay agree.
  8. STRICTLY FORBIDDEN WORDS: Never use words related to anatomy, biology, violence, or gore. (e.g., instead of "veins", use "cracks" or "lines"; instead of "flesh", use "stone" or "wood"). The image generator has a strict safety filter.

  CRITICAL RULES FOR WEATHER EFFECTS:
  1. Outdoor weather (rain, snow, thunderstorm, blizzard) must ONLY be used if the characters are currently outside. If they are indoors, output "none" for the effect.
  2. "fog" and the fire effects ("fiery" or any "fire-*" variant) can be used indoors or outdoors if contextually appropriate.

  CRITICAL RULES FOR INTENSITY:
  "intensity" is an integer from 0 to 100 that controls how strong the "effect" is.
  - 0-20: barely noticeable. Light drizzle, a few drifting leaves, faint mist, a soft glow.
  - 20-40: gentle. Steady light rain, a handful of snowflakes, thin fog, a small campfire.
  - 40-60: moderate. Normal rain, ordinary snowfall, rolling fog, a healthy fire.
  - 60-80: strong. Heavy rain, thick snow, dense fog, roaring flames, bright magic.
  - 80-100: intense. Torrential downpour, blinding blizzard, impenetrable fog, raging inferno, blinding stardust.
  Match it to the scene: a light spring shower should be 20-30, a violent thunderstorm 85-100, a few petals in a garden 15-25, a field of falling leaves 40-60, a magical display 60-90, a dark ominous room (darkness) 50-80.
  Always output a number for intensity, even when effect is "none"; it will be ignored in that case.

  CRITICAL RULES FOR NAME COLORS:
  Analyze the recent chat. Identify the names of the characters involved. Assign a fitting hex color to each character (e.g. warm colors for aggressive characters, cool colors for calm ones). Only include names of characters explicitly present in the text. Do not make up names for unnamed characters. Return a dictionary mapping names to hex colors in the "name_colors" key. If there is no new information, you can return an empty object {}.

  Available music: ${JSON.stringify(availableAudio)}
  Available effects: ["none", "rain", "fog", "thunderstorm", "fiery", "fire-red", "fire-yellow", "fire-green", "fire-blue", "fire-cyan", "fire-purple", "fire-pink", "fire-white", "fire-black", "snow", "blizzard", "petal-pink", "leaf-orange", "leaf-red", "leaf-yellow", "leaf-green", "leaf-cyan", "leaf-blue", "leaf-purple", "leaf-white", "leaf-gold", "leaf-black", "lovely-hearts", "darkness", "stars", "aurora", "magic-red", "magic-orange", "magic-yellow", "magic-green", "magic-cyan", "magic-blue", "magic-purple", "magic-pink", "magic-white", "magic-gold", "magic-black"].
  Magical color effects, stardust, aurora, and lovely hearts can be used indoors or outdoors when the scene supports them. Petals, colored leaves, and colored fire should fit the setting; darkness is a dramatic low-light overlay. Keep all effects subtle enough not to obscure chat text.${memoryPrompt}`;

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

const BG_LIVING_WORDS = /\b(people|person|persons|someone|somebody|man|men|woman|women|girl|girls|boy|boys|child|children|kid|kids|human|humans|figure|figures|silhouette|silhouettes|crowd|crowds|character|characters|couple|stranger|strangers|traveler|travelers|traveller|travellers|pedestrian|pedestrians|villager|villagers|animal|animals|bird|birds|cat|cats|dog|dogs|horse|horses|creature|creatures|insect|insects|butterfly|butterflies|statue|statues|portrait|portraits|mannequin|mannequins|doll|dolls)\b/i;
function sanitizeBackgroundPrompt(prompt) {
  const clauses = String(prompt).split(",").map(c => c.trim()).filter(Boolean);
  const kept = clauses.filter(c => !BG_LIVING_WORDS.test(c));
  if (kept.length !== clauses.length) {
    console.warn("[Ambient] Removed living-being clauses from background prompt:", clauses.filter(c => BG_LIVING_WORDS.test(c)));
  }
  return kept.join(", ");
}

function applyAmbience(decision) {
  console.log("Applying Ambience:", decision);

  if (decision.background && decision.background.toLowerCase() !== "none") {
    const cleanedBg = sanitizeBackgroundPrompt(decision.background);
    if (cleanedBg && cleanedBg !== currentBackgroundPrompt) {
      currentBackgroundPrompt = cleanedBg;
      generateCloudflareBackground(currentBackgroundPrompt);
    }
  }

  if (decision.music && decision.music.toLowerCase() !== "none" && decision.music !== currentMusic) {
    if (cachedAudio.length === 0) {
      console.log("[Ambient] Music requested but no audio files are available — skipping.");
    } else if (!cachedAudio.includes(decision.music)) {
      console.warn("[Ambient] Music requested but not in audio folder:", decision.music);
    } else {
      currentMusic = decision.music;
      const newAudioUrl = chrome.runtime.getURL(currentMusic);
      crossfadeAudio(newAudioUrl);
    }
  }

  if (decision.effect) {
    const newIntensity = (decision.intensity !== undefined && decision.intensity !== null)
      ? Number(decision.intensity)
      : Number(localStorage.getItem("ambient_intensity") || 80);

    if (decision.effect !== currentEffect || newIntensity !== currentIntensity) {
      setWeather(decision.effect, newIntensity);
    }
  }

  if (localStorage.getItem("ambient_ai_name_colors") === "true" && decision.name_colors) {
    let changed = false;
    for (const [rawName, color] of Object.entries(decision.name_colors)) {
      const name = rawName.trim().toLowerCase();
      if (name && color && nameColors[name] !== color) {
        nameColors[name] = color;
        changed = true;
      }
    }
    if (changed) {
      saveNameColors();
      applyNameColors();
    }
  }
}

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
function setWeather(effect, intensity) {
  currentEffect = effect;

  let intVal = Number(intensity);
  if (!isFinite(intVal)) intVal = currentIntensity;
  intVal = Math.max(0, Math.min(100, intVal));
  currentIntensity = intVal;

  const mul       = 0.15 + (intVal / 100) * 1.15;
  const overlayOp = 0.15 + (intVal / 100) * 0.85;
  const cnt = (base) => Math.max(1, Math.round(base * mul));

  console.log("Setting Weather:", effect, "| intensity:", intVal);
  canvas.style.opacity = 0;
  isAnimating = false;
  if (animationId) cancelAnimationFrame(animationId);

  setTimeout(() => {
    particles = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fogOverlay = document.getElementById("ambient-fog-overlay");
    const hazeOverlay = document.getElementById("ambient-haze-overlay");
    const fieryOverlay = document.getElementById("ambient-fiery-overlay");
    const lightningOverlay = document.getElementById("ambient-lightning-overlay");
    const lovelyHeartsOverlay = document.getElementById("ambient-lovely-hearts-overlay");
    const darknessOverlay = document.getElementById("ambient-darkness-overlay");
    fogOverlay.style.opacity = 0;
    hazeOverlay.style.opacity = 0;
    fieryOverlay.style.opacity = 0;
    lightningOverlay.style.opacity = 0;
    lovelyHeartsOverlay.style.opacity = 0;
    darknessOverlay.style.opacity = 0;
    if (lightningInterval) clearInterval(lightningInterval);

    if (effect === "none") { canvas.style.opacity = 1; return; }
    if (effect === "fog")  { fogOverlay.style.opacity = overlayOp; canvas.style.opacity = 1; return; }

    if (effect === "fiery" || effect.startsWith("fire-")) {
      fieryOverlay.style.opacity = overlayOp;
      
      const firePalette = FIRE_COLORS[effect] || FIRE_COLORS["fiery"];
      const hexToRgb = hex => {
         let r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
         return `${r},${g},${b}`;
      };
      const mainRgb = hexToRgb(firePalette.main);
      const darkRgb = hexToRgb(firePalette.dark);
      
      fieryOverlay.style.background = `
        radial-gradient(circle at 50% 110%, rgba(${mainRgb}, 0.65) 0%, transparent 60%),
        radial-gradient(circle at 50% 50%, transparent 40%, rgba(${darkRgb}, 0.55) 100%)
      `;

      for (let i = 0; i < cnt(80); i++) particles.push(new Particle(effect, intVal));
    } else if (effect === "thunderstorm") {
      for (let i = 0; i < cnt(200); i++) particles.push(new Particle("rain", intVal));
      const interval = Math.max(700, 4200 - intVal * 32);
      const chance   = 0.4 + (intVal / 100) * 0.5;
      const maxFlash = 0.15 + (intVal / 100) * 0.4;
      lightningInterval = setInterval(() => {
        if (currentEffect !== "thunderstorm" || Math.random() > chance) return;
        lightningOverlay.style.opacity = Math.random() * maxFlash * 0.7 + maxFlash * 0.3;
        setTimeout(() => lightningOverlay.style.opacity = 0, 90);
        setTimeout(() => {
          if (currentEffect !== "thunderstorm") return;
          lightningOverlay.style.opacity = Math.random() * maxFlash * 0.4 + maxFlash * 0.15;
          setTimeout(() => lightningOverlay.style.opacity = 0, 130);
        }, 170);
      }, interval);
    } else if (effect === "rain") {
      for (let i = 0; i < cnt(200); i++) particles.push(new Particle("rain", intVal));
    } else if (effect === "snow") {
      for (let i = 0; i < cnt(150); i++) particles.push(new Particle("snow", intVal));
    } else if (effect === "blizzard") {
      for (let i = 0; i < cnt(240); i++) particles.push(new Particle("blizzard", intVal));
    } else if (effect === "petal-pink" || effect === "leaf-orange" || effect === "petals" || effect === "leaves" || effect.startsWith("leaf-")) {
      for (let i = 0; i < cnt(55); i++) particles.push(new Particle(effect, intVal));
    } else if (effect === "lovely-hearts") {
      lovelyHeartsOverlay.style.opacity = overlayOp;
      for (let i = 0; i < cnt(28); i++) particles.push(new Particle(effect, intVal));
    } else if (effect === "darkness") {
      darknessOverlay.style.opacity = overlayOp;
      canvas.style.opacity = 1;
      return;
    } else if (effect === "stars" || effect === "aurora") {
      for (let i = 0; i < cnt(effect === "stars" ? 95 : 65); i++) particles.push(new Particle(effect, intVal));
      if (effect === "aurora") hazeOverlay.style.opacity = 0.45 * overlayOp;
    } else if (effect.startsWith("magic-")) {
      for (let i = 0; i < cnt(90); i++) particles.push(new Particle(effect, intVal));
    } else {
      canvas.style.opacity = 1;
      return;
    }
    isAnimating = true;
    animateWeather();
    canvas.style.opacity = 1;
  }, 250);
}

const MAGIC_COLORS = {
  "magic-red": "#ff4568", "magic-orange": "#ff9d42", "magic-yellow": "#ffe66d",
  "magic-green": "#65f59a", "magic-cyan": "#5cf6ed", "magic-blue": "#65a7ff",
  "magic-purple": "#bd83ff", "magic-pink": "#ff83d0", "magic-white": "#ffffff",
  "magic-gold": "#ffd36a", "magic-black": "#8b75ad"
};
const LEAF_COLORS = {
  "leaf-orange": "#d99a48",
  "leaf-red": "#ef5263", "leaf-yellow": "#f5df62", "leaf-green": "#65c96b",
  "leaf-cyan": "#55ded8", "leaf-blue": "#659cff", "leaf-purple": "#b38aff",
  "leaf-white": "#f5f4ff", "leaf-gold": "#e8b64d", "leaf-black": "#777184"
};
const FIRE_COLORS = {
  "fiery":      { main: "#ff5e00", dark: "#330800" },
  "fire-red":   { main: "#ff2a2a", dark: "#330000" },
  "fire-yellow":{ main: "#ffd700", dark: "#332b00" },
  "fire-green": { main: "#39ff14", dark: "#0a3300" },
  "fire-blue":  { main: "#00bfff", dark: "#002233" },
  "fire-cyan":  { main: "#00ffff", dark: "#003333" },
  "fire-purple":{ main: "#aa00ff", dark: "#220033" },
  "fire-pink":  { main: "#ff1493", dark: "#33001e" },
  "fire-white": { main: "#ffffff", dark: "#333333" },
  "fire-black": { main: "#8a2be2", dark: "#050005" } // dark shadowflame
};

class Particle {
  constructor(type, intensity = 80) {
    this.type = type;

    let intVal = Number(intensity);
    if (!isFinite(intVal)) intVal = 80;
    intVal = Math.max(0, Math.min(100, intVal));
    this.speedMul    = 0.6 + (intVal / 100) * 0.8;
    this.opacityMul  = 0.7 + (intVal / 100) * 0.5;

    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.depth = Math.random() * 0.8 + 0.2;
    this.phase = Math.random() * Math.PI * 2;
    this.sway = Math.random() * Math.PI * 2;
    this.swaySpeed = Math.random() * 0.025 + 0.008;
    this.radius = Math.random() * 2.5 + 1;
    this.opacity = (Math.random() * 0.45 + 0.25) * this.opacityMul;
    
    this.color = MAGIC_COLORS[type] || LEAF_COLORS[type] || (type === "petal-pink" ? "#ff9fce" : type === "petals" ? "#ff9fce" : type === "leaf-orange" ? "#d99a48" : type === "leaves" ? "#d99a48" : type === "lovely-hearts" ? "#ff9acb" : "#ffffff");
    if (FIRE_COLORS[type]) this.color = FIRE_COLORS[type].main;
    else if (type === "ember") this.color = FIRE_COLORS["fiery"].main;

    if (type === "rain") {
      this.vy = (Math.random() * 10 + 15) * this.depth;
      this.vx = -3 * this.depth;
      this.length = (Math.random() * 20 + 10) * this.depth;
    } else if (type === "snow") {
      this.vy = (Math.random() * 1.5 + 1) * this.depth;
      this.vx = (Math.random() - 0.5) * this.depth;
    } else if (type === "blizzard") {
      this.vy = (Math.random() * 5 + 4) * this.depth;
      this.vx = (Math.random() * 6 - 3) * this.depth;
    } else if (type === "ember" || type === "fiery" || type.startsWith("fire-")) {
      const spawnSide = Math.random();
      if (spawnSide < 0.4) {
        this.x = Math.random() * canvas.width;
        this.y = canvas.height + 20;
        this.vx = (Math.random() - 0.5) * this.depth * 1.5;
        this.vy = -(Math.random() * 2 + 1) * this.depth;
      } else if (spawnSide < 0.7) {
        this.x = -20;
        this.y = Math.random() * canvas.height;
        this.vx = (Math.random() * 2 + 1) * this.depth;
        this.vy = -(Math.random() * 1.5 + 0.5) * this.depth;
      } else {
        this.x = canvas.width + 20;
        this.y = Math.random() * canvas.height;
        this.vx = -(Math.random() * 2 + 1) * this.depth;
        this.vy = -(Math.random() * 1.5 + 0.5) * this.depth;
      }
    } else if (type === "wind") {
      this.x = Math.random() * canvas.width;
      this.vx = (Math.random() * 3 + 2) * this.depth;
      this.vy = (Math.random() - 0.5) * 0.5;
      this.length = (Math.random() * 65 + 30) * this.depth;
    } else if (type === "petal-pink" || type === "leaf-orange" || type === "petals" || type === "leaves" || type.startsWith("leaf-")) {
      this.vy = (Math.random() * 1.8 + 0.5) * this.depth;
      this.vx = (Math.random() * 2 - 1) * this.depth;
      this.rotation = Math.random() * Math.PI * 2;
      this.rotationSpeed = (Math.random() - 0.5) * 0.08;
    } else if (type === "lovely-hearts") {
      this.y = canvas.height + Math.random() * canvas.height;
      this.vy = -(Math.random() * 1.15 + 0.35) * this.depth;
      this.vx = (Math.random() - 0.5) * 0.45;
      this.radius = Math.random() * 5 + 4;
      this.opacity = (Math.random() * 0.28 + 0.12) * this.opacityMul;
    } else if (type === "stars" || type === "aurora" || type.startsWith("magic-")) {
      this.vy = -(Math.random() * 0.8 + 0.15) * this.depth;
      this.vx = (Math.random() - 0.5) * 0.7;
      this.radius = Math.random() * (type === "stars" ? 2.4 : 3.1) + 0.8;
    }

    if (this.vx !== undefined) this.vx *= this.speedMul;
    if (this.vy !== undefined) this.vy *= this.speedMul;
    if (this.length !== undefined) this.length *= this.speedMul;
    if (this.rotationSpeed !== undefined) this.rotationSpeed *= this.speedMul;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.phase += this.swaySpeed;
    if (this.type === "snow" || this.type === "blizzard" || this.type === "petal-pink" || this.type === "leaf-orange" || this.type === "petals" || this.type === "leaves" || this.type.startsWith("leaf-")) {
      this.x += Math.sin(this.phase) * ((this.type === "leaf-orange" || this.type === "leaves" || this.type.startsWith("leaf-")) ? 1.8 : 1.1);
      if (this.type === "petal-pink" || this.type === "leaf-orange" || this.type === "petals" || this.type === "leaves" || this.type.startsWith("leaf-")) this.rotation += this.rotationSpeed;
    }
    if (this.type === "lovely-hearts") this.x += Math.sin(this.phase) * 0.35;
    if (this.y > canvas.height + 30) { this.y = -30; this.x = Math.random() * canvas.width; }
    if (this.y < -30 && (this.type === "ember" || this.type.startsWith("fire-") || this.type === "fiery" || this.type.startsWith("magic-") || this.type === "stars" || this.type === "aurora" || this.type === "lovely-hearts")) {
      this.y = canvas.height + 20; this.x = Math.random() * canvas.width;
    }
    if (this.x > canvas.width + 80) { this.x = -80; this.y = Math.random() * canvas.height; }
    if (this.x < -80) { this.x = canvas.width + 80; this.y = Math.random() * canvas.height; }
  }

  draw() {
    ctx.save();
    if (this.type === "rain") {
      ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(this.x + this.vx, this.y + this.length);
      ctx.strokeStyle = `rgba(180,210,255,${this.opacity})`; ctx.lineWidth = this.depth * 1.5; ctx.lineCap = "round"; ctx.stroke();
    } else if (this.type === "snow" || this.type === "blizzard") {
      ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${this.depth * 0.8 * this.opacityMul})`; ctx.shadowBlur = this.depth * 8; ctx.shadowColor = "white"; ctx.fill();
    } else if (this.type === "ember" || this.type === "fiery" || this.type.startsWith("fire-")) {
      ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.color; 
      ctx.shadowBlur = 12; 
      ctx.shadowColor = this.color; 
      ctx.globalAlpha = this.opacity;
      ctx.fill();
    } else if (this.type === "petal-pink" || this.type === "leaf-orange" || this.type === "petals" || this.type === "leaves" || this.type.startsWith("leaf-")) {
      ctx.translate(this.x, this.y); ctx.rotate(this.rotation);
      ctx.fillStyle = (this.type === "petal-pink" || this.type === "petals") ? `rgba(255,159,206,${this.opacity})` : (this.type === "leaf-orange" || this.type === "leaves") ? `rgba(${190 + Math.floor(Math.random()*50)},${100 + Math.floor(Math.random()*70)},45,${this.opacity})` : this.color;
      ctx.globalAlpha = this.opacity;
      ctx.beginPath();
      ctx.moveTo(-this.radius * 1.8, 0);
      ctx.quadraticCurveTo(-this.radius * 0.4, -this.radius * 1.25, this.radius * 1.8, 0);
      ctx.quadraticCurveTo(this.radius * 0.4, this.radius * 1.25, -this.radius * 1.8, 0);
      ctx.fill();
      ctx.beginPath(); ctx.moveTo(-this.radius * 1.5, 0); ctx.lineTo(this.radius * 1.45, 0);
      ctx.strokeStyle = this.color; ctx.globalAlpha = this.opacity * 0.6; ctx.lineWidth = 0.6; ctx.stroke();
    } else if (this.type === "lovely-hearts") {
      ctx.translate(this.x, this.y);
      ctx.globalAlpha = this.opacity * (0.8 + Math.sin(this.phase) * 0.2);
      ctx.fillStyle = this.color; ctx.shadowColor = "#ff7db9"; ctx.shadowBlur = 8;
      const r = this.radius;
      ctx.beginPath(); ctx.moveTo(0, r * 0.85);
      ctx.bezierCurveTo(-r * 1.8, -r * 0.25, -r * 0.85, -r * 1.45, 0, -r * 0.55);
      ctx.bezierCurveTo(r * 0.85, -r * 1.45, r * 1.8, -r * 0.25, 0, r * 0.85);
      ctx.fill();
    } else if (this.type === "stars" || this.type === "aurora" || this.type.startsWith("magic-")) {
      const color = this.type === "stars" ? "#fff4bf" : this.type === "aurora" ? (Math.random() > 0.5 ? "#71ffd5" : "#9c83ff") : this.color;
      ctx.globalAlpha = this.opacity * (0.65 + Math.sin(this.phase) * 0.35);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = this.type === "stars" ? 9 : 13;
      if (this.type.startsWith("magic-") && Math.random() > 0.58) {
        ctx.translate(this.x, this.y); ctx.rotate(Math.PI / 4 + this.phase * 0.15);
        ctx.fillRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2);
      } else {
        ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2); ctx.fill();
        if (this.type === "stars") { ctx.beginPath(); ctx.moveTo(this.x - 5, this.y); ctx.lineTo(this.x + 5, this.y); ctx.moveTo(this.x, this.y - 5); ctx.lineTo(this.x, this.y + 5); ctx.strokeStyle = color; ctx.lineWidth = 0.8; ctx.stroke(); }
      }
    }
    ctx.restore();
  }
}

function animateWeather() {
  if (!isAnimating) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => { p.update(); p.draw(); });
  animationId = requestAnimationFrame(animateWeather);
}
})();
