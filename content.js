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
      body,
      ._chatLayoutBackground_tront_18 {
        background-image: url("${url}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-attachment: fixed !important;
        background-repeat: no-repeat !important;
      }
    `;
    document.head.appendChild(style);
  } catch (e) {
    console.error("Theme error:", e);
  }
})();
