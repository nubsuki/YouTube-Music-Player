function injectAutoContinue(webContents, checkInterval = 500) {
  if (!webContents || webContents.isDestroyed()) return;

  const interval = Number(checkInterval) || 500;

  webContents
    .executeJavaScript(`
      (function() {
        if (window.__ytmpAutoContinueInitialized) return;
        window.__ytmpAutoContinueInitialized = true;

        const checkInterval = ${interval};
        let lastDismissTime = 0;
        let observerTimeout = null;

        function dismissDialog() {
          try {
            const now = Date.now();
            if (now - lastDismissTime < 2000) return false;

            const dialogSelectors = [
              'tp-yt-paper-dialog.style-scope',
              'ytmusic-you-there-renderer',
              'tp-yt-paper-dialog[role="dialog"]'
            ];

            let dialog = null;
            for (const selector of dialogSelectors) {
              const element = document.querySelector(selector);
              if (element && window.getComputedStyle(element).display !== 'none' && element.offsetParent !== null) {
                dialog = element;
                break;
              }
            }

            if (!dialog) return false;

            const dialogText = (dialog.textContent || '').toLowerCase();
            const isKeepListeningDialog = dialogText.includes('still listening') || 
                                           dialogText.includes('still there') || 
                                           dialogText.includes('you there') ||
                                           dialogText.includes('video paused') ||
                                           dialogText.includes('continue watching');

            if (!isKeepListeningDialog) return false;

            const buttonSelectors = [
              'yt-button-renderer.ytmusic-you-there-renderer',
              'tp-yt-paper-button#button',
              '[aria-label*="Yes" i]',
              '[aria-label*="Continue" i]',
              'button'
            ];

            for (const selector of buttonSelectors) {
              const confirmButton = dialog.querySelector(selector);
              if (confirmButton && confirmButton.offsetParent !== null && !confirmButton.disabled) {
                confirmButton.click();
                lastDismissTime = now;
                console.log('Auto-dismissed "Keep listening?" dialog');
                return true;
              }
            }
          } catch (e) {
            console.error('Error in dismissDialog:', e);
          }
          return false;
        }

        setInterval(dismissDialog, checkInterval);

        if (document.body) {
          const observer = new MutationObserver(() => {
            if (observerTimeout) return;
            observerTimeout = setTimeout(() => {
              observerTimeout = null;
              dismissDialog();
            }, 300);
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }

        console.log('Auto-continue listening feature initialized');
      })();
    `)
    .catch(() => {});
}

module.exports = { injectAutoContinue };

