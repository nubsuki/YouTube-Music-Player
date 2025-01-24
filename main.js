const { app, BrowserWindow, Menu, Tray } = require("electron");
const path = require("path");

let mainWindow;
let tray = null;
let minimizeToTray = true; // Default behavior

// Request a single instance lock
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit(); // Quit if another instance is already running
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Focus the main window if it is already open
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      
      mainWindow.focus();
    }
  });

  app.on("ready", () => {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        nodeIntegration: true,
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

    mainWindow.loadURL("https://music.youtube.com"); // Load YouTube Music

    // Update the close event handler to create tray icon
    mainWindow.on("close", function (event) {
      if (minimizeToTray && !app.isQuitting) {
        event.preventDefault();
        mainWindow.hide();

        // Create tray icon if it doesn't exist
        if (!tray) {
          const iconPath = path.join(__dirname, "assets", "icon.png");
          tray = new Tray(iconPath);
          tray.setToolTip("YouTube Music");

          // Create context menu for tray icon
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
                app.isQuitting = true;
                app.quit();
              },
            },
          ]);

          // Add click handler for left click
          tray.on("click", () => {
            mainWindow.show();
          });

          // Set the context menu
          tray.setContextMenu(contextMenu);
        }
      }
      return false;
    });

    // Create custom menu
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  });

  // Custom menu template
  const template = [
    {
      label: "File",
      submenu: [
        { role: "reload" },
        {
          label: "Quit",
          accelerator: process.platform === "darwin" ? "Command+Q" : "Alt+F4",
          click: () => app.quit(),
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
        const { shell } = require('electron');
        shell.openExternal('https://github.com/nubsuki/YouTube-Music-Player'); // Replace with your GitHub repository URL
      },
    },
  ];

  // Ready event
  app.on("before-quit", function () {
    app.isQuitting = true;
  });
}
