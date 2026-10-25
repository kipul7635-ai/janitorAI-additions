(async function () {
  try {
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

    overlay.addEventListener("click", function () {
      overlay.classList.add("fade-out");
      setTimeout(() => overlay.remove(), 500);

      // For testing, play the first audio file
      if (audioFiles.length > 0) {
        audio.src = chrome.runtime.getURL(audioFiles[0]);
        audio.play().catch(e => console.error("Audio playback failed:", e));
      }

      // --- NEW: THE AI BRAIN ---
      const testChat = "The group steps into a dark, gloomy forest. Rain begins to fall. 'We should find shelter,' the rogue whispers.";
      
      // Prompt the user for their API key (we'll do this just for testing)
      let apiKey = localStorage.getItem("openrouter_key");
      if (!apiKey) {
        apiKey = prompt("Enter your OpenRouter API Key (starts with sk-or-v1-):");
        if (apiKey) localStorage.setItem("openrouter_key", apiKey);
      }

      if (apiKey) {
        askAI(testChat, images, audioFiles, apiKey);
      } else {
        console.log("No API key provided. Skipping AI.");
      }
    });

  } catch (e) {
    console.error("Theme error:", e);
  }
})();

// --- NEW FUNCTION TO CALL OPENROUTER ---
async function askAI(chatText, availableImages, availableAudio, apiKey) {
  console.log("🧠 Asking AI...");
  
  const systemPrompt = `You are an ambient engine. Based on the chat, choose a background and music. 
  Output ONLY a valid JSON object with the exact keys "background" and "music". Do not output any markdown or extra text.
  Available backgrounds: ${JSON.stringify(availableImages)}
  Available music: ${JSON.stringify(availableAudio)}`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3-8b-instruct:free", // Change this to your preferred model
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Recent chat:\n${chatText}` }
        ]
      })
    });

    const result = await response.json();
    
    if (result.error) {
      console.error("OpenRouter Error:", result.error);
      return;
    }

    const aiMessage = result.choices[0].message.content;
    console.log("🤖 AI responded with:", aiMessage);
    
    // Try to parse the JSON response
    try {
      const decision = JSON.parse(aiMessage);
      console.log("✅ Parsed decision:", decision);
      // We will hook this up to the background/music in the next step!
    } catch (e) {
      console.error("Failed to parse AI JSON:", e);
    }

  } catch (e) {
    console.error("Fetch to OpenRouter failed:", e);
  }
}
