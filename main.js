require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  Tray,
  shell,
  dialog,
  screen,
  clipboard,
  ipcMain,
} = require("electron");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs").promises;
const {
  initializeFilterEngine: initFiltersExternal,
  setupWebRequestHandler: setupWRExternal,
  getUserFilters: getFiltersExternal,
  saveUserFilters: saveFiltersExternal,
  resetFilters: resetFiltersExternal,
  getAdblockStats: getAdblockStatsExternal,
  resetAdblockStats: resetAdblockStatsExternal,
} = require("./adblock/filters");
const { injectVideoAdSkipper } = require("./adblock/videoAdSkipper");
const { initDiscordRpc } = require("./integrations/discordRpc");
const {
  initListenAlong,
  createParty,
  closeParty,
  joinParty,
  leaveParty,
  getListenAlongState,
  DEFAULT_SERVER_URL,
} = require("./listen-along/listenAlong");

let mainWindow;
let ytView = null;
let optionsView = null;
let isOptionsOpen = false;
const TOPBAR_HEIGHT = 38;
let tray;
let minimizeToTray = false;
let openMiniPlayerOnMinimize = false;
let openLastSong = false;
let resumePlayback = false;
let lastUrl = "https://music.youtube.com";
let miniPlayerWindow;
let miniPlayerBounds = { x: undefined, y: undefined, width: 320, height: 105 };
let mainWindowBounds = { x: undefined, y: undefined, width: 1200, height: 800 };
let miniPlayerTheme = "blur";
let miniPlayerAlwaysOnTop = true;

// Listen Along
let listenAlongServerUrl = DEFAULT_SERVER_URL;
let listenAlongHostName = "";
let listenAlongAutoHost = false;

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

// Video ad skipping settings
let videoAdSkipperEnabled = false;
let VideoAdSkipSpeed = 2;
let VideoAdSkipInterval = 200;

let adblockActive = false;

// Auto continue still listening settings
let autoContinueListeningInterval = 500;

// Support for multiple languages
const i18n = {};

const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

const { version: APP_VERSION } = require("./package.json");

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

// Icon
const iconPath =
  process.platform === "win32"
    ? path.join(__dirname, "assets", "icon.ico")
    : path.join(__dirname, "assets", "icon.png");

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function loadConfig() {
  try {
    const configData = await fs.readFile(CONFIG_FILE, "utf8");
    const config = JSON.parse(configData);

    minimizeToTray = config.minimizeToTray || false;
    openMiniPlayerOnMinimize = config.openMiniPlayerOnMinimize || false;
    videoAdSkipperEnabled = !!config.videoAdSkipperEnabled;
    VideoAdSkipSpeed = config.VideoAdSkipSpeed || 2;
    openLastSong =
      config.openLastSong !== undefined ? config.openLastSong : true;
    lastUrl = openLastSong
      ? config.lastUrl || "https://music.youtube.com"
      : "https://music.youtube.com";
    resumePlayback = config.resumePlayback || false;
    miniPlayerBounds = config.miniPlayerBounds || {
      x: undefined,
      y: undefined,
    };
    mainWindowBounds = config.mainWindowBounds || {
      x: undefined,
      y: undefined,
      width: 1200,
      height: 800,
    };
    miniPlayerTheme = config.miniPlayerTheme || "blur";
    miniPlayerAlwaysOnTop =
      config.miniPlayerAlwaysOnTop !== undefined
        ? !!config.miniPlayerAlwaysOnTop
        : true;

    // Listen Along config
    listenAlongServerUrl = config.listenAlongServerUrl || DEFAULT_SERVER_URL;
    listenAlongHostName = config.listenAlongHostName || "";
    listenAlongAutoHost = !!config.listenAlongAutoHost;

    console.log(
      `Config loaded - Minimize to tray: ${minimizeToTray}, Video ad skipper: ${videoAdSkipperEnabled}, Video ad skip speed: ${VideoAdSkipSpeed}, Last URL: ${lastUrl}, Open last song: ${openLastSong}, Resume playback: ${resumePlayback}, Mini-player bounds: ${JSON.stringify(miniPlayerBounds)}, Main window bounds: ${JSON.stringify(mainWindowBounds)}, Mini-player theme: ${miniPlayerTheme}`,
    );
    return config;
  } catch (error) {
    console.log("Using default config settings");
    return {};
  }
}

async function saveConfig() {
  try {
    const config = {
      minimizeToTray: minimizeToTray,
      openMiniPlayerOnMinimize: openMiniPlayerOnMinimize,
      videoAdSkipperEnabled: videoAdSkipperEnabled,
      VideoAdSkipSpeed: VideoAdSkipSpeed,
      lastUrl: lastUrl,
      openLastSong: openLastSong,
      resumePlayback: resumePlayback,
      miniPlayerBounds: miniPlayerBounds,
      mainWindowBounds: mainWindowBounds,
      miniPlayerTheme: miniPlayerTheme,
      miniPlayerAlwaysOnTop: miniPlayerAlwaysOnTop,
      listenAlongServerUrl: listenAlongServerUrl,
      listenAlongHostName: listenAlongHostName,
      listenAlongAutoHost: listenAlongAutoHost,
    };

    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    console.log("Config saved");
  } catch (error) {
    console.log("Error saving config:", error.message);
  }
}

// Load a specific language file

// Listen Along IPC handlers
ipcMain.handle("la:create-party", async (_e, { hostName }) => {
  const name = (hostName || listenAlongHostName || "").trim();
  if (name.length < 3) {
    throw new Error("Display name must be at least 3 characters.");
  }
  const partyId = await createParty(
    DEFAULT_SERVER_URL,
    name,
  );
  return { partyId };
});

ipcMain.handle("la:join-party", async (_e, { partyId, guestName }) => {
  const name = (guestName || listenAlongHostName || "").trim();
  if (name.length < 3) {
    throw new Error("Display name must be at least 3 characters.");
  }
  return await joinParty(
    DEFAULT_SERVER_URL,
    partyId,
    name,
  );
});

ipcMain.handle("la:close-party", async () => {
  await closeParty();
});

ipcMain.handle("la:leave-party", async () => {
  await leaveParty();
});

ipcMain.handle("la:get-state", () => getListenAlongState());

ipcMain.handle("la:get-config", () => ({
  serverUrl: DEFAULT_SERVER_URL,
  hostName: listenAlongHostName,
  autoHost: listenAlongAutoHost,
}));

ipcMain.on("la:save-config", (_e, { hostName, autoHost }) => {
  let nameChanged = false;
  if (hostName !== undefined) {
    const name = (hostName || "").trim();
    if (listenAlongHostName !== name) {
      listenAlongHostName = name;
      nameChanged = true;
    }
  }
  if (autoHost !== undefined) {
    listenAlongAutoHost = !!autoHost && (listenAlongHostName.length >= 3);
  }
  
  require("./listen-along/listenAlong").setAutoHost(listenAlongAutoHost, listenAlongHostName);
  saveConfig();
});

ipcMain.on("la:open-party-page", (_e, { partyId }) => {
  const url = DEFAULT_SERVER_URL.replace(/\/$/, "");
  shell.openExternal(`${url}/party/${partyId}`).catch(console.error);
});

ipcMain.on("la:copy-text", (_e, text) => {
  clipboard.writeText(String(text));
});

ipcMain.handle("la:read-clipboard", () => {
  try {
    const text = clipboard.readText();
    return typeof text === "string" ? text.trim() : "";
  } catch (e) {
    return "";
  }
});

// Push state change events to options view
function pushListenAlongState(state) {
  if (optionsView && !optionsView.webContents.isDestroyed()) {
    optionsView.webContents.send("la:state-changed", state);
  }
}

async function loadLanguage(lang) {
  // Try to load the language file from the 'locales' directory
  const langPath = path.join(__dirname, "locales", `${lang}.json`);
  try {
    const data = await fs.readFile(langPath, "utf8");
    // Parse the JSON data and merge it with the existing i18n object
    Object.assign(i18n, JSON.parse(data));
    console.log(`Language loaded: ${lang}`);
  } catch (error) {
    console.error(`Error loading language file for ${lang}:`, error.message);
    // Fallback to English if the requested language is not available
    if (lang !== "en") {
      console.log("Falling back to English...");
      await loadLanguage("en");
    }
  }
}

// Get the translated string for a given key
function t(key, ...args) {
  const text = i18n[key] || key;
  return text.replace(/{(\d+)}/g, (match, number) => {
    return typeof args[number] !== "undefined" ? args[number] : match;
  });
}

// Options view and topbar management
function updateViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getContentBounds();
  const contentHeight = Math.max(0, bounds.height - TOPBAR_HEIGHT);
  if (ytView && !ytView.webContents.isDestroyed()) {
    ytView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width: bounds.width, height: contentHeight });
  }
  if (optionsView && !optionsView.webContents.isDestroyed()) {
    optionsView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width: bounds.width, height: contentHeight });
  }
}

function handleCommonShortcuts(event, input) {
  if (
    input.key === "F12" ||
    (input.control && input.shift && input.key.toLowerCase() === "i")
  ) {
    const target = isOptionsOpen && optionsView ? optionsView.webContents : (ytView?.webContents || mainWindow?.webContents);
    if (target && !target.isDestroyed()) target.toggleDevTools();
    event.preventDefault();
  } else if (
    input.key === "F5" ||
    (input.control && input.key.toLowerCase() === "r")
  ) {
    if (isOptionsOpen) hideOptionsView();
    if (ytView && !ytView.webContents.isDestroyed()) {
      ytView.webContents.reload();
    }
    event.preventDefault();
  } else if (input.control && input.key === ",") {
    toggleOptionsView();
    event.preventDefault();
  } else if (input.key === "Escape" && isOptionsOpen) {
    hideOptionsView();
    event.preventDefault();
  }
}

function showOptionsView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  isOptionsOpen = true;

  if (!optionsView) {
    optionsView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, "options/options-preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    optionsView.webContents.loadFile(path.join(__dirname, "options/options.html"));
    optionsView.webContents.on("before-input-event", handleCommonShortcuts);
  }

  const views = mainWindow.getBrowserViews();
  if (!views.includes(optionsView)) {
    mainWindow.addBrowserView(optionsView);
  }
  mainWindow.setTopBrowserView(optionsView);

  const bounds = mainWindow.getContentBounds();
  const contentHeight = Math.max(0, bounds.height - TOPBAR_HEIGHT);
  optionsView.setBounds({ x: 0, y: TOPBAR_HEIGHT, width: bounds.width, height: contentHeight });
  optionsView.setAutoResize({ width: true, height: true });
  optionsView.webContents.focus();

  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("options:view-state", true);
  }
}

function hideOptionsView() {
  isOptionsOpen = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (optionsView) {
      mainWindow.removeBrowserView(optionsView);
    }
    if (ytView) {
      mainWindow.setTopBrowserView(ytView);
      ytView.webContents.focus();
    }
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("options:view-state", false);
    }
  }
}

function toggleOptionsView() {
  if (isOptionsOpen) {
    hideOptionsView();
  } else {
    showOptionsView();
  }
}

ipcMain.on("topbar:toggle-options", () => {
  toggleOptionsView();
});

ipcMain.on("topbar:refresh", () => {
  if (isOptionsOpen) hideOptionsView();
  if (ytView && !ytView.webContents.isDestroyed()) {
    ytView.webContents.reload();
  }
});

function createMiniPlayerWindow() {
  if (miniPlayerWindow) {
    miniPlayerWindow.focus();
    return;
  }

  const defaultMiniBounds = {
    x: undefined,
    y: undefined,
    width: 320,
    height: 105,
  };
  const bounds = ensureWindowIsVisible(miniPlayerBounds, defaultMiniBounds);

  miniPlayerWindow = new BrowserWindow({
    width: bounds.width || 320,
    height: bounds.height || 105,
    x: bounds.x,
    y: bounds.y,
    parent: mainWindow.isVisible() ? mainWindow : null,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: miniPlayerAlwaysOnTop,
    show: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "mini-player/preload-mini-player.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: iconPath,
  });

  miniPlayerWindow.loadFile(
    path.join(__dirname, "mini-player/mini-player.html"),
  );

  miniPlayerWindow.once("ready-to-show", () => {
    miniPlayerWindow.show();
  });

  // Enable F12 and Ctrl+Shift+i for DevTools
  miniPlayerWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      miniPlayerWindow.webContents.openDevTools({ mode: "detach" });
      event.preventDefault();
    }
  });

  const saveMiniPlayerPosition = () => {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      const bounds = miniPlayerWindow.getBounds();
      // Keep width and height out of the saved config to avoid growth on Windows DPI scaling
      miniPlayerBounds = { x: bounds.x, y: bounds.y };
      saveConfig();
    }
  };

  miniPlayerWindow.on("moved", saveMiniPlayerPosition);
  miniPlayerWindow.on("hide", saveMiniPlayerPosition);
  miniPlayerWindow.on("close", saveMiniPlayerPosition);
  miniPlayerWindow.on("closed", () => {
    if (miniPlayerStateInterval) {
      clearInterval(miniPlayerStateInterval);
      miniPlayerStateInterval = null;
    }
    miniPlayerWindow = null;

    // Show main window when mini player is closed (unless app is quitting)
    if (!app.isQuiting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Start polling state when mini player is opened
  startMiniPlayerStatePolling();
}

function getPlayerWebContents() {
  if (ytView && !ytView.webContents.isDestroyed()) return ytView.webContents;
  if (mainWindow && !mainWindow.webContents.isDestroyed()) return mainWindow.webContents;
  return null;
}

let miniPlayerStateInterval;
function startMiniPlayerStatePolling() {
  if (miniPlayerStateInterval) clearInterval(miniPlayerStateInterval);

  miniPlayerStateInterval = setInterval(async () => {
    if (
      !miniPlayerWindow ||
      miniPlayerWindow.isDestroyed() ||
      !mainWindow ||
      mainWindow.isDestroyed()
    )
      return;

    try {
      const player = getPlayerWebContents();
      if (!player) return;
      const state = await player.executeJavaScript(`
        (() => {
          const playPauseBtn = document.querySelector("#play-pause-button");
          const likeBtn = document.querySelector("#button-shape-like > button");
          const dislikeBtn = document.querySelector("#button-shape-dislike > button");
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

          return {
            isPlaying: isPlaying,
            isLiked: likeBtn ? likeBtn.getAttribute('aria-pressed') === 'true' : false,
            isDisliked: dislikeBtn ? dislikeBtn.getAttribute('aria-pressed') === 'true' : false,
            timeInfo: timeInfo ? timeInfo.innerText.trim() : "",
            title: title ? title.innerText.trim() : "",
            artist: byline ? byline.innerText.trim() : "",
            thumbnail: thumbnailSrc,
            isBuffering: buffering ? !buffering.hidden : false,
            progress: progress ? progress.value : 0,
            progressMax: progress ? progress.max : 100
          };
        })()
      `);

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
    }
  }, 1000);
}

ipcMain.handle("get-filters", async () => {
  return await getFiltersExternal();
});

ipcMain.handle("get-translations", (event, keys) => {
  const translations = {};
  keys.forEach((key) => {
    translations[key] = t(key);
  });
  return translations;
});

ipcMain.handle("get-adblock-stats", async () => {
  if (typeof getAdblockStatsExternal !== "function") {
    return {
      active: adblockActive,
      engineReady: false,
      enabledLists: 0,
      checked: 0,
      blocked: 0,
      lastBlockedAt: 0,
    };
  }

  const stats = await getAdblockStatsExternal();
  return { active: adblockActive, ...stats };
});

ipcMain.on("reset-adblock-stats", () => {
  if (typeof resetAdblockStatsExternal === "function") {
    resetAdblockStatsExternal();
  }
});

ipcMain.on("save-filters", async (event, newFilters) => {
  await saveFiltersExternal(newFilters);
  const success = await initFiltersExternal(true);
  adblockActive = !!success;
  if (success) setupWRExternal();
});

ipcMain.on("reset-filters", async (event) => {
  try {
    await resetFiltersExternal();
    console.log("User filters reset to default successfully.");
    const success = await initFiltersExternal(true);
    adblockActive = !!success;
    if (success) setupWRExternal();
  } catch (error) {
    console.log("Error resetting user filters:", error.message);
  }
});

ipcMain.handle("get-about-info", () => {
  return {
    appName: t("app_name"),
    appVersion: APP_VERSION,
    appDescription: t("about_app_description"),
    githubUrl: "https://github.com/nubsuki/YouTube-Music-Player",
    translations: {
      accept: t("accept"),
      version: t("version_label", APP_VERSION),
      github_link: t("github_link_text"),
    },
  };
});

// Handle video ad skipper settings
ipcMain.handle("get-ad-skipper-settings", () => {
  return {
    enabled: videoAdSkipperEnabled,
    speed: VideoAdSkipSpeed,
  };
});

ipcMain.on("save-ad-skipper-settings", async (event, settings) => {
  videoAdSkipperEnabled = settings.enabled;
  VideoAdSkipSpeed = settings.speed;
  await saveConfig();
  console.log(
    `Video ad skipper settings updated: Enabled=${videoAdSkipperEnabled}, Speed=${VideoAdSkipSpeed}x`,
  );
});

ipcMain.on("open-external-link", (event, url) => {
  shell
    .openExternal(url)
    .catch((error) => console.error("Error opening external link:", error));
});

// Options window IPC
ipcMain.handle("options:get-app-settings", () => {
  const loginItemSettings = app.getLoginItemSettings();
  return {
    startWithSystem: loginItemSettings.openAtLogin,
    openLastSong,
    resumePlayback,
    minimizeToTray,
    openMiniPlayerOnMinimize,
  };
});

ipcMain.on("options:save-app-settings", (event, s) => {
  if (typeof s.startWithSystem === "boolean") {
    app.setLoginItemSettings({ openAtLogin: s.startWithSystem, path: app.getPath("exe") });
  }
  if (typeof s.openLastSong === "boolean") toggleReOpenBehavior(s.openLastSong);
  if (typeof s.resumePlayback === "boolean") toggleResumeBehavior(s.resumePlayback);
  if (typeof s.minimizeToTray === "boolean") toggleTrayBehavior(s.minimizeToTray);
  if (typeof s.openMiniPlayerOnMinimize === "boolean") toggleMiniPlayerOnMinimize(s.openMiniPlayerOnMinimize);
});

ipcMain.handle("options:check-for-updates", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo && result.updateInfo.version !== APP_VERSION) {
      return { message: `Update available: v${result.updateInfo.version}` };
    }
    return { message: "You are on the latest version." };
  } catch (e) {
    return { message: "Error checking for updates: " + e.message };
  }
});

ipcMain.on("options:close", () => {
  hideOptionsView();
});

let miniPlayerSettingsWindow;
function createMiniPlayerSettingsWindow() {
  if (miniPlayerSettingsWindow) {
    miniPlayerSettingsWindow.focus();
    return;
  }

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
    title: t("mini_player_settings"),
    webPreferences: {
      preload: path.join(__dirname, "mini-player/preload-mini-player.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: iconPath,
  });

  miniPlayerSettingsWindow.setMenu(null);
  miniPlayerSettingsWindow.loadFile(
    path.join(__dirname, "mini-player/settings.html"),
  );

  miniPlayerSettingsWindow.once("ready-to-show", () => {
    miniPlayerSettingsWindow.show();
  });

  miniPlayerSettingsWindow.on("closed", () => {
    miniPlayerSettingsWindow = null;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.focus();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  });
}

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
    Math.round(cursor.y - win._dragOffset.y),
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
  if (miniPlayerSettingsWindow && !miniPlayerSettingsWindow.isDestroyed()) {
    miniPlayerSettingsWindow.close();
  }
});

ipcMain.handle("get-mini-player-theme", () => {
  return miniPlayerTheme;
});

ipcMain.on("set-mini-player-theme", (event, theme) => {
  miniPlayerTheme = theme;
  saveConfig();
  console.log(`Mini player theme updated to: ${theme}`);

  // Notify all windows of theme change
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send("theme-changed", theme);
  }
});

ipcMain.handle("get-mini-player-always-on-top", () => {
  return miniPlayerAlwaysOnTop;
});

ipcMain.on("set-mini-player-always-on-top", (event, enabled) => {
  miniPlayerAlwaysOnTop = !!enabled;
  saveConfig();

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.setAlwaysOnTop(miniPlayerAlwaysOnTop);
  }
});

ipcMain.on("player-control", (event, data) => {
  if (!mainWindow) return;

  let action = typeof data === "string" ? data : data.action;
  let script = "";

  switch (action) {
    case "play-pause":
      script =
        '{ const btn = document.querySelector("#play-pause-button"); if (btn) btn.click(); }';
      break;
    case "previous":
      script =
        '{ const btn = document.querySelector(".previous-button"); if (btn) btn.click(); }';
      break;
    case "next":
      script =
        '{ const btn = document.querySelector(".next-button"); if (btn) btn.click(); }';
      break;
    case "like":
      script =
        '{ const btn = document.querySelector("#button-shape-like > button"); if (btn) btn.click(); }';
      break;
    case "dislike":
      script =
        '{ const btn = document.querySelector("#button-shape-dislike > button"); if (btn) btn.click(); }';
      break;
    case "seek":
      if (typeof data.value !== "undefined") {
        const rawValue = data.value;
        script = `
          {
            const progressBar = document.querySelector("#progress-bar");
            const rawValue = ${JSON.stringify(rawValue)};
            const value = Number(rawValue);
            if (progressBar && Number.isFinite(value)) {
              progressBar.value = value;
              progressBar.dispatchEvent(new Event('input', { bubbles: true }));
              progressBar.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        `;
      }
      break;
    case "maximize":
      if (miniPlayerWindow) {
        miniPlayerWindow.close();
      }
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
      break;
  }

  const player = getPlayerWebContents();
  if (script && player) {
    player.executeJavaScript(script).catch((e) => {
      console.error("Error executing player control script:", e);
    });
  }
});

function createTray() {
  if (tray) return;

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t("show"),
      click: () => {
        if (miniPlayerWindow) {
          miniPlayerWindow.close();
        }
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: t("reset_position"),
      click: () => {
        mainWindowBounds = {
          x: undefined,
          y: undefined,
          width: 1200,
          height: 800,
        };
        miniPlayerBounds = { x: undefined, y: undefined };
        saveConfig();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setSize(1200, 800);
          mainWindow.center();
        }

        if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
          miniPlayerWindow.center();
        }
      },
    },
    {
      label: t("quit"),
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(t("app_name"));

  // Double-click to show/hide
  tray.on("double-click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      // Show the mini player if the option is enabled
      if (openMiniPlayerOnMinimize) {
        createMiniPlayerWindow();
      }
    } else {
      // Close the mini player when showing the main window
      if (miniPlayerWindow) {
        miniPlayerWindow.close();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  console.log("System tray created");
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
    console.log("System tray removed");
  }
}

function toggleTrayBehavior(enabled) {
  minimizeToTray = enabled;

  if (enabled) {
    createTray();
  } else {
    destroyTray();
  }

  saveConfig();
  createMenu();
  console.log(`Minimize to tray: ${enabled ? "Enabled" : "Disabled"}`);
}

function toggleReOpenBehavior(enabled) {
  openLastSong = enabled;
  saveConfig();
  createMenu();
  console.log(`Open last song: ${enabled ? "Enabled" : "Disabled"}`);
}

function toggleResumeBehavior(enabled) {
  resumePlayback = enabled;
  saveConfig();
  createMenu();
  console.log(`Resume playback: ${enabled ? "Enabled" : "Disabled"}`);
}
function toggleMiniPlayerOnMinimize(enabled) {
  openMiniPlayerOnMinimize = enabled;
  saveConfig();
  createMenu();
  console.log(
    `Open mini player on minimize: ${enabled ? "Enabled" : "Disabled"}`,
  );
}

// Load all filters in parallel

function handleStartupSettings() {
  const args = process.argv.slice(1);

  if (args.includes("--enable-startup")) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath("exe"),
    });
    console.log("Startup enabled");
  }

  if (args.includes("--disable-startup")) {
    app.setLoginItemSettings({
      openAtLogin: false,
    });
    console.log("Startup disabled");
  }

  const loginItemSettings = app.getLoginItemSettings();
  console.log(
    `Startup status: ${loginItemSettings.openAtLogin ? "Enabled" : "Disabled"}`,
  );
}

function createMenu() {
  Menu.setApplicationMenu(null);
}

async function createWindow() {
  await loadConfig();

  // Get system locale and load language
  const userLocale = app.getLocale().split("-")[0];
  await loadLanguage(userLocale);

  if (minimizeToTray) {
    createTray();
  }

  const windowBounds = ensureWindowIsVisible(mainWindowBounds, {
    x: undefined,
    y: undefined,
    width: 1200,
    height: 800,
  });

  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1200,
    height: windowBounds.height || 800,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    title: "YouTube Music",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#07070a",
      symbolColor: "#a1a1aa",
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, "topbar/topbar-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, "topbar/topbar.html"));

  ytView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.addBrowserView(ytView);
  ytView.setAutoResize({ width: true, height: true });
  updateViewBounds();

  const saveMainWindowBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      mainWindowBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      saveConfig();
    }
  };

  mainWindow.on("moved", saveMainWindowBounds);
  mainWindow.on("resized", () => {
    saveMainWindowBounds();
    updateViewBounds();
  });
  mainWindow.on("maximize", () => updateViewBounds());
  mainWindow.on("unmaximize", () => updateViewBounds());

  mainWindow.webContents.on("before-input-event", handleCommonShortcuts);
  ytView.webContents.on("before-input-event", handleCommonShortcuts);

  ytView.webContents.on("page-title-updated", (_e, title) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title || "YouTube Music");
    }
  });
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
  });

  // Load filters in background
  initFiltersExternal().then((success) => {
    adblockActive = !!success;
    console.log(success ? "Ad blocking active" : "Ad blocking failed");
    if (success) {
      setupWRExternal();
    }
  });

  // Handle close button based on tray setting
  mainWindow.on("close", async (event) => {
    if (!app.isQuiting && minimizeToTray) {
      // Hide to tray, keep music playing
      event.preventDefault();
      mainWindow.hide();
      console.log("App minimized to tray");

      if (openMiniPlayerOnMinimize) {
        createMiniPlayerWindow();
      }

      if (tray && !mainWindow.trayNotificationShown) {
        tray.displayBalloon({
          iconType: "info",
          title: "YouTube Music",
          content: t("notify_tray"),
        });
        mainWindow.trayNotificationShown = true;
      }
    } else {
      // Pause music and close
      event.preventDefault();

      try {
        if (ytView && !ytView.webContents.isDestroyed()) {
          await ytView.webContents.executeJavaScript(`
            try {
              const audio = document.querySelector('audio');
              const video = document.querySelector('video');
              const playButton = document.querySelector('[data-testid="play-pause-button"], .play-pause-button, [aria-label*="pause" i], [title*="pause" i]');
              
              if (audio && !audio.paused) audio.pause();
              if (video && !video.paused) video.pause();
              if (playButton && playButton.getAttribute('aria-label') && playButton.getAttribute('aria-label').toLowerCase().includes('pause')) {
                playButton.click();
              }
            } catch (e) {
              console.log('Could not pause audio:', e);
            }
          `);
          let currentUrl = ytView.webContents.getURL();

          // Only save URL/time parameter if 'openLastSong' is enabled
          if (openLastSong) {
            // Only add time parameter if 'resumePlayback' is enabled AND it's a watch page
            if (
              resumePlayback &&
              currentUrl.includes("music.youtube.com/watch")
            ) {
              // Execute script to get current time in seconds
              const currentTimeValue = await ytView.webContents
                .executeJavaScript(`
                  // Get the 'value' attribute of the progress bar slider, which is the time in seconds
                  document.querySelector('#progress-bar > #sliderContainer > div > #sliderBar')?.getAttribute('value');
              `);

              // Convert the value to an integer
              const timeInSeconds = parseInt(currentTimeValue, 10);

              // Check if the time is a valid positive number
              if (!isNaN(timeInSeconds) && timeInSeconds > 0) {
                // Use URL object for clean parameter management
                try {
                  const urlObject = new URL(currentUrl);
                  urlObject.searchParams.set("t", timeInSeconds);
                  currentUrl = urlObject.toString();
                } catch (e) {
                  console.log(
                    "Error modifying URL with time parameter:",
                    e.message,
                  );
                }
              }
            }
          } else {
            // If openLastSong is disabled, force default URL for next launch
            currentUrl = "https://music.youtube.com";
          }

          lastUrl = currentUrl;
          await saveConfig();
          console.log(`URL saved: ${lastUrl}`);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        app.quit();
      } catch (error) {
        console.log("Error pausing audio:", error);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        app.quit();
      }
    }
  });

  const youtubeMusicDomain = "music.youtube.com";

  let finalUrlToLoad = `https://${youtubeMusicDomain}`;

  try {
    const parsedUrl = new URL(lastUrl);
    if (parsedUrl.hostname === youtubeMusicDomain) {
      if (openLastSong && !resumePlayback) {
        parsedUrl.searchParams.delete("t");
      } else if (!openLastSong) {
        parsedUrl.pathname = "/";
        parsedUrl.search = "";
      }
      finalUrlToLoad = parsedUrl.toString();
    } else {
      console.warn(
        `Attempted to load an invalid URL: ${lastUrl}. Defaulting to ${finalUrlToLoad}`,
      );
    }
  } catch (e) {
    console.error(`Error parsing lastUrl "${lastUrl}":`, e.message);
  }

  ytView.webContents.loadURL(finalUrlToLoad);
  console.log(`Loading URL: ${finalUrlToLoad}`);

  // Offline page
  ytView.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.log(
          `Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
        );
        ytView.webContents.loadFile(path.join(__dirname, "offline/offline.html"));
      }
    },
  );

  // Hide cast buttons & inject scripts on every load / refresh
  let initialLoadDone = false;
  ytView.webContents.on("did-finish-load", () => {
    ytView.webContents.insertCSS(`
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
    `);
    console.log("Cast buttons hidden");

    injectVideoAdSkipper(ytView.webContents, {
      enabled: videoAdSkipperEnabled,
      speed: VideoAdSkipSpeed,
      interval: VideoAdSkipInterval,
    });

    if (!initialLoadDone) {
      initialLoadDone = true;
      const playerHost = {
        get webContents() { return ytView.webContents; },
        isDestroyed: () => !ytView || ytView.webContents.isDestroyed(),
        loadURL: (url) => ytView.webContents.loadURL(url),
      };
      initDiscordRpc(playerHost);
      initListenAlong(playerHost, pushListenAlongState);
      if (listenAlongAutoHost && listenAlongHostName && listenAlongHostName.trim().length >= 3) {
        require("./listen-along/listenAlong").triggerAutoHostOnStartup(listenAlongHostName);
      }
    }

    // Inject JavaScript to auto-continue listening
    ytView.webContents.executeJavaScript(`
      (function() {
        const checkInterval = ${autoContinueListeningInterval};
        let lastDismissTime = 0;

        function dismissDialog() {
          try {
            // Prevent rapid re-clicking
            const now = Date.now();
            if (now - lastDismissTime < 2000) return false;
        
            // Multiple dialog selectors
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
        
            // Check dialog content
            const dialogText = dialog.textContent?.toLowerCase() || '';
            const isKeepListeningDialog = dialogText.includes('still listening') || 
                                           dialogText.includes('still there') || 
                                           dialogText.includes('you there') ||
                                           dialogText.includes('video paused') ||
                                           dialogText.includes('continue watching');

            if (!isKeepListeningDialog) return false;

            // Multiple button selectors
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

        // Check periodically
        setInterval(dismissDialog, checkInterval);

        // Watch for dialog appearing
        const observer = new MutationObserver(dismissDialog);
        observer.observe(document.body, { childList: true, subtree: true });

        console.log('Auto-continue listening feature initialized');
      })();
    `);
  });
}

handleStartupSettings();

// Updater event handlers
autoUpdater.on("checking-for-update", () => {
  console.log("Checking for update...");
});

autoUpdater.on("update-available", (info) => {
  console.log("Update available:", info);
});

autoUpdater.on("update-not-available", (info) => {
  console.log("Update not available:", info);
});

autoUpdater.on("error", (err) => {
  console.log("Error in auto-updater:", err);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: t("update_error"),
      message: `Error: ${err.message}`,
      buttons: [t("ok")],
    });
  }
});

autoUpdater.on("download-progress", (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + " - Downloaded " + progressObj.percent + "%";
  log_message =
    log_message +
    " (" +
    progressObj.transferred +
    "/" +
    progressObj.total +
    ")";
  console.log(log_message);
});

autoUpdater.on("update-downloaded", (info) => {
  console.log("Update downloaded:", info);
  if (mainWindow) {
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: t("update_ready"),
        message: t("update_ready_message"),
        buttons: [t("restart_now"), t("later")],
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  }
});

if (gotTheLock) {
  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.close();
    }
    if (!minimizeToTray) {
      if (process.platform !== "darwin") {
        app.quit();
      }
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
        miniPlayerWindow.close();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
