const rpc = require("@xhayper/discord-rpc");

const clientId = process.env.YTMP_DISCORD_CLIENT_ID || "1332344236015878314";
let client = null;
let isConnected = false;
let presenceUpdateInterval;
let mainWindowRef = null;
const appLaunchTimestamp = Math.floor(Date.now() / 1000);

// Set discord activity status
function setDiscordActivity(
  songTitle = "Loading Song",
  artist = "Loading Artist",
  songUrl = "",
  albumArtUrl = "",
  isPlaying = false,
  currentTime = 0,
  duration = 0,
) {
  if (!client || !isConnected) return;

  const Title =
    songTitle && songTitle.toString().trim().length > 0
      ? songTitle.toString().trim()
      : "Loading Song";
  const Artist =
    artist && artist.toString().trim().length > 0
      ? artist.toString().trim()
      : "Loading Artist";
  let Url = typeof songUrl === "string" ? songUrl.trim() : "";
  if (!Url || Url.length > 512) {
    Url = "https://music.youtube.com";
  }

  const buttons = [];

  if (isPlaying) {
    buttons.push({
      label: "Listen on YouTube Music",
      url: Url,
    });
  }

  buttons.push({
    label: "Get App",
    url: "https://github.com/nubsuki/YouTube-Music-Player",
  });

  const activity = {
    type: 2, // Listening to
    largeImageText: "YouTube Music",
    instance: false,
    buttons,
  };

  if (isPlaying) {
    activity.startTimestamp =
      Math.floor(Date.now() / 1000) - Math.floor(currentTime);
    if (duration > 0 && !isNaN(duration)) {
      activity.endTimestamp = activity.startTimestamp + Math.floor(duration);
    }
  } else {
    activity.startTimestamp = appLaunchTimestamp;
  }

  if (isPlaying) {
    activity.details = Title;
    activity.state = `by ${Artist}`;
    activity.largeImageKey = albumArtUrl || "icon";
  } else {
    activity.details = "YouTube Music by nubsuki";
    activity.largeImageKey = "icon";
  }

  if (client.user) {
    client.user.setActivity(activity).catch((error) => {
      console.error("Error setting Discord activity:", error);
    });
  }
}

async function getCurrentSongInfo() {
  try {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) {
      return {
        songTitle: "Loading Song",
        artist: "Loading Artist",
        songUrl: "",
        albumArtUrl: "",
      };
    }

    const { songTitle, artist, albumArtUrl, isPlaying, currentTime, duration } =
      await mainWindowRef.webContents.executeJavaScript(`
      (() => {
        const titleElement = document.querySelector('.title.ytmusic-player-bar');
        const bylineElement = document.querySelector('.byline.ytmusic-player-bar');
        const imgElement = document.querySelector('.image.style-scope.ytmusic-player-bar');
        const audioElement = document.querySelector('audio');
        const videoElement = document.querySelector('video');

        const rawTitle = titleElement ? titleElement.textContent.trim() : '';
        const rawArtist = bylineElement ? bylineElement.textContent.trim() : '';

        const songTitle = rawTitle || 'Loading Song';
        const artist = rawArtist || 'Loading Artist';

        let qartist = 'Loading Artist';
        if (bylineElement) {
          const byline = bylineElement.textContent.trim();
          if (byline) {
            const parts = byline.split('•');
            qartist = (parts[0] || '').trim() || 'Loading Artist';
          }
        }

        const albumArtUrl = imgElement ? imgElement.src : '';

        let isPlaying = false;
        let currentTime = 0;
        let duration = 0;

        if (audioElement && !audioElement.paused && !audioElement.ended && audioElement.currentTime > 0) {
          isPlaying = true;
          currentTime = audioElement.currentTime;
          duration = audioElement.duration;
        } else if (videoElement && !videoElement.paused && !videoElement.ended && videoElement.currentTime > 0) {
          isPlaying = true;
          currentTime = videoElement.currentTime;
          duration = videoElement.duration;
        }

        return { songTitle, artist, qartist, albumArtUrl, isPlaying, currentTime, duration };
      })();
    `);
    const SongTitle =
      songTitle && songTitle.toString().trim().length > 0
        ? songTitle.toString().trim()
        : "Loading Song";
    const Artist =
      artist && artist.toString().trim().length > 0
        ? artist.toString().trim()
        : "Loading Artist";

    let songUrl = mainWindowRef.webContents.getURL();
    if (typeof songUrl !== "string" || songUrl.length === 0) {
      songUrl = "https://music.youtube.com";
    }
    if (songUrl.length > 512) {
      songUrl = "https://music.youtube.com";
    }

    return {
      songTitle: SongTitle,
      artist: Artist,
      songUrl,
      albumArtUrl,
      isPlaying,
      currentTime,
      duration,
    };
  } catch (error) {
    console.error("Error fetching song info:", error);
    return {
      songTitle: "Loading Song",
      artist: "Loading Artist",
      songUrl: "",
      albumArtUrl: "",
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    };
  }
}

async function connectToDiscord() {
  try {
    if (client) {
      try {
        await client.destroy();
        console.log("Destroyed old Discord client session.");
      } catch (error) {
        console.warn(
          "Error destroying old client (might already be destroyed):",
          error.message,
        );
      }
    }

    client = new rpc.Client({ clientId });

    client.on("ready", () => {
      console.log("Successfully connected to Discord!");
      isConnected = true;

      setDiscordActivity();

      presenceUpdateInterval = setInterval(async () => {
        const {
          songTitle,
          artist,
          songUrl,
          albumArtUrl,
          isPlaying,
          currentTime,
          duration,
        } = await getCurrentSongInfo();
        setDiscordActivity(
          songTitle,
          artist,
          songUrl,
          albumArtUrl,
          isPlaying,
          currentTime,
          duration,
        );
      }, 12000);
    });

    client.on("error", (error) => {
      console.error("Discord RPC Error:", error.message);
      handleDiscordDisconnect();
    });

    client.on("disconnected", () => {
      console.warn("Disconnected from Discord. Attempting to reconnect...");
      handleDiscordDisconnect();
    });

    await client.login();
  } catch (error) {
    console.error("Failed to connect to Discord:", error.message);

    if (!isConnected) {
      setTimeout(connectToDiscord, 10000);
    }
  }
}

function handleDiscordDisconnect() {
  isConnected = false;

  if (presenceUpdateInterval) {
    clearInterval(presenceUpdateInterval);
    presenceUpdateInterval = null;
  }

  if (client) {
    if (client.user) {
      client.user
        .clearActivity()
        .catch((error) =>
          console.error("Error clearing activity:", error.message),
        );
    }
    client
      .destroy()
      .catch((error) =>
        console.error("Error destroying client:", error.message),
      );
  }

  client = null;
  setTimeout(connectToDiscord, 10000);
}

function initDiscordRpc(mainWindow) {
  if (!clientId) {
    console.warn("Discord RPC disabled: YTMP_DISCORD_CLIENT_ID is not set.");
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn("Discord RPC initialization skipped: invalid BrowserWindow.");
    return;
  }

  mainWindowRef = mainWindow;
  connectToDiscord();
}

module.exports = {
  initDiscordRpc,
};
