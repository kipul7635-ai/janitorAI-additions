(function() {
  // Check if the API exists in this context
  if (typeof chrome.runtime.getPackageDirectoryEntry !== 'function') {
    console.warn('[Reader] getPackageDirectoryEntry is not available in this context.');
    window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
    return;
  }

  // Kiwi Browser / Chromium expects a callback function here
  chrome.runtime.getPackageDirectoryEntry(function(root) {
    if (!root) {
      window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
      return;
    }

    root.getDirectory('audio', {}, function(dir) {
      const reader = dir.createReader();
      const names = [];

      const readBatch = function() {
        reader.readEntries(function(entries) {
          if (!entries.length) {
            // Finished reading all entries
            window.parent.postMessage({ type: 'AUDIO_FILES', files: names }, '*');
            return;
          }
          for (const e of entries) {
            if (e.isFile) names.push(e.name);
          }
          readBatch();
        }, function(err) {
          console.error('[Reader] readEntries failed:', err);
          window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
        });
      };

      readBatch();
    }, function(err) {
      console.error('[Reader] audio folder not found:', err);
      window.parent.postMessage({ type: 'AUDIO_FILES', files: [] }, '*');
    });
  });
})();
