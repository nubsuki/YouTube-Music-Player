const { app, BrowserWindow, session, Menu, Tray, shell, dialog } = require("electron");
const { StaticNetFilteringEngine } = require("@gorhill/ubo-core");
const { autoUpdater } = require("electron-updater");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const path = require('path');
const fs = require('fs').promises;

let snfe;
let mainWindow;
let tray;
let minimizeToTray = false;
let openLastSong = true;
let resumePlayback = false;
let lastUrl = "https://music.youtube.com";
let aboutWindow;

// Video ad skipping settings
let videoAdSkipperEnabled = true;
let VideoAdSkipSpeed = 2;
let VideoAdSkipInterval = 200;

// Support for multiple languages
const i18n = {};

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const USER_FILTERS_FILE = path.join(app.getPath('userData'), 'user-filters.json');
const { version: APP_VERSION } = require('./package.json');

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

// Icon
const iconPath = process.platform === 'win32' 
  ? path.join(__dirname, 'assets', 'icon.ico')
  : path.join(__dirname, 'assets', 'icon.png');

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Cache settings - 24 hour expiration
const CACHE_DIR = path.join(app.getPath('userData'), 'ytmp-filters');
const CACHE_DURATION = 24 * 60 * 60 * 1000;

async function loadConfig() {
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);
    
    minimizeToTray = config.minimizeToTray || false;
    videoAdSkipperEnabled = config.videoAdSkipperEnabled !== false;
    VideoAdSkipSpeed = config.VideoAdSkipSpeed || 2;
    openLastSong = config.openLastSong !== undefined ? config.openLastSong : true;
    lastUrl = openLastSong ? (config.lastUrl || "https://music.youtube.com") : "https://music.youtube.com";
    resumePlayback = config.resumePlayback || false;
    
    console.log(`Config loaded - Minimize to tray: ${minimizeToTray}, Video ad skipper: ${videoAdSkipperEnabled}, Video ad skip speed: ${VideoAdSkipSpeed}, Last URL: ${lastUrl}, Open last song: ${openLastSong}, Resume playback: ${resumePlayback}`);
    return config;
  } catch (error) {
    console.log('Using default config settings');
    return {};
  }
}

async function saveConfig() {
  try {
    const config = {
      minimizeToTray: minimizeToTray,
      videoAdSkipperEnabled: videoAdSkipperEnabled,
      VideoAdSkipSpeed: VideoAdSkipSpeed,
      lastUrl: lastUrl,
      openLastSong: openLastSong,
      resumePlayback: resumePlayback
    };
    
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    
    console.log('Config saved');
  } catch (error) {
    console.log('Error saving config:', error.message);
  }
}

// Load a specific language file
async function loadLanguage(lang) {
  // Try to load the language file from the 'locales' directory
  const langPath = path.join(__dirname, 'locales', `${lang}.json`);
  try {
    const data = await fs.readFile(langPath, 'utf8');
    // Parse the JSON data and merge it with the existing i18n object
    Object.assign(i18n, JSON.parse(data));
    console.log(`Language loaded: ${lang}`);
  } catch (error) {
    console.error(`Error loading language file for ${lang}:`, error.message);
    // Fallback to English if the requested language is not available
    if (lang !== 'en') {
      console.log('Falling back to English...');
      await loadLanguage('en');
    }
  }
}

// Get the translated string for a given key
function t(key, ...args) {
  const text = i18n[key] || key;
  return text.replace(/{(\d+)}/g, (match, number) => {
    return typeof args[number] !== 'undefined' ? args[number] : match;
  });
}

async function saveUserFilters(userFilters) {
  try {
    await fs.writeFile(USER_FILTERS_FILE, JSON.stringify(userFilters, null, 2), 'utf8');
    console.log('User filters saved successfully');
  } catch (error) {
    console.log('Error saving user filters:', error.message);
  }
}

async function loadUserFilters() {
  try {
    const filtersData = await fs.readFile(USER_FILTERS_FILE, 'utf8');
    const userFilters = JSON.parse(filtersData);
    console.log('User filters loaded successfully');
    return userFilters;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No user filters file found, using defaults.');
      await saveUserFilters(filterLists);
      return filterLists;
    } else {
      console.log('Error loading user filters:', error.message);
    }
    // Return an empty array if the file doesn't exist or an error occurs
    return [];
  }
}

function createSettingsWindow() {
  const settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    parent: mainWindow,
    modal: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-filters/sf-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  
  // Set the menu to null for the settings window
  settingsWindow.setMenu(null);

  settingsWindow.loadFile(path.join(__dirname, 'settings-filters/settings-filters.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
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
    title: t('about_app'),
    webPreferences: {
      preload: path.join(__dirname, 'about/about-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Remove the menu bar for the about window
  aboutWindow.setMenu(null);

  // Load the new about.html file
  aboutWindow.loadFile(path.join(__dirname, 'about/about.html'));

  // Show the window once it is ready
  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
}

const { ipcMain } = require('electron');

ipcMain.handle('get-filters', async () => {
  return await loadUserFilters();
});

ipcMain.handle('get-translations', (event, keys) => {
  const translations = {};
  keys.forEach(key => {
      translations[key] = t(key);
  });
  return translations;
});

ipcMain.on('save-filters', async (event, newFilters) => {
  await saveUserFilters(newFilters);
  // Reload the filter engine with the new user settings
  await initializeFilterEngine(true);
});

ipcMain.on('reset-filters', async (event) => {
  try {
      await saveUserFilters(filterLists);
      console.log('User filters reset to default successfully.');
      // Re-initialize the filter engine to apply the changes immediately
      await initializeFilterEngine(true);
  } catch (error) {
      console.log('Error resetting user filters:', error.message);
  }
});

ipcMain.handle('get-about-info', () => {
  return {
    appName: t('app_name'),
    appVersion: APP_VERSION,
    appDescription: t('about_app_description'),
    githubUrl: 'https://github.com/nubsuki/YouTube-Music-Player',
    translations: {
        accept: t('accept'),
        version: t('version_label', APP_VERSION),
        github_link: t('github_link_text')
    }
  };
});

// Handle video ad skipper settings
ipcMain.handle('get-ad-skipper-settings', () => {
  return {
    enabled: videoAdSkipperEnabled,
    speed: VideoAdSkipSpeed
  };
});

ipcMain.on('save-ad-skipper-settings', async (event, settings) => {
  videoAdSkipperEnabled = settings.enabled;
  VideoAdSkipSpeed = settings.speed;
  await saveConfig();
  console.log(`Video ad skipper settings updated: Enabled=${videoAdSkipperEnabled}, Speed=${VideoAdSkipSpeed}x`);
});

ipcMain.on('open-external-link', (event, url) => {
  shell.openExternal(url)
    .catch(error => console.error('Error opening external link:', error));
});

ipcMain.on('resize-about-window', (event, width, height) => {
  if (aboutWindow) {
    // Set the size and adjust content bounds (important for different OS)
    aboutWindow.setSize(width, height, true);

    // Center the window after resizing
    aboutWindow.center();
  }
});

const filterLists = [
  {
    name: "easylist",
    url: "https://easylist.to/easylist/easylist.txt",
    description: "EasyList (Ad blocking)",
    enabled: true,
  },
  {
    name: "easyprivacy",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    description: "EasyPrivacy (Privacy protection)",
    enabled: true,
  },
  {
    name: "ublock-filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    description: "uBlock filters (Enhanced ad blocking)",
    enabled: true,
  },
  {
    name: "ublock-privacy",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    description: "uBlock Privacy filters",
    enabled: true,
  },
  {
    name: "ublock-badware",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
    description: "uBlock Badware protection",
    enabled: true,
  },
  {
    name: "ublock-unbreak",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt",
    description: "unbreak sites broken as a result of 3rd-party filter lists enabled by default",
    enabled: true,
  },
  {
    name: "ublock-Lite-filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/ubol-filters.txt",
    description: "Filters optimized for uBO Lite",
    enabled: true,
  }
];

function createTray() {
  if (tray) return;
    
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('show'),
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: t('quit'),
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.setToolTip(t('app_name'));
  
  // Double-click to show/hide
  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  console.log('System tray created');
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
    console.log('System tray removed');
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
  console.log(`Minimize to tray: ${enabled ? 'Enabled' : 'Disabled'}`);
}

function toggleReOpenBehavior(enabled) {
  openLastSong = enabled;
  saveConfig();
  createMenu();
  console.log(`Open last song: ${enabled ? 'Enabled' : 'Disabled'}`);
}

function toggleResumeBehavior(enabled) {
  resumePlayback = enabled;
  saveConfig();
  createMenu();
  console.log(`Resume playback: ${enabled ? 'Enabled' : 'Disabled'}`);
}

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.log('Error creating cache directory:', error.message);
  }
}

function getCacheFilePath(filterName) {
  return path.join(CACHE_DIR, `${filterName}.txt`);
}

function getCacheMetaPath(filterName) {
  return path.join(CACHE_DIR, `${filterName}.meta.json`);
}

// Check if cache is still valid (24 hours)
async function isCacheValid(filterName) {
  try {
    const metaPath = getCacheMetaPath(filterName);
    const metaData = await fs.readFile(metaPath, 'utf8');
    const { timestamp } = JSON.parse(metaData);
    return (Date.now() - timestamp) < CACHE_DURATION;
  } catch (error) {
    return false;
  }
}

async function loadFromCache(filterName) {
  try {
    const cacheFilePath = getCacheFilePath(filterName);
    const content = await fs.readFile(cacheFilePath, 'utf8');
    return content;
  } catch (error) {
    return null;
  }
}

async function saveToCache(filterName, content) {
  try {
    await ensureCacheDir();
    
    const cacheFilePath = getCacheFilePath(filterName);
    const metaPath = getCacheMetaPath(filterName);
    
    await fs.writeFile(cacheFilePath, content, 'utf8');
    await fs.writeFile(metaPath, JSON.stringify({ 
      timestamp: Date.now(),
      filterName 
    }), 'utf8');
    
    console.log(`${filterName} cached`);
  } catch (error) {
    console.log(`Error caching ${filterName}:`, error.message);
  }
}

async function downloadFilter(filterList) {
  try {
    console.log(`Downloading ${filterList.description}...`);
    const response = await fetch(filterList.url);
    if (response.ok) {
      const content = await response.text();
      await saveToCache(filterList.name, content);
      console.log(`${filterList.description} downloaded`);
      return content;
    } else {
      console.log(`Failed to download ${filterList.description}: ${response.status}`);
      return null;
    }
  } catch (error) {
    console.log(`Error downloading ${filterList.description}:`, error.message);
    return null;
  }
}

// Try cache first, download if expired
async function loadFilter(filterList, forceUpdate = false) {
  if (!forceUpdate && await isCacheValid(filterList.name)) {
    console.log(`Loading ${filterList.description} from cache...`);
    const cachedContent = await loadFromCache(filterList.name);
    if (cachedContent) {
      console.log(`${filterList.description} loaded from cache`);
      return cachedContent;
    }
  }
  
  return await downloadFilter(filterList);
}

// Load all filters in parallel
async function initializeFilterEngine(forceUpdate = false) {
  try {
    if (!snfe) {
      snfe = await StaticNetFilteringEngine.create();
    }
    
    const allFilterLists = await loadUserFilters();
    
    const enabledFilterLists = allFilterLists.filter(f => f.enabled);

    const filterPromises = enabledFilterLists.map(filterList => 
      loadFilter(filterList, forceUpdate).then(content => 
        content ? { name: filterList.name, raw: content } : null
      )
    );
    
    const results = await Promise.all(filterPromises);
    const validFilters = results.filter(result => result !== null);
    
    if (validFilters.length > 0) {
      await snfe.useLists(validFilters);
      console.log(`Filter engine ready with ${validFilters.length} lists!`);
      
      if (mainWindow) {
        createMenu();
      }
    }
    
    return validFilters.length > 0;
  } catch (error) {
    console.log('Error initializing filter engine:', error.message);
    return false;
  }
}

function handleStartupSettings() {
  const args = process.argv.slice(1);
  
  if (args.includes('--enable-startup')) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe')
    });
    console.log('Startup enabled');
  }
  
  if (args.includes('--disable-startup')) {
    app.setLoginItemSettings({
      openAtLogin: false
    });
    console.log('Startup disabled');
  }
  
  const loginItemSettings = app.getLoginItemSettings();
  console.log(`Startup status: ${loginItemSettings.openAtLogin ? 'Enabled' : 'Disabled'}`);
}

function createMenu() {
  const loginItemSettings = app.getLoginItemSettings();
  
  const template = [
    {
      label: t('settings'),
      submenu: [
        {
          label: t('start_with_windows'),
          type: 'checkbox',
          checked: loginItemSettings.openAtLogin,
          click: (menuItem) => {
            app.setLoginItemSettings({
              openAtLogin: menuItem.checked,
              path: app.getPath('exe')
            });
            console.log(`Startup ${menuItem.checked ? 'enabled' : 'disabled'}`);
          }
        },
        { type: 'separator' },
        {
          label: t('minimize_to_tray'),
          type: 'checkbox',
          checked: minimizeToTray,
          click: (menuItem) => {
            toggleTrayBehavior(menuItem.checked);
          }
        },
        // Show tray option only when enabled
        ...(minimizeToTray ? [{
          label: t('hide_to_tray'),
          accelerator: 'Ctrl+H',
          click: () => {
            mainWindow.hide();
          }
        }] : []),
        { type: 'separator' },
        {
          label: t('reopen_last_song'),
          type: 'checkbox',
          checked: openLastSong,
          click: (menuItem) => {
            toggleReOpenBehavior(menuItem.checked);
          }
        },
        ...(openLastSong ? [{
          label: t('resume_playback'),
          type: 'checkbox',
          checked: resumePlayback,
          click: (menuItem) => {
            toggleResumeBehavior(menuItem.checked);
          }
        }] : []),
        { type: 'separator' },
        {
          label: t('ad_filter_settings'),
          click: () => {
            createSettingsWindow();
          }
        },
        {
          label: t('update_ad_filters'),
          click: async () => {
            console.log('Manually updating filters...');
            const success = await initializeFilterEngine(true);
            console.log(success ? 'Filters updated!' : 'Filter update failed');
            
            console.log('Restarting...');
            app.relaunch();
            app.quit();
          }
        },
        { type: 'separator' },
        {
          label: t('quit'),
          accelerator: 'Ctrl+Q',
          click: () => {
            app.isQuiting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: t('help'),
      submenu: [
        {
          label: t('check_for_updates'),
          click: async () => {
            try {
              // Check for updates 
              const result = await autoUpdater.checkForUpdates();
              
              if (result && result.updateInfo && result.updateInfo.version !== APP_VERSION) {
                // Update available
                const updateResult = await dialog.showMessageBox(mainWindow, {
                  type: 'question',
                  title: t('update_available'),
                  message: `A new version (${result.updateInfo.version}) is available. Would you like to download it now?`,
                  buttons: ['Download Now', 'Not Now'],
                  defaultId: 0,
                  cancelId: 1
                });

                if (updateResult.response === 0) {
                  // show progress dialog
                  dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Downloading Update',
                    message: 'Downloading update in the background...',
                    buttons: ['OK']
                  });
                  
                  // Start download
                  autoUpdater.downloadUpdate();
                }
              } else {
                // No updates available
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: t('no_updates_available'),
                  message: t('no_updates_available_message'),
                  buttons: ['OK']
                });
              }
            } catch (error) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: t('update_error'),
                message: `Error checking for updates: ${error.message}`,
                buttons: ['OK']
              });
            }
          }
        },
        {
          label: t('about'),
          click: () => {
            createAboutWindow();
          }
        }
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setupWebRequestHandler() {
  // Define what to block
  const blockableResourceTypes = {
    script: true,
    stylesheet: false,
    image: true,
    font: false,
    xhr: true,
    fetch: true,
    websocket: false,
    media: false,
    object: true,
    ping: true,
    csp_report: true,
    preflight: false,
    navigation: false,
    sub_frame: true,
  };

  // Block requests based on filter engine
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!snfe) {
      return callback({});
    }
    
    const resourceType = details.resourceType;
    const shouldCheckFilters = blockableResourceTypes[resourceType];

    if (!shouldCheckFilters) {
      return callback({});
    }

    const resourceTypeMapping = {
      script: "script",
      stylesheet: "stylesheet",
      image: "image",
      font: "font",
      xhr: "xmlhttprequest",
      fetch: "fetch",
      websocket: "websocket",
      media: "media",
      object: "object",
      ping: "ping",
      csp_report: "csp_report",
      sub_frame: "sub_frame",
    };

    const uBlockType = resourceTypeMapping[resourceType] || "other";

    const shouldBlock = snfe.matchRequest({
      originURL: details.referrer || details.url,
      url: details.url,
      type: uBlockType,
    });

    if (shouldBlock !== 0) {
      console.log(`Blocked [${resourceType}]:`, details.url);
      return callback({ cancel: true });
    }

    callback({});
  });
}

async function createWindow() {
  await loadConfig();

  // Get system locale and load language
  const userLocale = app.getLocale().split('-')[0];
  await loadLanguage(userLocale);

  if (minimizeToTray) {
    createTray();
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
    },
  });

  // Enable F12 and Ctrl+Shift+i for DevTools - for Advanced Users
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || 
        (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  createMenu();

  // Load filters in background
  initializeFilterEngine().then((success) => {
    console.log(success ? 'Ad blocking active' : 'Ad blocking failed');
    if (success) {
      setupWebRequestHandler();
    }
  });

  // Handle close button based on tray setting
  mainWindow.on('close', async (event) => {
    if (!app.isQuiting && minimizeToTray) {
      // Hide to tray, keep music playing
      event.preventDefault();
      mainWindow.hide();
      console.log('App minimized to tray');
      
      if (tray && !mainWindow.trayNotificationShown) {
        tray.displayBalloon({
          iconType: 'info',
          title: 'YouTube Music',
          content: t('notify_tray')
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
          if (resumePlayback && currentUrl.includes('music.youtube.com/watch')) {
            
            // Execute script to get current time in seconds
            const currentTimeValue = await mainWindow.webContents.executeJavaScript(`
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
                urlObject.searchParams.set('t', timeInSeconds);
                currentUrl = urlObject.toString();
              } catch (e) {
                console.log('Error modifying URL with time parameter:', e.message);
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
        mainWindow.destroy();
        app.quit();
      } catch (error) {
        console.log('Error pausing audio:', error);
        mainWindow.destroy();
        app.quit();
      }
    }
  });

  const youtubeMusicDomain = 'music.youtube.com';

  // Logic to load URL
  let urlToLoad = lastUrl;
  
  if (urlToLoad.includes(youtubeMusicDomain)) {
    
    // If last song is enabled, but resume playback is disabled, ensure 't' is removed.
    if (openLastSong && !resumePlayback) {
      try {
        const urlObject = new URL(urlToLoad);
        urlObject.searchParams.delete('t');
        urlToLoad = urlObject.toString();
        console.log('Removed playback time from URL as setting is disabled.');
      } catch (e) {
        console.log('Error removing "t" parameter:', e.message);
        // Fallback to string manipulation if URL parsing fails
        urlToLoad = urlToLoad.replace(/([?&])t=\d+/g, '$1');
        if (urlToLoad.endsWith('?') || urlToLoad.endsWith('&')) {
          urlToLoad = urlToLoad.slice(0, -1);
        }
      }
    } else if (!openLastSong) {
        urlToLoad = `https://${youtubeMusicDomain}`;
    }
    
    mainWindow.loadURL(urlToLoad);
    console.log(`Loading URL: ${urlToLoad}`);
  } else {
    mainWindow.loadURL(`https://${youtubeMusicDomain}`);
    console.log('Loading default URL: https://music.youtube.com');
  }
  
  // Hide cast buttons
  mainWindow.webContents.once('did-finish-load', () => {
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

    // Inject JavaScript to auto-skip video ads
    if (videoAdSkipperEnabled) {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        console.log('Video ad skipper initialized (Speed: ${VideoAdSkipSpeed}x, Interval: ${VideoAdSkipInterval}ms)');
        
        // Function to skip video ads
        function skipVideoAd() {
          try {
            // Look for skip button (various selectors)
            const skipSelectors = [
              '.ytp-ad-skip-button',
              '.ytp-ad-skip-button-modern',
              '.ytp-skip-ad-button',
              '.ytp-ad-skip-button-container button',
              'button.ytp-ad-skip-button',
              '[class*="skip"][class*="button"]'
            ];
            
            for (const selector of skipSelectors) {
              const skipButton = document.querySelector(selector);
              if (skipButton) {
                // Check if button is clickable (not disabled and visible)
                const isClickable = !skipButton.disabled && 
                                   skipButton.offsetParent !== null &&
                                   !skipButton.hasAttribute('disabled');
                
                if (isClickable) {
                  skipButton.click();
                  console.log('lol - Skipped video ad');
                  return true;
                }
              }
            }
            
            // If skip button has countdown, try to fast-forward the video
            const video = document.querySelector('video');
            if (video) {
              const player = document.querySelector('.html5-video-player');
              
              // Check if ad is showing
              if (player && (player.classList.contains('ad-showing') || 
                            player.classList.contains('ad-interrupting'))) {
                
                // Fast-forward to near the end (leave 0.1s to trigger skip button)
                if (video.duration && video.duration > 0 && !isNaN(video.duration)) {
                  video.currentTime = Math.max(0, video.duration - 0.1);
                  video.playbackRate = ${VideoAdSkipSpeed}; // Speed up but not too fast
                  console.log('lol - Fast-forwarding through ad at (Speed=${VideoAdSkipSpeed}x)');
                  return true;
                }
              }
            }
          } catch (e) {
            // Silently fail
          }
          return false;
        }
        
        // Run skip check frequently
        setInterval(skipVideoAd, ${VideoAdSkipInterval});
        
        // Also run on various events
        document.addEventListener('DOMContentLoaded', skipVideoAd);
        window.addEventListener('load', skipVideoAd);
        
        // Watch for DOM changes (when ad elements appear)
        const observer = new MutationObserver(skipVideoAd);
        observer.observe(document.body, { 
          childList: true, 
          subtree: true 
        });
      })();
    `);
    }else{
      console.log('Video ad skipper disabled by user');
    }
    console.log('Cast buttons hidden');
  });
}

handleStartupSettings();


// Updater event handlers
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info);
});

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available:', info);
});

autoUpdater.on('error', (err) => {
  console.log('Error in auto-updater:', err);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: t('update_error'),
      message: `Error: ${err.message}`,
      buttons: ['OK']
    });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  console.log(log_message);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('update_ready'),
      message: t('update_ready_message'),
      buttons: [t('restart_now'), t('later')]
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  }
});

if (gotTheLock) {
  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
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
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
