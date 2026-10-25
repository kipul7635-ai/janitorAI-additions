(async function () {
  try {
    // 1. Fetch the assets list
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    const images = data.images || [];
    const audioFiles = data.audio || [];

    // 2. Setup the audio object ahead of time
    const audio = new Audio();
    audio.loop = true;
    audio.volume = 0.5;
    audio.style.display = "none"; // hide it
    document.body.appendChild(audio); // attach to DOM (mobile browsers require this)

    // 3. Create the full-screen overlay
    const overlay = document.createElement("div");
    overlay.id = "janitor-init-overlay";
    overlay.textContent = "[ initialize chat ]";
    document.body.appendChild(overlay);

    // 4. Wait for the user to click the overlay (Removed async here!)
    overlay.addEventListener("click", function () {
      
      // Fade out the black screen
      overlay.classList.add("fade-out");
      setTimeout(() => overlay.remove(), 500);

      // Apply background image
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

      // Play the music
      if (audioFiles.length > 0) {
        const audioPick = audioFiles[Math.floor(Math.random() * audioFiles.length)];
        audio.src = chrome.runtime.getURL(audioPick);
        
        // Play the audio synchronously inside the click
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }
    });

  } catch (e) {
    console.error("Theme error:", e);
  }
})();
