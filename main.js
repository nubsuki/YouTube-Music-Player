const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, Tray } = require("electron");
const rpc = require("discord-rpc");

let mainWindow;
let tray = null;
let minimizeToTray = true;
let appIsQuitting = false; // Initialize app quitting state
let presenceUpdateInterval; // Interval for updating Discord Rich Presence

// Read config.json with error handling
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json")));
} catch (error) {
  console.error("Error reading config.json:", error);
  process.exit(1); // Exit the app if config is not available
}
const clientId = config.clientId;


// Discord Rich Presence setup
rpc.register(clientId);
const client = new rpc.Client({ transport: "ipc" });

// Function to set Discord Rich Presence activity
function setDiscordActivity(songTitle = "Loading Song", artist = "Loading Artist") {
  if (!client) return;

  client
    .setActivity({
      details: `Listening to ${songTitle}`,
      state: `by ${artist}`,
      largeImageKey: "icon",
      largeImageText: "YouTube Music",
      instance: false,
    })
    .catch((error) => {
      console.error("Error setting Discord activity:", error);
    });
}

// Fetch song info from YouTube Music
async function getCurrentSongInfo() {
  try {
    const songTitle = await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.title.ytmusic-player-bar')?.textContent.trim() || 'Loading Song'`
    );
    const artist = await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.byline.ytmusic-player-bar')?.textContent.trim() || 'Loading Artist'`
    );
    return { songTitle, artist };
  } catch (error) {
    console.error("Error fetching song info:", error);
    return { songTitle: "Loading Song", artist: "Loading Artist" };
  }
}

// Request a single instance lock
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      } else if (mainWindow.isMinimized()) {
        mainWindow.restore();
      } else {
        mainWindow.focus();
      }
    }
  });

  app.on("ready", () => {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        nodeIntegration: false, // Disable nodeIntegration for security
        contextIsolation: true, // Enable context isolation
        partition: "persist:youtube-music-data",
      },
      title: "YouTube Music",
      backgroundColor: "#000000",
      icon: path.join(
        __dirname,
        "assets",
        process.platform === "win32" ? "icon.ico" : "icon.icns"
      ),
    });

    mainWindow.loadURL("https://music.youtube.com");

    // Minimize to tray on close
    mainWindow.on("close", (event) => {
      if (minimizeToTray && !appIsQuitting) {
        event.preventDefault();
        mainWindow.hide();
        if (!tray) {
          const iconPath = path.join(__dirname, "assets", "icon.png");
          if (fs.existsSync(iconPath)) {
            tray = new Tray(iconPath);
            tray.setToolTip("YouTube Music");

            const contextMenu = Menu.buildFromTemplate([
              {
                label: "Show",
                click: () => {
                  mainWindow.show();
                },
              },
              {
                label: "Exit",
                click: () => {
                  appIsQuitting = true;
                  app.quit();
                },
              },
            ]);

            tray.on("click", () => {
              mainWindow.show();
            });

            tray.setContextMenu(contextMenu);
          } else {
            console.error("Tray icon not found at path:", iconPath);
          }
        }
      }
      return false;
    });

    // Custom menu
    const menu = Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { role: "reload" },
          {
            label: "Quit",
            accelerator: process.platform === "darwin" ? "Command+Q" : "Alt+F4",
            click: () => {
              appIsQuitting = true;
              app.exit();
            },
          },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "togglefullscreen" },
          {
            label: "Minimize to Tray on Close",
            type: "checkbox",
            checked: minimizeToTray,
            click: (menuItem) => {
              minimizeToTray = menuItem.checked;
            },
          },
        ],
      },
      {
        label: "About",
        click: () => {
          const { shell } = require("electron");
          shell.openExternal("https://github.com/nubsuki/YouTube-Music-Player");
        },
      },
    ]);
    Menu.setApplicationMenu(menu);

    // Discord Rich Presence integration
    client.on("ready", () => {
      console.log("Discord Rich Presence is active!");
      setDiscordActivity();
    });

    client.on("error", (error) => {
      console.error("Discord RPC Error:", error);
    });

    client.login({ clientId }).catch(console.error);

    // Periodically update Rich Presence
    presenceUpdateInterval = setInterval(async () => {
      const { songTitle, artist } = await getCurrentSongInfo();
      setDiscordActivity(songTitle, artist);
    }, 15000); // Update every 15 seconds
  });

  app.on("before-quit", async () => {
    appIsQuitting = true;
    clearInterval(presenceUpdateInterval); // Clear the interval
    if (tray) {
      tray.destroy(); // Destroy the tray icon
    }
  
    // Pause music before quitting
    try {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('video').pause()`
      );
    } catch (error) {
      console.error("Error pausing music:", error);
    }
  });
}