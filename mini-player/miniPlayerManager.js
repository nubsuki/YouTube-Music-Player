const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");

let miniPlayerWindow = null;
let miniPlayerSettingsWindow = null;
let miniPlayerBounds = { x: undefined, y: undefined, width: 320, height: 105 };
let miniPlayerTheme = "blur";
let miniPlayerAlwaysOnTop = true;
let openMiniPlayerOnMinimize = false;

let miniPlayerStateInterval = null;
let miniPlayerStatePollingInFlight = false;
let saveMiniBoundsTimer = null;
let ipcRegistered = false;

let context = {
  getMainWindow: () => null,
  getPlayerWebContents: () => null,
  iconPath: "",
  saveConfig: () => {},
  createMenu: () => {},
  t: (key) => key,
  isQuitting: () => false,
};

function ensureWindowIsVisible(bounds, defaultBounds) {
  if (bounds.x === undefined || bounds.y === undefined) return defaultBounds;

  const width = bounds.width || defaultBounds.width;
  const height = bounds.height || defaultBounds.height;

  const displays = screen.getAllDisplays();
  const isVisible = displays.some((display) => {
    const { x, y, width: dWidth, height: dHeight } = display.bounds;
    const visibleX =
      Math.max(bounds.x, x) < Math.min(bounds.x + width, x + dWidth);
    const visibleY =
      Math.max(bounds.y, y) < Math.min(bounds.y + height, y + dHeight);

    if (visibleX && visibleY) {
      const intersectionWidth =
        Math.min(bounds.x + width, x + dWidth) - Math.max(bounds.x, x);
      const intersectionHeight =
        Math.min(bounds.y + height, y + dHeight) - Math.max(bounds.y, y);
      return (
        intersectionWidth >= Math.min(width, 50) &&
        intersectionHeight >= Math.min(height, 50)
      );
    }
    return false;
  });

  return isVisible ? { ...bounds, width, height } : defaultBounds;
}

const PLAYER_STATE_SCRIPT = `
  (() => {
    const playPauseBtn = document.querySelector("#play-pause-button");
    const likeRenderer = document.querySelector("ytmusic-like-button-renderer");
    const likeBtn =
      document.querySelector("#button-shape-like > button") ||
      document.querySelector("ytmusic-like-button-renderer #button-shape-like > button");
    const dislikeBtn =
      document.querySelector("#button-shape-dislike > button") ||
      document.querySelector("ytmusic-like-button-renderer #button-shape-dislike > button");
    const timeInfo = document.querySelector(".time-info");
    const title = document.querySelector(".middle-controls .title");
    const byline = document.querySelector(".middle-controls .byline");

    const thumbnailImg =
      document.querySelector("ytmusic-player-bar img#thumbnail") ||
      document.querySelector("ytmusic-player-bar img") ||
      document.querySelector("#player-bar img") ||
      document.querySelector("img#thumbnail") ||
      document.querySelector(".thumbnail img");

    const getImgSrc = (img) => {
      if (!img) return "";
      return img.currentSrc || img.src || img.getAttribute("src") || "";
    };

    const thumbnailSrc = getImgSrc(thumbnailImg);

    const progress = document.querySelector("#progress-bar");
    const buffering = document.querySelector("#buffering-spinner");
    
    const getIconLabel = (btn) => {
      if (!btn) return "";
      return (btn.getAttribute('aria-label') || btn.title || "").toLowerCase();
    };

    const label = getIconLabel(playPauseBtn);
    // "Pausar" (ES), "Pause" (EN), "Pausa" (IT/PT)
    const isPlaying = label.includes("paus");

    const isLiked = likeRenderer
      ? likeRenderer.getAttribute("like-status") === "LIKE"
      : likeBtn ? likeBtn.getAttribute("aria-pressed") === "true" : false;

    const isDisliked = likeRenderer
      ? likeRenderer.getAttribute("like-status") === "DISLIKE"
      : dislikeBtn ? dislikeBtn.getAttribute("aria-pressed") === "true" : false;

    return {
      isPlaying: isPlaying,
      isLiked: isLiked,
      isDisliked: isDisliked,
      timeInfo: timeInfo ? timeInfo.innerText.trim() : "",
      title: title ? title.innerText.trim() : "",
      artist: byline ? byline.innerText.trim() : "",
      thumbnail: thumbnailSrc,
      isBuffering: buffering ? !buffering.hidden : false,
      progress: progress ? progress.value : 0,
      progressMax: progress ? progress.max : 100
    };
  })()
`;

async function pollPlayerStateNow() {
  const mainWindow = context.getMainWindow();
  if (
    miniPlayerStatePollingInFlight ||
    !miniPlayerWindow ||
    miniPlayerWindow.isDestroyed() ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }

  miniPlayerStatePollingInFlight = true;
  try {
    const player =
      typeof context.getPlayerWebContents === "function"
        ? context.getPlayerWebContents()
        : null;
    if (!player || player.isDestroyed()) return;

    const state = await player.executeJavaScript(PLAYER_STATE_SCRIPT);

    if (
      miniPlayerWindow &&
      !miniPlayerWindow.isDestroyed() &&
      miniPlayerWindow.webContents &&
      !miniPlayerWindow.webContents.isDestroyed()
    ) {
      miniPlayerWindow.webContents.send("state-update", state);
    }
  } catch (e) {
    console.error("Error polling player state:", e);
  } finally {
    miniPlayerStatePollingInFlight = false;
  }
}

function triggerQuickPoll(delayMs = 250) {
  setTimeout(() => {
    pollPlayerStateNow().catch(() => {});
  }, delayMs);
}

function startMiniPlayerStatePolling() {
  if (miniPlayerStateInterval) clearInterval(miniPlayerStateInterval);
  miniPlayerStateInterval = setInterval(pollPlayerStateNow, 1000);
}

function stopMiniPlayerStatePolling() {
  if (miniPlayerStateInterval) {
    clearInterval(miniPlayerStateInterval);
    miniPlayerStateInterval = null;
  }
  miniPlayerStatePollingInFlight = false;
}

function createMiniPlayerWindow() {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.focus();
    return miniPlayerWindow;
  }

  const defaultMiniBounds = {
    x: undefined,
    y: undefined,
    width: 320,
    height: 105,
  };
  const bounds = ensureWindowIsVisible(miniPlayerBounds, defaultMiniBounds);
  const mainWindow = context.getMainWindow();

  miniPlayerWindow = new BrowserWindow({
    width: bounds.width || 320,
    height: bounds.height || 105,
    x: bounds.x,
    y: bounds.y,
    parent:
      mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
        ? mainWindow
        : null,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: miniPlayerAlwaysOnTop,
    show: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-mini-player.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: context.iconPath,
  });

  miniPlayerWindow.loadFile(path.join(__dirname, "mini-player.html"));

  miniPlayerWindow.once("ready-to-show", () => {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.show();
    }
  });

  // Enable F12 and Ctrl+Shift+i for DevTools
  miniPlayerWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
        miniPlayerWindow.webContents.openDevTools({ mode: "detach" });
      }
      event.preventDefault();
    }
  });

  const saveMiniPlayerPosition = () => {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      const b = miniPlayerWindow.getBounds();
      // Keep width and height out of the saved config to avoid growth on Windows DPI scaling
      miniPlayerBounds = { x: b.x, y: b.y };
      if (saveMiniBoundsTimer) clearTimeout(saveMiniBoundsTimer);
      saveMiniBoundsTimer = setTimeout(() => {
        if (typeof context.saveConfig === "function") {
          context.saveConfig();
        }
      }, 500);
    }
  };

  miniPlayerWindow.on("moved", saveMiniPlayerPosition);
  miniPlayerWindow.on("hide", saveMiniPlayerPosition);
  miniPlayerWindow.on("close", saveMiniPlayerPosition);
  miniPlayerWindow.on("closed", () => {
    stopMiniPlayerStatePolling();
    miniPlayerWindow = null;

    // Show main window when mini player is closed (unless app is quitting)
    const isQuitting =
      typeof context.isQuitting === "function" ? context.isQuitting() : false;
    const mainWin = context.getMainWindow();
    if (!isQuitting && mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
  });

  // Start polling state when mini player is opened
  startMiniPlayerStatePolling();
  return miniPlayerWindow;
}

function closeMiniPlayerWindow() {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.close();
  }
}

function createMiniPlayerSettingsWindow() {
  if (miniPlayerSettingsWindow && !miniPlayerSettingsWindow.isDestroyed()) {
    miniPlayerSettingsWindow.focus();
    return miniPlayerSettingsWindow;
  }

  const mainWindow = context.getMainWindow();
  const parentWindow =
    miniPlayerWindow && !miniPlayerWindow.isDestroyed()
      ? miniPlayerWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : undefined;

  miniPlayerSettingsWindow = new BrowserWindow({
    width: 250,
    height: 190,
    parent: parentWindow,
    modal: false,
    frame: false,
    resizable: false,
    show: false,
    title:
      typeof context.t === "function"
        ? context.t("mini_player_settings")
        : "Mini Player Settings",
    webPreferences: {
      preload: path.join(__dirname, "preload-mini-player.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: context.iconPath,
  });

  miniPlayerSettingsWindow.setMenu(null);
  miniPlayerSettingsWindow.loadFile(path.join(__dirname, "settings.html"));

  miniPlayerSettingsWindow.once("ready-to-show", () => {
    if (miniPlayerSettingsWindow && !miniPlayerSettingsWindow.isDestroyed()) {
      miniPlayerSettingsWindow.show();
    }
  });

  miniPlayerSettingsWindow.on("closed", () => {
    miniPlayerSettingsWindow = null;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.focus();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  });

  return miniPlayerSettingsWindow;
}

function closeMiniPlayerSettingsWindow() {
  if (miniPlayerSettingsWindow && !miniPlayerSettingsWindow.isDestroyed()) {
    miniPlayerSettingsWindow.close();
  }
}

function resetMiniPlayerPosition() {
  miniPlayerBounds = { x: undefined, y: undefined };
  if (typeof context.saveConfig === "function") {
    context.saveConfig();
  }
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.center();
  }
}

function toggleMiniPlayerOnMinimize(enabled) {
  openMiniPlayerOnMinimize = !!enabled;
  if (typeof context.saveConfig === "function") {
    context.saveConfig();
  }
  if (typeof context.createMenu === "function") {
    context.createMenu();
  }
  console.log(
    `Open mini player on minimize: ${openMiniPlayerOnMinimize ? "Enabled" : "Disabled"}`
  );
  return openMiniPlayerOnMinimize;
}

function registerMiniPlayerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on("mini-player-drag-start", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    win._dragOffset = { x: cursor.x - winX, y: cursor.y - winY };
  });

  ipcMain.on("mini-player-drag-move", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !win._dragOffset) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(cursor.x - win._dragOffset.x),
      Math.round(cursor.y - win._dragOffset.y)
    );
  });

  ipcMain.on("mini-player-drag-end", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win._dragOffset = null;
  });

  ipcMain.on("open-mini-player-settings", () => {
    createMiniPlayerSettingsWindow();
  });

  ipcMain.on("close-mini-player-settings", () => {
    closeMiniPlayerSettingsWindow();
  });

  ipcMain.handle("get-mini-player-theme", () => {
    return miniPlayerTheme;
  });

  ipcMain.on("set-mini-player-theme", (event, theme) => {
    miniPlayerTheme = theme;
    if (typeof context.saveConfig === "function") {
      context.saveConfig();
    }
    console.log(`Mini player theme updated to: ${theme}`);

    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.webContents.send("theme-changed", theme);
    }
  });

  ipcMain.handle("get-mini-player-always-on-top", () => {
    return miniPlayerAlwaysOnTop;
  });

  ipcMain.on("set-mini-player-always-on-top", (event, enabled) => {
    miniPlayerAlwaysOnTop = !!enabled;
    if (typeof context.saveConfig === "function") {
      context.saveConfig();
    }

    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.setAlwaysOnTop(miniPlayerAlwaysOnTop);
    }
  });
}

function initMiniPlayer(ctx = {}) {
  context = { ...context, ...ctx };
  registerMiniPlayerIpc();
}

function applyMiniPlayerConfig(config = {}) {
  if (typeof config.openMiniPlayerOnMinimize === "boolean") {
    openMiniPlayerOnMinimize = config.openMiniPlayerOnMinimize;
  }
  if (config.miniPlayerBounds) {
    miniPlayerBounds = config.miniPlayerBounds;
  }
  if (config.miniPlayerTheme) {
    miniPlayerTheme = config.miniPlayerTheme;
  }
  if (config.miniPlayerAlwaysOnTop !== undefined) {
    miniPlayerAlwaysOnTop = !!config.miniPlayerAlwaysOnTop;
  }
}

function getMiniPlayerConfig() {
  return {
    openMiniPlayerOnMinimize,
    miniPlayerBounds,
    miniPlayerTheme,
    miniPlayerAlwaysOnTop,
  };
}

function getMiniPlayerWindow() {
  return miniPlayerWindow;
}

function isMiniPlayerOpen() {
  return !!(miniPlayerWindow && !miniPlayerWindow.isDestroyed());
}

function getOpenMiniPlayerOnMinimize() {
  return openMiniPlayerOnMinimize;
}

function setOpenMiniPlayerOnMinimize(val) {
  openMiniPlayerOnMinimize = !!val;
}

function getMiniPlayerBounds() {
  return miniPlayerBounds;
}

function setMiniPlayerBounds(b) {
  miniPlayerBounds = b;
}

function getMiniPlayerTheme() {
  return miniPlayerTheme;
}

function setMiniPlayerTheme(theme) {
  miniPlayerTheme = theme;
}

function getMiniPlayerAlwaysOnTop() {
  return miniPlayerAlwaysOnTop;
}

function setMiniPlayerAlwaysOnTop(val) {
  miniPlayerAlwaysOnTop = !!val;
}

module.exports = {
  initMiniPlayer,
  ensureWindowIsVisible,
  createMiniPlayerWindow,
  closeMiniPlayerWindow,
  createMiniPlayerSettingsWindow,
  closeMiniPlayerSettingsWindow,
  startMiniPlayerStatePolling,
  stopMiniPlayerStatePolling,
  pollPlayerStateNow,
  triggerQuickPoll,
  resetMiniPlayerPosition,
  toggleMiniPlayerOnMinimize,
  registerMiniPlayerIpc,
  applyMiniPlayerConfig,
  getMiniPlayerConfig,
  getMiniPlayerWindow,
  isMiniPlayerOpen,
  getOpenMiniPlayerOnMinimize,
  setOpenMiniPlayerOnMinimize,
  getMiniPlayerBounds,
  setMiniPlayerBounds,
  getMiniPlayerTheme,
  setMiniPlayerTheme,
  getMiniPlayerAlwaysOnTop,
  setMiniPlayerAlwaysOnTop,
};

