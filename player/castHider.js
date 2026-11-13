const CAST_HIDE_CSS = `
  .ytmusic-player-bar .middle-controls [aria-label*="cast" i],
  .ytmusic-player-bar .middle-controls [aria-label*="connect" i],
  ytmusic-menu-service-item-renderer[aria-label*="connect" i],
  ytmusic-menu-service-item-renderer[aria-label*="cast" i],
  tp-yt-google-cast,
  .ytp-button[aria-label*="cast" i],
  .ytp-button[data-tooltip-target-id*="cast"],
  [data-title*="Cast"],
  [data-title*="Connect"],
  button[aria-label*="Connect to a device"],
  button[aria-label*="Cast"],
  ytmusic-cast-button,
  google-cast-launcher,
  ytmusic-nav-bar ytmusic-cast-button,
  ytmusic-nav-bar [aria-label*="cast" i],
  ytmusic-nav-bar [aria-label*="connect" i],
  ytmusic-nav-bar [role="button"][aria-label*="cast" i],
  ytmusic-nav-bar [role="button"][aria-label*="connect" i],
  .ytmusic-menu-service-item-renderer:has([aria-label*="cast" i]),
  .ytmusic-menu-service-item-renderer:has([aria-label*="connect" i])
  {
    display: none !important;
    visibility: hidden !important;
  }
`;

function hideCastButtons(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.insertCSS(CAST_HIDE_CSS);
    console.log("Cast buttons hidden");
  } catch (err) {
    console.error("Error hiding cast buttons:", err);
  }
}

module.exports = { hideCastButtons };

