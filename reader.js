(async function() {
  try {
    if (typeof chrome.runtime.getPackageDirectoryEntry !== 'function') {
      window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
      return;
    }

    // Kiwi Browser (Chromium 122+) expects the Promise-based API in MV3.
    const root = await chrome.runtime.getPackageDirectoryEntry();
    
    // The inner FileSystem API methods still use callbacks.
    root.getDirectory('audio', {}, (dir) => {
      const reader = dir.createReader();
      const names = [];
      
      const readBatch = () => {
        reader.readEntries((entries) => {
          if (!entries.length) {
            window.parent.postMessage({ type: 'AUDIO_FILES', files: names }, '*');
            return;
          }
          for (const e of entries) {
            if (e.isFile) names.push(e.name);
          }
          readBatch();
        }, (err) => {
          console.error('[Reader] readEntries failed:', err);
          window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
        });
      };
      
      readBatch();
    }, (err) => {
      console.error('[Reader] audio folder not found:', err);
      window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
    });
    
  } catch (err) {
    console.error('[Reader] getPackageDirectoryEntry failed:', err);
    window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
  }
})();
