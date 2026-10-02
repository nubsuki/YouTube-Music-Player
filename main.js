require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  dialog,
  screen,
} = require("electron");
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
let settingsWindow;
let tray;
let minimizeToTray = false;
let openMiniPlayerOnMinimize = false;
let openLastSong = false;
let resumePlayback = false;
let lastUrl = "https://music.youtube.com";
let aboutWindow;
let miniPlayerWindow;
let miniPlayerBounds = { x: undefined, y: undefined, width: 320, height: 105 };
let mainWindowBounds = { x: undefined, y: undefined, width: 1200, height: 800 };
let miniPlayerTheme = "blur";
let miniPlayerAlwaysOnTop = true;

// Listen Along
let listenAlongWindow = null;
let listenAlongServerUrl = DEFAULT_SERVER_URL;
let listenAlongHostName = "";

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
    };

    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    console.log("Config saved");
  } catch (error) {
    console.log("Error saving config:", error.message);
  }
}

// Load a specific language file

// Listen Along window
function createListenAlongWindow() {
  if (listenAlongWindow && !listenAlongWindow.isDestroyed()) {
    listenAlongWindow.focus();
    return;
  }

  listenAlongWindow = new BrowserWindow({
    width: 430,
    height: 580,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: false,
    titleBarStyle: "hidden",
    title: "Listen Along",
    webPreferences: {
      preload: path.join(__dirname, "listen-along/listen-along-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: iconPath,
  });

  listenAlongWindow.setMenu(null);
  listenAlongWindow.loadFile(
    path.join(__dirname, "listen-along/listen-along.html"),
  );

  listenAlongWindow.once("ready-to-show", () => listenAlongWindow.show());

  listenAlongWindow.on("closed", () => {
    listenAlongWindow = null;
  });
}

// Listen Along IPC handlers
const { clipboard } = require("electron");

function _la_ipc() {
  return require("electron").ipcMain;
}

_la_ipc().handle("la:create-party", async (_e, { hostName }) => {
  const partyId = await createParty(
    DEFAULT_SERVER_URL,
    hostName || listenAlongHostName,
  );
  return { partyId };
});

_la_ipc().handle("la:join-party", async (_e, { partyId, guestName }) => {
  return await joinParty(
    DEFAULT_SERVER_URL,
    partyId,
    guestName || listenAlongHostName,
  );
});

_la_ipc().handle("la:close-party", async () => {
  await closeParty();
});

_la_ipc().handle("la:leave-party", async () => {
  await leaveParty();
});

_la_ipc().handle("la:get-state", () => getListenAlongState());

_la_ipc().handle("la:get-config", () => ({
  serverUrl: DEFAULT_SERVER_URL,
  hostName: listenAlongHostName,
}));

_la_ipc().on("la:save-config", (_e, { hostName }) => {
  if (hostName !== undefined) listenAlongHostName = hostName;
  saveConfig();
});

_la_ipc().on("la:open-party-page", (_e, { partyId }) => {
  const url = DEFAULT_SERVER_URL.replace(/\/$/, "");
  shell.openExternal(`${url}/party/${partyId}`).catch(console.error);
});

_la_ipc().on("la:copy-text", (_e, text) => {
  clipboard.writeText(String(text));
});

_la_ipc().handle("la:read-clipboard", () => {
  try {
    const text = clipboard.readText();
    return typeof text === "string" ? text.trim() : "";
  } catch (e) {
    return "";
  }
});

_la_ipc().on("la:close-window", () => {
  if (listenAlongWindow && !listenAlongWindow.isDestroyed()) {
    listenAlongWindow.close();
  }
});

// Push state change events to the Listen Along window
function pushListenAlongState(state) {
  if (listenAlongWindow && !listenAlongWindow.isDestroyed()) {
    listenAlongWindow.webContents.send("la:state-changed", state);
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

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    parent: mainWindow,
    modal: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "settings-filters/sf-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: iconPath,
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadFile(
    path.join(__dirname, "settings-filters/settings-filters.html"),
  );

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function createAboutWindow() {
  aboutWindow = new BrowserWindow({
    width: 450,
    height: 450,
    parent: mainWindow,
    modal: true,
    show: false,
    resizable: false,
    icon: iconPath,
    title: t("about_app"),
    webPreferences: {
      preload: path.join(__dirname, "about/about-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Remove the menu bar for the about window
  aboutWindow.setMenu(null);

  // Load the new about.html file
  aboutWindow.loadFile(path.join(__dirname, "about/about.html"));

  // Show the window once it is ready
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });

  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
}

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
  const safeBounds = ensureWindowIsVisible(miniPlayerBounds, defaultMiniBounds);

  miniPlayerWindow = new BrowserWindow({
    width: safeBounds.width || 320,
    height: safeBounds.height || 105,
    x: safeBounds.x,
    y: safeBounds.y,
    parent: mainWindow.isVisible() ? mainWindow : null,
    frame: false,
    resizable: false,
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
      if (mainWindow.webContents.isDestroyed()) return;
      const state = await mainWindow.webContents.executeJavaScript(`
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

const { ipcMain } = require("electron");

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
    height: 250,
    parent: parentWindow,
    modal: !!parentWindow,
    frame: true,
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
  });
}

ipcMain.on("open-mini-player-settings", () => {
  createMiniPlayerSettingsWindow();
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

ipcMain.on("resize-about-window", (event, width, height) => {
  if (aboutWindow) {
    // Set the size and adjust content bounds (important for different OS)
    aboutWindow.setSize(width, height, true);

    // Center the window after resizing
    aboutWindow.center();
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

  if (script && mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(script).catch((e) => {
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
  const loginItemSettings = app.getLoginItemSettings();

  const template = [
    {
      label: t("settings"),
      submenu: [
        {
          label: t("start_with_system"),
          type: "checkbox",
          checked: loginItemSettings.openAtLogin,
          click: (menuItem) => {
            app.setLoginItemSettings({
              openAtLogin: menuItem.checked,
              path: app.getPath("exe"),
            });
            console.log(`Startup ${menuItem.checked ? "enabled" : "disabled"}`);
          },
        },
        { type: "separator" },
        {
          label: t("minimize_to_tray"),
          type: "checkbox",
          checked: minimizeToTray,
          click: (menuItem) => {
            toggleTrayBehavior(menuItem.checked);
          },
        },
        // Show tray options only when enabled
        ...(minimizeToTray
          ? [
              {
                label: t("open_mini_player"),
                type: "checkbox",
                checked: openMiniPlayerOnMinimize,
                click: (menuItem) => {
                  toggleMiniPlayerOnMinimize(menuItem.checked);
                },
              },
            ]
          : []),
        ...(minimizeToTray
          ? [
              {
                label: t("hide_to_tray"),
                accelerator: "Ctrl+H",
                click: () => {
                  mainWindow.hide();
                },
              },
            ]
          : []),
        {
          label: t("mini_player_settings"),
          click: () => {
            createMiniPlayerSettingsWindow();
          },
        },
        { type: "separator" },
        {
          label: t("reopen_last_song"),
          type: "checkbox",
          checked: openLastSong,
          click: (menuItem) => {
            toggleReOpenBehavior(menuItem.checked);
          },
        },
        ...(openLastSong
          ? [
              {
                label: t("resume_playback"),
                type: "checkbox",
                checked: resumePlayback,
                click: (menuItem) => {
                  toggleResumeBehavior(menuItem.checked);
                },
              },
            ]
          : []),
        { type: "separator" },
        {
          label: t("ad_filter_settings"),
          click: () => {
            createSettingsWindow();
          },
        },
        {
          label: t("update_ad_filters"),
          click: async () => {
            console.log("Manually updating filters...");
            const success = await initFiltersExternal(true);
            console.log(success ? "Filters updated!" : "Filter update failed");

            console.log("Restarting...");
            app.isQuiting = true;

            if (
              miniPlayerSettingsWindow &&
              !miniPlayerSettingsWindow.isDestroyed()
            )
              miniPlayerSettingsWindow.close();
            if (settingsWindow && !settingsWindow.isDestroyed())
              settingsWindow.close();
            if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
            if (miniPlayerWindow && !miniPlayerWindow.isDestroyed())
              miniPlayerWindow.close();

            app.relaunch();
            app.quit();
          },
        },
        { type: "separator" },
        {
          label: t("quit"),
          accelerator: "Ctrl+Q",
          click: () => {
            app.isQuiting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: "Listen Along",
      click: () => {
        createListenAlongWindow();
      },
    },
    {
      label: t("help"),
      submenu: [
        {
          label: t("check_for_updates"),
          click: async () => {
            try {
              // Check for updates
              const result = await autoUpdater.checkForUpdates();

              if (
                result &&
                result.updateInfo &&
                result.updateInfo.version !== APP_VERSION
              ) {
                // Update available
                const updateResult = await dialog.showMessageBox(mainWindow, {
                  type: "question",
                  title: t("update_available"),
                  message: t("a_new_version_q", result.updateInfo.version),
                  buttons: [t("download_now"), t("not_now")],
                  defaultId: 0,
                  cancelId: 1,
                });

                if (updateResult.response === 0) {
                  // show progress dialog
                  dialog.showMessageBox(mainWindow, {
                    type: "info",
                    title: t("downloading_update"),
                    message: t("downloading_in_background"),
                    buttons: [t("ok")],
                  });

                  // Start download
                  autoUpdater.downloadUpdate();
                }
              } else {
                // No updates available
                dialog.showMessageBox(mainWindow, {
                  type: "info",
                  title: t("no_updates_available"),
                  message: t("no_updates_available_message"),
                  buttons: [t("ok")],
                });
              }
            } catch (error) {
              dialog.showMessageBox(mainWindow, {
                type: "error",
                title: t("update_error"),
                message: t("error_d", error.message),
                buttons: [t("ok")],
              });
            }
          },
        },
        {
          label: t("about"),
          click: () => {
            createAboutWindow();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function createWindow() {
  await loadConfig();

  // Get system locale and load language
  const userLocale = app.getLocale().split("-")[0];
  await loadLanguage(userLocale);

  if (minimizeToTray) {
    createTray();
  }

  const safeMainBounds = ensureWindowIsVisible(mainWindowBounds, {
    x: undefined,
    y: undefined,
    width: 1200,
    height: 800,
  });

  mainWindow = new BrowserWindow({
    width: safeMainBounds.width || 1200,
    height: safeMainBounds.height || 800,
    x: safeMainBounds.x,
    y: safeMainBounds.y,
    autoHideMenuBar: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
    },
  });

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
  mainWindow.on("resized", saveMainWindowBounds);

  // Enable F12 and Ctrl+Shift+i for DevTools - for Advanced Users
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  createMenu();

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
        await mainWindow.webContents.executeJavaScript(`
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
        let currentUrl = mainWindow.webContents.getURL();

        // Only save URL/time parameter if 'openLastSong' is enabled
        if (openLastSong) {
          // Only add time parameter if 'resumePlayback' is enabled AND it's a watch page
          if (
            resumePlayback &&
            currentUrl.includes("music.youtube.com/watch")
          ) {
            // Execute script to get current time in seconds
            const currentTimeValue = await mainWindow.webContents
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

  mainWindow.loadURL(finalUrlToLoad);
  console.log(`Loading URL: ${finalUrlToLoad}`);

  // Offline page
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.log(
          `Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
        );
        mainWindow.loadFile(path.join(__dirname, "offline/offline.html"));
      }
    },
  );

  // Hide cast buttons
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.insertCSS(`
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
      .ytmusic-nav-bar [role="button"][aria-label*="cast" i],
      .ytmusic-nav-bar [role="button"][aria-label*="connect" i],
      .ytmusic-menu-service-item-renderer:has([aria-label*="cast" i]),
      .ytmusic-menu-service-item-renderer:has([aria-label*="connect" i])
      {
        display: none !important;
        visibility: hidden !important;
      }
    `);
    console.log("Cast buttons hidden");

    injectVideoAdSkipper(mainWindow.webContents, {
      enabled: videoAdSkipperEnabled,
      speed: VideoAdSkipSpeed,
      interval: VideoAdSkipInterval,
    });
    initDiscordRpc(mainWindow);
    initListenAlong(mainWindow, pushListenAlongState);

    // Inject JavaScript to auto-continue listening
    mainWindow.webContents.executeJavaScript(`
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
