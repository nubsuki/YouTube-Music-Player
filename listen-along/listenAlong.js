const { io } = require("socket.io-client");

const DEFAULT_SERVER_URL = "https://ytms.nubsuki.xyz";

let socket = null;
let currentParty = null;
let currentMembers = [];
let lastSongState = null;
let broadcastInterval = null;
let mainWindowRef = null;
let onStateChangeCb = null;
let lastNavigatedVideoId = null;

// Public state
function getListenAlongState() {
  if (!currentParty) {
    return {
      isActive: false,
      role: null,
      isHost: false,
      isGuest: false,
      partyId: null,
      serverUrl: null,
      hostName: null,
      members: [],
      songState: null,
    };
  }

  return {
    isActive: true,
    role: currentParty.role,
    isHost: currentParty.role === "host",
    isGuest: currentParty.role === "guest",
    partyId: currentParty.id,
    serverUrl: currentParty.serverUrl,
    hostName: currentParty.hostName || null,
    members: currentMembers,
    songState: lastSongState,
  };
}

// Song state polling
async function getSongState() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return null;
  try {
    return await mainWindowRef.webContents.executeJavaScript(`
      (() => {
        const titleEl  = document.querySelector('.title.ytmusic-player-bar');
        const bylineEl = document.querySelector('.byline.ytmusic-player-bar');
        const imgEl    = document.querySelector('.image.style-scope.ytmusic-player-bar');
        const audio    = document.querySelector('audio');
        const video    = document.querySelector('video');
        const media    = (audio && !audio.paused && audio.currentTime > 0) ? audio
                       : (video && !video.paused && video.currentTime > 0) ? video : null;
        return {
          song:        titleEl  ? titleEl.textContent.trim()               : '',
          artist:      bylineEl ? bylineEl.textContent.trim().split('•')[0].trim() : '',
          url:         window.location.href,
          isPlaying:   !!media,
          currentTime: media ? media.currentTime  : 0,
          duration:    media ? (media.duration || 0) : 0,
          thumbnail:   imgEl  ? imgEl.src          : '',
        };
      })()
    `);
  } catch {
    return null;
  }
}

// Broadcast loop
function startBroadcast() {
  if (broadcastInterval) clearInterval(broadcastInterval);
  broadcastInterval = setInterval(async () => {
    if (
      !socket ||
      !currentParty ||
      currentParty.role !== "host" ||
      !socket.connected
    )
      return;
    const state = await getSongState();
    if (!state) return;
    lastSongState = state;
    socket.emit("party:state-update", {
      partyId: currentParty.id,
      hostToken: currentParty.hostToken,
      state,
    });
    notifyStateChange();
  }, 3000);
}

// Validate a URL is on YouTube Music
function isSafeYtMusicUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      /^(music\.youtube\.com|www\.youtube\.com)$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

// Validate thumbnail is from a trusted YouTube CDN
function isSafeThumbnail(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      /^(lh3\.googleusercontent\.com|i\.ytimg\.com|yt3\.ggpht\.com)$/.test(
        parsed.hostname,
      )
    );
  } catch {
    return false;
  }
}

// Playback sync
function extractVideoId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v");
  } catch {
    const match = url.match(/[?&]v=([^&#]+)/);
    return match ? match[1] : null;
  }
}

async function syncPlayback(state) {
  if (!mainWindowRef || mainWindowRef.isDestroyed() || !state) return;

  // Only navigate to verified YouTube Music URLs
  const safeUrl = isSafeYtMusicUrl(state.url) ? state.url : null;
  const hostVideoId = safeUrl ? extractVideoId(safeUrl) : null;

  try {
    const currentUrl = mainWindowRef.webContents.getURL();
    const guestVideoId = extractVideoId(currentUrl);

    // If host has changed tracks and guest is not yet on it, navigate
    if (
      hostVideoId &&
      hostVideoId !== guestVideoId &&
      hostVideoId !== lastNavigatedVideoId
    ) {
      lastNavigatedVideoId = hostVideoId;
      console.log(`[ListenAlong] Guest syncing track: ${safeUrl}`);
      await mainWindowRef.loadURL(safeUrl);
      return;
    }

    // Sync play/pause state and seek position if drift > 3 seconds
    const script = `
      (() => {
        try {
          const audio = document.querySelector('audio');
          const video = document.querySelector('video');
          const media = (audio && audio.duration) ? audio : video;
          if (!media) return;

          const shouldPlay = ${Boolean(state.isPlaying)};
          const targetTime = ${Number(state.currentTime) || 0};

          if (shouldPlay && media.paused) {
            media.play().catch(() => {});
          } else if (!shouldPlay && !media.paused) {
            media.pause();
          }

          if (Number.isFinite(targetTime) && Math.abs(media.currentTime - targetTime) > 3) {
            media.currentTime = targetTime;
          }
        } catch (e) {}
      })()
    `;
    await mainWindowRef.webContents.executeJavaScript(script).catch(() => {});
  } catch (err) {
    console.error("[ListenAlong] Sync playback error:", err.message);
  }
}

// Host party lifecycle
async function createParty(serverUrl, hostName) {
  if (currentParty) await resetParty();

  const cleanUrl = (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, "");
  const res = await fetch(`${cleanUrl}/api/party/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostName: hostName || "Host" }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `Server error ${res.status}`);
  }

  const { partyId, hostToken } = await res.json();
  currentParty = {
    role: "host",
    id: partyId,
    hostToken,
    hostName: hostName || "Host",
    serverUrl: cleanUrl,
  };
  currentMembers = [];

  socket = io(cleanUrl, { transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    console.log("[ListenAlong] Socket connected, registering as host");
    socket.emit("party:host-connect", { partyId, hostToken });
  });

  socket.on("party:host-ready", () => {
    console.log(`[ListenAlong] Party ${partyId} active (Host)`);
    startBroadcast();
    notifyStateChange();
  });

  socket.on("party:member-joined", ({ members }) => {
    currentMembers = members || [];
    notifyStateChange();
  });

  socket.on("party:member-left", ({ members }) => {
    currentMembers = members || [];
    notifyStateChange();
  });

  socket.on("party:error", ({ message }) => {
    console.error("[ListenAlong] Server error:", message);
  });

  socket.on("disconnect", () => {
    console.warn("[ListenAlong] Socket disconnected");
  });

  return partyId;
}

async function closeParty() {
  if (!currentParty) return;

  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }

  const { id, hostToken, serverUrl } = currentParty;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  if (hostToken) {
    try {
      await fetch(`${serverUrl}/api/party/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostToken }),
      });
    } catch (e) {
      console.error("[ListenAlong] Error deleting party:", e.message);
    }
  }

  currentParty = null;
  currentMembers = [];
  lastSongState = null;
  lastNavigatedVideoId = null;
  notifyStateChange();
}

// Guest party lifecycle
async function joinParty(serverUrl, partyId, guestName) {
  if (currentParty) await resetParty();

  const cleanUrl = (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, "");
  const cleanPartyId = (partyId || "").trim().toUpperCase();
  const cleanName = (guestName || "Listener").trim().slice(0, 24) || "Listener";

  if (!cleanPartyId) throw new Error("Party code is required");

  return new Promise((resolve, reject) => {
    let settled = false;

    socket = io(cleanUrl, {
      transports: ["websocket", "polling"],
      timeout: 8000,
    });

    socket.on("connect", () => {
      console.log(
        `[ListenAlong] Socket connected, joining party ${cleanPartyId} as "${cleanName}"`,
      );
      socket.emit("party:join", {
        partyId: cleanPartyId,
        displayName: cleanName,
      });
    });

    socket.on("party:joined", ({ partyId: pid, hostName, state, members }) => {
      if (settled) return;
      settled = true;

      currentParty = {
        role: "guest",
        id: pid,
        hostName: hostName || "Friend",
        guestName: cleanName,
        serverUrl: cleanUrl,
      };
      currentMembers = members || [];
      lastSongState = state || null;

      if (state) syncPlayback(state);
      notifyStateChange();
      resolve({ partyId: pid, hostName });
    });

    socket.on("party:sync", (state) => {
      lastSongState = state;
      if (state.members) currentMembers = state.members;
      syncPlayback(state);
      notifyStateChange();
    });

    socket.on("party:member-joined", ({ members }) => {
      currentMembers = members || [];
      notifyStateChange();
    });

    socket.on("party:member-left", ({ members }) => {
      currentMembers = members || [];
      notifyStateChange();
    });

    socket.on("party:closed", () => {
      leaveParty();
    });

    socket.on("party:error", ({ message }) => {
      if (!settled) {
        settled = true;
        if (socket) {
          socket.disconnect();
          socket = null;
        }
        reject(new Error(message || "Failed to join party"));
      }
    });

    socket.on("connect_error", () => {
      if (!settled) {
        settled = true;
        if (socket) {
          socket.disconnect();
          socket = null;
        }
        reject(new Error("Could not connect to sync server."));
      }
    });
  });
}

async function leaveParty() {
  if (!currentParty) return;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentParty = null;
  currentMembers = [];
  lastSongState = null;
  lastNavigatedVideoId = null;
  notifyStateChange();
}

async function resetParty() {
  if (currentParty && currentParty.role === "host") {
    await closeParty();
  } else {
    await leaveParty();
  }
}

function notifyStateChange() {
  if (typeof onStateChangeCb === "function") {
    onStateChangeCb(getListenAlongState());
  }
}

// Init
function initListenAlong(mainWindow, onStateChange) {
  mainWindowRef = mainWindow;
  onStateChangeCb = onStateChange;
}

module.exports = {
  DEFAULT_SERVER_URL,
  initListenAlong,
  createParty,
  closeParty,
  joinParty,
  leaveParty,
  getListenAlongState,
};
