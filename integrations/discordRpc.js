const rpc = require("@xhayper/discord-rpc");
const { getListenAlongState } = require("../listen-along/listenAlong");

const clientId = process.env.YTMP_DISCORD_CLIENT_ID || "1332344236015878314";
let client = null;
let presenceUpdateInterval = null;
let reconnectTimer = null;
let connecting = false;

function isClientAlive(c) {
  return !!c && (typeof c.isConnected === "boolean" ? c.isConnected : true);
}

function scheduleReconnect(delay = 10000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToDiscord();
  }, delay);
}

function teardownClient() {
  if (presenceUpdateInterval) {
    clearInterval(presenceUpdateInterval);
    presenceUpdateInterval = null;
  }
  const old = client;
  client = null;
  if (old) {
    try {
      old.removeAllListeners();
      old.on("error", () => {});
      Promise.resolve(old.destroy()).catch(() => {});
    } catch {}
  }
}

function handleDiscordDisconnect() {
  console.warn("Discord connection lost. Reconnecting in 10s...");
  teardownClient();
  scheduleReconnect();
}

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
  if (!isClientAlive(client)) return;

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
  Url = Url.replace(/:\/\/(www\.)?youtube\.com\//, "://music.youtube.com/");

  const buttons = [];

  if (isPlaying) {
    buttons.push({
      label: "Listen on YouTube Music",
      url: Url,
    });
  }

  // Show "Listen Along" if a party is active, otherwise show "Get App"
  const laState = getListenAlongState();
  if (laState.isActive && laState.partyId && laState.serverUrl && isPlaying) {
    buttons.push({
      label: "Listen Along",
      url: `${laState.serverUrl}/party/${laState.partyId}`,
    });
  } else {
    buttons.push({
      label: "Get App",
      url: "https://github.com/nubsuki/YouTube-Music-Player",
    });
  }

  const activity = {
    type: 2, // Listening to
    largeImageText: "YouTube Music",
    instance: false,
    buttons,
  };

  if (isPlaying) {
    activity.startTimestamp =
      Math.floor(Date.now() / 1000) - Math.floor(currentTime);
    if (Number.isFinite(duration) && duration > 0) {
      activity.endTimestamp = activity.startTimestamp + Math.floor(duration);
    }
  } else {
    activity.startTimestamp = appLaunchTimestamp;
  }

  const truncate = (str, len) =>
    str.length > len ? str.substring(0, len - 3) + "..." : str;

  if (isPlaying) {
    activity.details = truncate(Title, 128);
    activity.state = truncate(`by ${Artist}`, 128);
    const validArt =
      typeof albumArtUrl === "string" &&
      /^https:\/\//.test(albumArtUrl) &&
      albumArtUrl.length <= 256;
    activity.largeImageKey = validArt ? albumArtUrl : "icon";
  } else {
    activity.details = "YouTube Music by nubsuki";
    activity.largeImageKey = "icon";
  }

  if (client && client.user) {
    const active = client;
    active.user.setActivity(activity).catch((error) => {
      const msg = String((error && error.message) || error);
      if (
        /NOT_CONNECTED|Connection ended/i.test(msg) ||
        (error && error.code === 4)
      ) {
        if (client === active) handleDiscordDisconnect();
        return;
      }
      console.error("Error setting Discord activity:", msg);
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

    const {
      songTitle,
      artist,
      albumArtUrl,
      isPlaying,
      currentTime,
      duration,
      songUrl,
    } = await mainWindowRef.webContents.executeJavaScript(`
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

        let songUrl = '';
        const player = document.getElementById('movie_player');
        if (player && typeof player.getVideoUrl === 'function') {
          const vUrl = player.getVideoUrl();
          if (vUrl && vUrl.includes('v=')) songUrl = vUrl;
        }
        if (!songUrl && player && typeof player.getVideoData === 'function') {
          const vData = player.getVideoData();
          if (vData && vData.video_id) {
            songUrl = 'https://music.youtube.com/watch?v=' + vData.video_id;
          }
        }
        if (!songUrl) {
          const link = (titleElement && titleElement.querySelector('a')) ||
                       (imgElement && imgElement.closest('a')) ||
                       document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
          if (link && link.href && link.href.includes('v=')) {
            songUrl = link.href;
          }
        }
        if (!songUrl) {
          songUrl = window.location.href;
        }

        return { songTitle, artist: qartist, qartist, albumArtUrl, isPlaying, currentTime, duration, songUrl };
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

    let finalSongUrl = songUrl || mainWindowRef.webContents.getURL();
    if (typeof finalSongUrl !== "string" || finalSongUrl.length === 0) {
      finalSongUrl = "https://music.youtube.com";
    }
    if (finalSongUrl.length > 512) {
      finalSongUrl = "https://music.youtube.com";
    }

    return {
      songTitle: SongTitle,
      artist: Artist,
      songUrl: finalSongUrl,
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
  if (connecting) return;
  connecting = true;

  teardownClient();
  const thisClient = new rpc.Client({ clientId });
  client = thisClient;

  thisClient.on("ready", () => {
    if (client !== thisClient) return;
    console.log("Successfully connected to Discord!");

    setDiscordActivity();

    if (presenceUpdateInterval) clearInterval(presenceUpdateInterval);
    presenceUpdateInterval = setInterval(async () => {
      if (client !== thisClient) return;
      // Watchdog: catches a dead pipe even if no "disconnected" event arrived
      if (!isClientAlive(thisClient)) {
        handleDiscordDisconnect();
        return;
      }
      const info = await getCurrentSongInfo();
      if (client !== thisClient || !isClientAlive(thisClient)) return;
      setDiscordActivity(
        info.songTitle,
        info.artist,
        info.songUrl,
        info.albumArtUrl,
        info.isPlaying,
        info.currentTime,
        info.duration,
      );
    }, 12000);
  });

  thisClient.on("error", (error) => {
    if (client !== thisClient) return;
    console.error("Discord RPC Error:", error && error.message);
    handleDiscordDisconnect();
  });

  thisClient.on("disconnected", () => {
    if (client !== thisClient) return;
    handleDiscordDisconnect();
  });

  try {
    await thisClient.login();
  } catch (error) {
    console.error("Failed to connect to Discord:", error && error.message);
    if (client === thisClient) {
      teardownClient();
      scheduleReconnect();
    }
  } finally {
    connecting = false;
  }
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
