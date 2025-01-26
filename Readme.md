# YouTube Music Desktop App

A simple desktop application for **YouTube Music**.

---
**YouTube Music Player**
![YTMusic](assets/ytmp.png)
**Discord Rich Presence**
![Rich Presence](assets/status.png)

---

## Features

- **Desktop YouTube Music**: A dedicated YouTube Music app with no distractions.
- **Minimize to Tray**: Close the app window to minimize it to the system tray.
- **Dicord Rich Presence**: Sets Discord Profile status to current song that plays.
---

## Get Started

### How to Use:

1. **Download the ZIP**:
   - Go to the [Releases](https://github.com/nubsuki/YouTube-Music-Player/releases) page and download the latest version of the app (ZIP file).

2. **Unzip the File**:
   - Extract the contents of the ZIP file to a folder of your choice.

3. **Run the App**:
   - Open the folder and double-click on `youtube-music-app.exe` to launch the app.

4. **Create a Desktop Icon** (Optional but Recommended):
   - To easily access the app, create a shortcut on your desktop:
     - **Right-click** on `youtube-music-app.exe` in the folder.
     - Select **Send to > Desktop (create shortcut)**.
     - Now you can quickly launch the app directly from your desktop.

That's it! 🎉 Enjoy your YouTube Music experience on the desktop.

---

## Discord Rich Presence

If you want **Discord Rich Presence**, you have to create an application on the [Discord Developer Portal](https://discord.com/developers/applications):

1. Go to the Discord Developer Portal and create a new application.
2. Give your application a name, then go to **Rich Presence**.
3. Add an image (icon.png or icon.gif), either a PNG or GIF. You can find the given image in `YouTube Muisc App/resources/app/assets` (it should be a PNG).
4. Go to **OAuth2**, copy the **Client ID**, and paste it into `config.json` in `YouTube Muisc App/resources/app`.

For example:

```json
{
    "clientId": "1232432411312314"
}
```

That’s it!

---

## Known Issues

- **Pause Music Before Closing**: If you don't pause the music before quitting the app, it may continue playing in the background. To avoid this, make sure to pause your music before exiting the app.

---

## License
This project is for personal use and is distributed "as-is".

---