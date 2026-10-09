// Clicking the toolbar icon opens the scanner in its own window (or focuses the open one).
let scannerWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (scannerWindowId !== null) {
    try {
      await chrome.windows.update(scannerWindowId, { focused: true });
      return;
    } catch {
      scannerWindowId = null;
    }
  }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL('index.html'), type: 'popup', width: 1100, height: 900 });
  scannerWindowId = w.id ?? null;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === scannerWindowId) scannerWindowId = null;
});
