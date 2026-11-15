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
const {
  initDiscordRpc,
  setDiscordRpcEnabled,
} = require("./integrations/discordRpc");
const {
  initListenAlong,
  createParty,
  closeParty,
  joinParty,
  leaveParty,
  getListenAlongState,
  DEFAULT_SERVER_URL,
  normalizeName,
} = require("./listen-along/listenAlong");

const {
  captureCurrentSongState,
  saveLastSongSession,
  computeStartupUrl,
  applyStartupPlayback,
} = require("./player/sessionRestore");
const { hideCastButtons } = require("./player/castHider");
const { injectAutoContinue } = require("./player/autoContinue");
const {
  initMiniPlayer,
  createMiniPlayerWindow,
  closeMiniPlayerWindow,
  resetMiniPlayerPosition,
  toggleMiniPlayerOnMinimize,
  getOpenMiniPlayerOnMinimize,
  getMiniPlayerConfig,
  applyMiniPlayerConfig,
  triggerQuickPoll,
} = require("./mini-player/miniPlayerManager");

let mainWindow;
let ytView = null;
let lastFailedUrl = null;
let optionsView = null;
let isOptionsOpen = false;
const TOPBAR_HEIGHT = 38;
let tray;
let minimizeToTray = false;
let openLastSong = false;
let resumePlayback = false;
let lastUrl = "https://music.youtube.com";
let mainWindowBounds = { x: undefined, y: undefined, width: 1200, height: 800 };
let discordRpcEnabled = true;

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
    videoAdSkipperEnabled = !!config.videoAdSkipperEnabled;
    VideoAdSkipSpeed = config.VideoAdSkipSpeed || 2;
    openLastSong =
      config.openLastSong !== undefined ? config.openLastSong : true;
    lastUrl = openLastSong
      ? config.lastUrl || "https://music.youtube.com"
      : "https://music.youtube.com";
    resumePlayback = config.resumePlayback || false;
    discordRpcEnabled = config.discordRpcEnabled !== undefined ? !!config.discordRpcEnabled : true;
    mainWindowBounds = config.mainWindowBounds || {
      x: undefined,
      y: undefined,
      width: 1200,
      height: 800,
    };
    applyMiniPlayerConfig(config);

    // Listen Along config
    listenAlongServerUrl = config.listenAlongServerUrl || DEFAULT_SERVER_URL;
    listenAlongHostName = normalizeName(config.listenAlongHostName);
    listenAlongAutoHost = !!config.listenAlongAutoHost;
    require("./listen-along/listenAlong").setAutoHost(listenAlongAutoHost, listenAlongHostName);

    const miniConfig = getMiniPlayerConfig();
    console.log(
      `Config loaded - Minimize to tray: ${minimizeToTray}, Video ad skipper: ${videoAdSkipperEnabled}, Video ad skip speed: ${VideoAdSkipSpeed}, Last URL: ${lastUrl}, Open last song: ${openLastSong}, Resume playback: ${resumePlayback}, Mini-player bounds: ${JSON.stringify(miniConfig.miniPlayerBounds)}, Main window bounds: ${JSON.stringify(mainWindowBounds)}, Mini-player theme: ${miniConfig.miniPlayerTheme}, Listen along auto-host: ${listenAlongAutoHost}`,
    );
    return config;
  } catch (error) {
    console.log("Using default config settings");
    return {};
  }
}

async function saveConfig() {
  try {
    const miniConfig = getMiniPlayerConfig();
    const config = {
      minimizeToTray: minimizeToTray,
      openMiniPlayerOnMinimize: miniConfig.openMiniPlayerOnMinimize,
      videoAdSkipperEnabled: videoAdSkipperEnabled,
      VideoAdSkipSpeed: VideoAdSkipSpeed,
      lastUrl: lastUrl,
      openLastSong: openLastSong,
      resumePlayback: resumePlayback,
      discordRpcEnabled: discordRpcEnabled,
      miniPlayerBounds: miniConfig.miniPlayerBounds,
      mainWindowBounds: mainWindowBounds,
      miniPlayerTheme: miniConfig.miniPlayerTheme,
      miniPlayerAlwaysOnTop: miniConfig.miniPlayerAlwaysOnTop,
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
  const name = normalizeName(hostName || listenAlongHostName);
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
  const name = normalizeName(guestName || listenAlongHostName);
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
  if (hostName !== undefined) {
    const name = normalizeName(hostName);
    if (listenAlongHostName !== name) {
      listenAlongHostName = name;
    }
  }
  if (autoHost !== undefined) {
    listenAlongAutoHost = !!autoHost && (listenAlongHostName.length >= 3);
  }

  require("./listen-along/listenAlong").setAutoHost(listenAlongAutoHost, listenAlongHostName);
  saveConfig();
});

ipcMain.on("la:open-party-page", (_e, { partyId }) => {
  const code = String(partyId || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(code)) {
    console.warn("Blocked opening party page with invalid party code");
    return;
  }
  const url = DEFAULT_SERVER_URL.replace(/\/$/, "");
  shell.openExternal(`${url}/party/${code}`).catch(console.error);
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
    reloadPlayerView();
    event.preventDefault();
  } else if (input.control && input.key === ",") {
    toggleOptionsView();
    event.preventDefault();
  } else if (input.control && input.key.toLowerCase() === "q") {
    app.isQuiting = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    } else {
      app.quit();
    }
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
  reloadPlayerView();
});

ipcMain.on("topbar:quit", () => {
  app.isQuiting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.quit();
  }
});

function getPlayerWebContents() {
  if (ytView && !ytView.webContents.isDestroyed()) return ytView.webContents;
  if (mainWindow && !mainWindow.webContents.isDestroyed()) return mainWindow.webContents;
  return null;
}

ipcMain.handle("get-filters", async () => {
  return await getFiltersExternal();
});

ipcMain.handle("get-translations", (event, keys) => {
  const translations = {};
  const requestedKeys = Array.isArray(keys) ? keys : [];
  requestedKeys.forEach((key) => {
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
  const success = await initFiltersExternal(false);
  adblockActive = !!success;
  if (success) setupWRExternal();
});

ipcMain.on("reset-filters", async (event) => {
  try {
    await resetFiltersExternal();
    console.log("User filters reset to default successfully.");
    const success = await initFiltersExternal(false);
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
    disclaimer: t("about_disclaimer"),
    githubUrl: "https://github.com/nubsuki/AurPlayer",
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
  videoAdSkipperEnabled = !!settings.enabled;
  VideoAdSkipSpeed = settings.speed || 2;
  await saveConfig();
  // Apply immediately without requiring a page reload
  if (ytView && !ytView.webContents.isDestroyed()) {
    injectVideoAdSkipper(ytView.webContents, {
      enabled: videoAdSkipperEnabled,
      speed: VideoAdSkipSpeed,
      interval: VideoAdSkipInterval,
    });
  }
  console.log(
    `Video ad skipper settings updated: Enabled=${videoAdSkipperEnabled}, Speed=${VideoAdSkipSpeed}x`,
  );
});

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:"]);

function openExternalSafely(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    console.warn("Blocked external link with invalid URL");
    return;
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`Blocked external link with unsupported protocol: ${parsed.protocol}`);
    return;
  }
  shell
    .openExternal(parsed.toString())
    .catch((error) => console.error("Error opening external link:", error));
}

ipcMain.on("open-external-link", (event, url) => {
  openExternalSafely(url);
});

// Hosts the embedded YouTube Music view is allowed to navigate to
const ALLOWED_YT_HOST_SUFFIXES = [
  "youtube.com",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "googlevideo.com",
  "ggpht.com",
  "ytimg.com",
];

function isAllowedYtMusicHost(rawUrl) {
  let hostname;
  try {
    hostname = new URL(String(rawUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_YT_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

// Reload the player, retrying the last real URL if the offline page is showing
function reloadPlayerView() {
  if (!ytView || ytView.webContents.isDestroyed()) return;
  if (ytView.webContents.getURL().startsWith("file:")) {
    ytView.webContents.loadURL(lastFailedUrl || "https://music.youtube.com");
  } else {
    ytView.webContents.reload();
  }
}

// Options window IPC
ipcMain.handle("options:get-app-settings", () => {
  const loginItemSettings = app.getLoginItemSettings();
  return {
    startWithSystem: loginItemSettings.openAtLogin,
    openLastSong,
    resumePlayback,
    minimizeToTray,
    openMiniPlayerOnMinimize: getOpenMiniPlayerOnMinimize(),
    discordRpcEnabled,
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
  if (typeof s.discordRpcEnabled === "boolean" && s.discordRpcEnabled !== discordRpcEnabled) {
    discordRpcEnabled = s.discordRpcEnabled;
    setDiscordRpcEnabled(discordRpcEnabled);
    saveConfig();
  }
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

let lastRatingControlTime = 0;

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
    case "like": {
      const now = Date.now();
      if (now - lastRatingControlTime < 350) return;
      lastRatingControlTime = now;
      script =
        '{ const btn = document.querySelector("#button-shape-like > button") || document.querySelector("ytmusic-like-button-renderer #button-shape-like > button"); if (btn) btn.click(); }';
      break;
    }
    case "dislike": {
      const now = Date.now();
      if (now - lastRatingControlTime < 350) return;
      lastRatingControlTime = now;
      script =
        '{ const btn = document.querySelector("#button-shape-dislike > button") || document.querySelector("ytmusic-like-button-renderer #button-shape-dislike > button"); if (btn) btn.click(); }';
      break;
    }
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
      closeMiniPlayerWindow();
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
    triggerQuickPoll(300);
  }
});

function createTray() {
  if (tray) return;

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t("show"),
      click: () => {
        closeMiniPlayerWindow();
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
        resetMiniPlayerPosition();
        saveConfig();

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setSize(1200, 800);
          mainWindow.center();
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
      if (getOpenMiniPlayerOnMinimize()) {
        createMiniPlayerWindow();
      }
    } else {
      // Close the mini player when showing the main window
      closeMiniPlayerWindow();
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
  if (enabled) {
    if (ytView && !ytView.webContents.isDestroyed()) {
      captureCurrentSongState(ytView.webContents).then((st) => {
        if (st && st.songUrl) lastUrl = st.songUrl;
        saveConfig();
      });
    } else {
      saveConfig();
    }
  } else {
    lastUrl = "https://music.youtube.com";
    saveConfig();
  }
  createMenu();
  console.log(`Open last song: ${enabled ? "Enabled" : "Disabled"}`);
}

function toggleResumeBehavior(enabled) {
  resumePlayback = enabled;
  saveConfig();
  createMenu();
  console.log(`Resume playback: ${enabled ? "Enabled" : "Disabled"}`);
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

  initMiniPlayer({
    getMainWindow: () => mainWindow,
    getPlayerWebContents: () => getPlayerWebContents(),
    iconPath,
    saveConfig: () => saveConfig(),
    createMenu: () => createMenu(),
    t,
    isQuitting: () => app.isQuiting,
  });

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
    title: "AurPlayer",
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

  // Restrict navigation and popups from the remote YouTube Music content
  ytView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedYtMusicHost(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    openExternalSafely(url);
    return { action: "deny" };
  });
  ytView.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedYtMusicHost(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
  ytView.webContents.on("did-navigate-in-page", (_e, url) => {
    if (openLastSong && url && isAllowedYtMusicHost(url) && (url.includes("/watch") || url.includes("v="))) {
      lastUrl = url;
    }
  });

  let saveMainWindowBoundsTimer = null;
  const saveMainWindowBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      mainWindowBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      if (saveMainWindowBoundsTimer) clearTimeout(saveMainWindowBoundsTimer);
      saveMainWindowBoundsTimer = setTimeout(() => {
        saveConfig();
      }, 500);
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
      mainWindow.setTitle(title || "AurPlayer");
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

      if (getOpenMiniPlayerOnMinimize()) {
        createMiniPlayerWindow();
      }

      if (tray && !mainWindow.trayNotificationShown) {
        tray.displayBalloon({
          iconType: "info",
          title: "AurPlayer",
          content: t("notify_tray"),
        });
        mainWindow.trayNotificationShown = true;
      }
    } else {
      // Pause music and close
      event.preventDefault();

      try {
        if (ytView && !ytView.webContents.isDestroyed()) {
          lastUrl = await saveLastSongSession(ytView.webContents, {
            openLastSong,
            resumePlayback,
            defaultUrl: "https://music.youtube.com",
          });
          await saveConfig();
          console.log(`URL saved: ${lastUrl}`);
        }
      } catch (error) {
        console.log("Error closing window:", error);
      } finally {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        app.quit();
      }
    }
  });

  const finalUrlToLoad = computeStartupUrl(lastUrl, { openLastSong, resumePlayback });
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
        lastFailedUrl = validatedURL || lastFailedUrl;
        ytView.webContents.loadFile(path.join(__dirname, "offline/offline.html"));
      }
    },
  );

  // Hide cast buttons & inject scripts on every load / refresh
  let initialLoadDone = false;
  ytView.webContents.on("did-finish-load", () => {
    if (!ytView.webContents.getURL().startsWith("file:")) {
      lastFailedUrl = null;
    }
    hideCastButtons(ytView.webContents);

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
      initDiscordRpc(playerHost, discordRpcEnabled);
      initListenAlong(playerHost, pushListenAlongState);
      require("./listen-along/listenAlong").setAutoHost(listenAlongAutoHost, listenAlongHostName);
      if (listenAlongAutoHost && listenAlongHostName && listenAlongHostName.trim().length >= 3) {
        console.log(`[ListenAlong] Triggering auto-host on startup for "${listenAlongHostName}"...`);
        require("./listen-along/listenAlong").triggerAutoHostOnStartup(listenAlongHostName);
      }
      applyStartupPlayback(ytView.webContents, { openLastSong, resumePlayback, lastUrl });
    }

    injectAutoContinue(ytView.webContents, autoContinueListeningInterval);
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
    closeMiniPlayerWindow();
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
      closeMiniPlayerWindow();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
