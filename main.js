const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, Tray } = require("electron");
const rpc = require("discord-rpc");

let mainWindow;
let tray = null;
let minimizeToTray = true;
let appIsQuitting = false; // Initialize app quitting state

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

let isConnected = false;
let presenceUpdateInterval; // Interval for updating Discord Rich Presence

// Function to set Discord Rich Presence activity
function setDiscordActivity(songTitle = "Loading Song", artist = "Loading Artist", songUrl = "", albumArtUrl = "") {
  if (!client) return;

  client
    .setActivity({
      details: `${songTitle}`,
      state: `by ${artist}`,
      largeImageKey: albumArtUrl || "icon",
      largeImageText: "YouTube Music",
      instance: false,
      buttons: [
        {
          label: "Listen on YouTube Music",
          url: songUrl || "https://music.youtube.com",
        },
        {
          label: "Get App",
          url: "https://github.com/nubsuki/YouTube-Music-Player",
        },
      ],
    })
    .catch((error) => {
      console.error("Error setting Discord activity:", error);
    });
}

// Fetch song info from YouTube Music
async function getCurrentSongInfo() {
  try {
    // Fetch song title and artist
    const songTitle = await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.title.ytmusic-player-bar')?.textContent.trim() || 'Loading Song'`
    );
    const artist = await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.byline.ytmusic-player-bar')?.textContent.trim() || 'Loading Artist'`
    );

    const qartist = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const byline = document.querySelector('.byline.ytmusic-player-bar')?.textContent.trim();
        if (!byline) return 'Loading Artist';
        // Split the text by '•' and take the first part
        return byline.split('•')[0].trim() || 'Loading Artist';
      })();
    `);
    
    // Construct the search query URL
    const query = encodeURIComponent(`${songTitle} by ${qartist}`);
    const songUrl = `https://music.youtube.com/search?q=${query}`;

    // Fetch the album art URL
    const albumArtUrl = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const imgElement = document.querySelector('.image.style-scope.ytmusic-player-bar');
        return imgElement ? imgElement.src : '';
      })();
    `);

    return { songTitle, artist, songUrl, albumArtUrl};
  } catch (error) {
    console.error("Error fetching song info:", error);
    return { songTitle: "Loading Song", artist: "Loading Artist",  albumArtUrl: "" };
  }
}

// Connect to Discord
async function connectToDiscord() {
  try {
    await client.login({ clientId });
    console.log("Successfully connected to Discord!");
    isConnected = true;

    // Set initial activity
    setDiscordActivity();

    // Periodically update Rich Presence
    presenceUpdateInterval = setInterval(async () => {
      const { songTitle, artist, songUrl, albumArtUrl } = await getCurrentSongInfo();
      setDiscordActivity(songTitle, artist, songUrl, albumArtUrl);
    }, 12000); // Update every 12 seconds
  } catch (error) {
    console.error("Failed to connect to Discord:", error.message);

    // Retry connection after 10 seconds
    if (!isConnected) {
      setTimeout(connectToDiscord, 10000);
    }
  }
}

client.on("error", (error) => {
  console.error("Discord RPC Error:", error);
});

// Handle disconnections
client.on("disconnected", () => {
  console.warn("Disconnected from Discord. Attempting to reconnect...");
  isConnected = false;
  setTimeout(waitForDiscord, 5000);
});

// Dynamically import ps-list
let psList;
const loadPsList = async () => {
  psList = await import("ps-list");
};


// Check if Discord is running
async function isDiscordRunning() {
  const processes = await psList.default(); 
  return processes.some((process) => process.name.toLowerCase().includes("discord"));
}

// Wait for Discord to start
async function waitForDiscord() {
  if (!psList) {
    await loadPsList(); // Ensure psList is loaded
  }

  // Wait for Discord to start
  while (!(await isDiscordRunning())) {
    console.log("Waiting for Discord to start...");
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Check every 5 seconds
  }

  // Wait for 30 seconds before attempting to connect
  console.log("Discord detected! Waiting 30 seconds before connecting...");
  await new Promise((resolve) => setTimeout(resolve, 30000));

  console.log("Attempting to connect to Discord...");
  connectToDiscord(); // Attempt to connect after the delay
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
      }else {
        // If minimizeToTray is false, allow the app to quit
        appIsQuitting = true;
        app.quit();
      }return false;
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
            checked: true,
            enabled: false,
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

    // Start monitoring for Discord
    waitForDiscord();
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