(async function () {
  try {
    // 1. Fetch the assets list
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    const images = data.images || [];
    const audioFiles = data.audio || [];

    // 2. Create the full-screen overlay
    const overlay = document.createElement("div");
    overlay.id = "janitor-init-overlay";
    overlay.textContent = "[ initialize chat ]";
    document.body.appendChild(overlay);

    // 3. Wait for the user to click the overlay
    overlay.addEventListener("click", async () => {
      
      // Fade out the black screen
      overlay.classList.add("fade-out");
      setTimeout(() => overlay.remove(), 500); // Remove from DOM after fade

      // 4. Pick a random image and apply it
      if (images.length > 0) {
        const pick = images[Math.floor(Math.random() * images.length)];
        const url = chrome.runtime.getURL(pick);

        const style = document.createElement("style");
        style.textContent = `
          html, body {
            background-image: url("${url}") !important;
            background-size: cover !important;
            background-position: center !important;
            background-attachment: fixed !important;
            background-repeat: no-repeat !important;
            background-color: transparent !important;
          }
          #root, #__next, main, [class*="layout"], [class*="Layout"], 
          [class*="background"], [class*="Background"], [class*="container"], 
          [class*="Container"], [class*="wrapper"], [class*="Wrapper"],
          [data-testid="virtuoso-scroller"], [data-testid="virtuoso-item-list"] {
            background: transparent !important;
          }
        `;
        document.head.appendChild(style);
      }

      // 5. Start the music
      if (audioFiles.length > 0) {
        const audioPick = audioFiles[Math.floor(Math.random() * audioFiles.length)];
        const audioUrl = chrome.runtime.getURL(audioPick);
        
        const audio = new Audio(audioUrl);
        audio.loop = true;
        audio.volume = 0.5; // Set volume to 50% so it's not too loud
        
        // Play the audio (this works now because it's triggered by a click event)
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }
    });

  } catch (e) {
    console.error("Theme error:", e);
  }
})();
