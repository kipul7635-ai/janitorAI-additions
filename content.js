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
      /* 1. Put the image on the absolute background */
      html, body {
        background-image: url("${url}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-attachment: fixed !important;
        background-repeat: no-repeat !important;
        background-color: transparent !important;
      }

      /* 2. Strip the backgrounds from all the main structural wrappers */
      #root, 
      #__next, 
      main, 
      [class*="layout"], 
      [class*="Layout"], 
      [class*="background"], 
      [class*="Background"],
      [class*="container"],
      [class*="Container"],
      [class*="wrapper"],
      [class*="Wrapper"],
      [data-testid="virtuoso-scroller"],
      [data-testid="virtuoso-item-list"] {
        background: transparent !important;
      }
    `;
    document.head.appendChild(style);
  } catch (e) {
    console.error("Theme error:", e);
  }
})();
