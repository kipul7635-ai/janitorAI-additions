(async function () {
  try {
    const res = await fetch(chrome.runtime.getURL("assets.json"));
    const data = await res.json();
    const images = data.images || [];
    if (!images.length) return;

    const pick = images[Math.floor(Math.random() * images.length)];
    const url = chrome.runtime.getURL(pick);

    const style = document.createElement("style");
    style.textContent = `
      /* Set the background on the body, the layout background, and the main container */
      body,
      ._chatLayoutBackground_tront_18,
      ._chatLayoutContainer_tront_8 {
        background-image: url("${url}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-attachment: fixed !important;
        background-repeat: no-repeat !important;
      }

      /* Make the inner wrapper elements transparent so your image isn't covered */
      [data-testid="virtuoso-scroller"],
      ._messagesWrapper_1swu7_1,
      ._messagesMain_1swu7_10 {
        background: transparent !important;
      }
    `;
    document.head.appendChild(style);
  } catch (e) {
    console.error("Theme error:", e);
  }
})();
