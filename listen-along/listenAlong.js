const { io } = require("socket.io-client");
const { Notification } = require("electron");

const DEFAULT_SERVER_URL = "https://ytms.nubsuki.xyz";

let socket = null;
let currentParty = null;
let currentMembers = [];
let lastSongState = null;
let broadcastInterval = null;
let mainWindowRef = null;
let onStateChangeCb = null;
let lastNavigatedVideoId = null;
let autoHostEnabled = false;
let autoHostName = "";
let isConnecting = false;
let isNavigating = false;
let lastNavAttemptAt = 0;
let navTargetId = null;
let navAttempts = 0;

// Clock sync state
let clockOffset = 0;
let clockSyncDone = false;

// Sync tuning
const SYNC_BROADCAST_INTERVAL = 2000;
const SYNC_SCHEDULE_BUFFER = 300;
const DRIFT_HARD_THRESHOLD = 2.0;
const DRIFT_SOFT_THRESHOLD = 0.5;
const DRIFT_IGNORE_THRESHOLD = 0.1;

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

// Clock sync
function syncClock(sock) {
  return new Promise((resolve) => {
    const SAMPLES = 5;
    const offsets = [];
    let sent = 0;

    const doSample = () => {
      const t1 = Date.now();
      sock.emit("clock:ping", { t1 }, (response) => {
        const t3 = Date.now();
        if (!response || !response.t2) return resolve(0);

        const { t2 } = response;
        const rtt = t3 - t1;
        const offset = t2 - t1 - rtt / 2;
        offsets.push(offset);
        sent++;

        if (sent < SAMPLES) {
          setTimeout(doSample, 50);
        } else {
          // trim outliers, average the rest
          offsets.sort((a, b) => a - b);
          const trimmed = offsets.slice(1, -1);
          const avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
          clockOffset = Math.round(avg);
          clockSyncDone = true;
          console.log(`[ListenAlong] Clock synced. Offset: ${clockOffset}ms`);
          resolve(clockOffset);
        }
      });
    };

    doSample();
  });
}

// Get current server time based on our measured offset
function serverNow() {
  return Date.now() + clockOffset;
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
        const media    = (audio && audio.duration) ? audio : (video && video.duration) ? video : (audio || video);
        const isPlaying = media ? (!media.paused && media.currentTime > 0 && !media.ended) : false;
        const currentTime = media ? (media.currentTime || 0) : 0;
        const duration = media ? (media.duration || 0) : 0;

        // Extract true video URL even if host is browsing Home, Search, or Playlists
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
          const link = (titleEl && titleEl.querySelector('a')) ||
                       (imgEl && imgEl.closest('a')) ||
                       document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
          if (link && link.href && link.href.includes('v=')) {
            songUrl = link.href;
          }
        }
        if (!songUrl) {
          songUrl = window.location.href;
        }

        return {
          song:        titleEl  ? titleEl.textContent.trim()               : '',
          artist:      bylineEl ? bylineEl.textContent.trim().split('•')[0].trim() : '',
          url:         songUrl,
          isPlaying,
          currentTime,
          duration,
          thumbnail:   imgEl  ? imgEl.src          : '',
        };
      })()
    `);
  } catch {
    return null;
  }
}

// Host sends state with server timestamp for scheduled sync
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
      state: {
        ...state,
        serverTimestamp: serverNow(),
      },
    });
    notifyStateChange();
  }, SYNC_BROADCAST_INTERVAL);
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

// Guest controls lock (gray out pause/skip/seek; volume stays usable)
async function setGuestLock(locked) {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  const script = locked
    ? `
    (() => {
      if (!document.getElementById('la-lock-style')) {
        const st = document.createElement('style');
        st.id = 'la-lock-style';
        st.textContent = \`
          ytmusic-player-bar .previous-button,
          ytmusic-player-bar .play-pause-button,
          ytmusic-player-bar .next-button,
          ytmusic-player-bar #progress-bar,
          ytmusic-player-bar .repeat,
          ytmusic-player-bar .shuffle {
            pointer-events: none !important;
            opacity: 0.35 !important;
            filter: grayscale(1);
          }\`;
        document.head.appendChild(st);
      }
      if (!window.__laKeyBlock) {
        const blocked = [' ', 'k', 'K', 'j', 'J', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause'];
        window.__laKeyBlock = (e) => {
          const t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          const isTrackKey = e.shiftKey && (e.key === 'N' || e.key === 'P');
          if (blocked.includes(e.key) || isTrackKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        };
        window.addEventListener('keydown', window.__laKeyBlock, true);
      }
    })()`
    : `
    (() => {
      const st = document.getElementById('la-lock-style');
      if (st) st.remove();
      if (window.__laKeyBlock) {
        window.removeEventListener('keydown', window.__laKeyBlock, true);
        window.__laKeyBlock = null;
      }
    })()`;
  try {
    await mainWindowRef.webContents.executeJavaScript(script);
  } catch {}
}

// Read the video ID the guest's real player is on
async function getGuestPlayerVideoId() {
  try {
    return await mainWindowRef.webContents.executeJavaScript(`
      (() => {
        const p = document.getElementById('movie_player');
        return p && p.getVideoData ? (p.getVideoData().video_id || null) : null;
      })()
    `);
  } catch {
    return null;
  }
}

async function waitForTrack(id, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 400));
    if ((await getGuestPlayerVideoId()) === id) return true;
  }
  return false;
}

// In-app navigation methods
const NAV_METHODS = ["navigate", "yt-navigate"];
const navStats = {
  navigate: { fails: 0, worked: false },
  "yt-navigate": { fails: 0, worked: false },
};

function usableNavMethods() {
  const list = NAV_METHODS.filter(
    (m) => navStats[m].worked || navStats[m].fails < 2,
  );
  return list.sort(
    (x, y) => Number(navStats[y].worked) - Number(navStats[x].worked),
  );
}

async function fireInPageNav(id, method) {
  return mainWindowRef.webContents
    .executeJavaScript(
      `
      (() => {
        const id = ${JSON.stringify(id)};
        const method = ${JSON.stringify(method)};
        const app = document.querySelector('ytmusic-app');
        if (!app) return { fired: false };
        // Full endpoint, the way YT Music's own links carry it
        const endpoint = {
          clickTrackingParams: '',
          commandMetadata: {
            webCommandMetadata: {
              url: '/watch?v=' + id,
              webPageType: 'MUSIC_PAGE_TYPE_UNKNOWN',
              rootVe: 0,
            },
          },
          watchEndpoint: {
            videoId: id,
            watchEndpointMusicSupportedConfigs: {
              watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
            },
          },
        };
        try {
          if (method === 'navigate' && typeof app.navigate === 'function') {
            app.navigate(endpoint);
            return { fired: true };
          }
          if (method === 'yt-navigate') {
            app.dispatchEvent(new CustomEvent('yt-navigate', {
              detail: { endpoint, replace: false },
              bubbles: true,
              composed: true,
            }));
            return { fired: true };
          }
        } catch (e) {}
        return { fired: false };
      })()
    `,
    )
    .catch(() => ({ fired: false }));
}

// Core sync
async function syncPlayback(state) {
  if (!mainWindowRef || mainWindowRef.isDestroyed() || !state) return;
  if (isNavigating) return; // Prevent script injection during navigation
  setGuestLock(true);

  const safeUrl = isSafeYtMusicUrl(state.url) ? state.url : null;
  let hostVideoId = safeUrl ? extractVideoId(safeUrl) : null;
  // Reject anything that isn't a real YouTube video ID
  if (hostVideoId && !/^[A-Za-z0-9_-]{11}$/.test(hostVideoId)) {
    console.warn("[ListenAlong] Ignoring invalid video ID from host");
    hostVideoId = null;
  }

  try {
    const currentUrl = mainWindowRef.webContents.getURL();
    let guestVideoId = extractVideoId(currentUrl);
    const playerId = await getGuestPlayerVideoId();
    if (playerId) guestVideoId = playerId;

    // Track changed: navigate so the YT Music UI updates too
    if (hostVideoId && hostVideoId !== guestVideoId) {
      if (hostVideoId !== navTargetId) {
        navTargetId = hostVideoId;
        navAttempts = 0;
      }
      // Cooldown + cap, so a stubborn failure can't loop forever
      if (Date.now() - lastNavAttemptAt < 6000) return;
      if (navAttempts >= 3) {
        if (navAttempts === 3) {
          navAttempts++;
          console.warn(
            "[ListenAlong] Giving up UI navigation, loading audio only",
          );
          try {
            await mainWindowRef.webContents.executeJavaScript(
              `(() => { const p = document.getElementById('movie_player'); if (p && p.loadVideoById) p.loadVideoById(${JSON.stringify(hostVideoId)}); })()`,
            );
          } catch {}
        }
        return;
      }
      navAttempts++;
      lastNavAttemptAt = Date.now();

      const targetUrl = `https://music.youtube.com/watch?v=${hostVideoId}`;
      console.log(
        `[ListenAlong] Guest syncing track: ${targetUrl} (attempt ${navAttempts})`,
      );
      isNavigating = true;

      try {
        let ok = false;

        // In-app methods first
        for (const m of usableNavMethods()) {
          if (ok) break;
          const { fired } = await fireInPageNav(hostVideoId, m);
          if (!fired) {
            navStats[m].fails++;
            continue;
          }
          ok = await waitForTrack(hostVideoId, 1800);
          console.log(`[ListenAlong] In-app nav '${m}' verified=${ok}`);
          if (ok) {
            navStats[m].worked = true;
            navStats[m].fails = 0;
          } else {
            navStats[m].fails++;
          }
        }

        // Hard fallback: full page load
        if (!ok) {
          console.log("[ListenAlong] Falling back to page load");
          try {
            await mainWindowRef.webContents.executeJavaScript(
              `window.location.assign(${JSON.stringify(targetUrl)})`,
            );
          } catch {
            try {
              await mainWindowRef.loadURL(targetUrl);
            } catch (e) {
              if (!e || (e.errno !== -3 && e.code !== "ERR_ABORTED")) throw e;
            }
          }
        }

        lastNavigatedVideoId = hostVideoId;
      } catch (err) {
        console.error("[ListenAlong] Navigation failed:", err);
      } finally {
        setTimeout(() => {
          isNavigating = false;
        }, 1500);
      }
      return;
    }

    if (!hostVideoId && safeUrl) {
      console.warn(
        `[ListenAlong] Host URL does not contain a video ID (${safeUrl}). Host must open the song player / watch view or update their app.`,
      );
    }

    // Calculate actual host position accounting for transit time
    let targetTime = Number(state.currentTime) || 0;
    if (state.isPlaying && state.serverTimestamp && clockSyncDone) {
      const elapsedSinceCapture = (serverNow() - state.serverTimestamp) / 1000;
      if (elapsedSinceCapture > 0 && elapsedSinceCapture < 10) {
        targetTime += elapsedSinceCapture;
      }
    }

    const shouldPlay = Boolean(state.isPlaying);

    const script = `
      (() => {
        try {
          const audio = document.querySelector('audio');
          const video = document.querySelector('video');
          const media = (audio && audio.duration) ? audio : video;
          if (!media) return { status: 'no-media' };

          const targetTime = ${targetTime};
          const shouldPlay = ${shouldPlay};
          const drift = media.currentTime - targetTime;
          const absDrift = Math.abs(drift);

          // Play/pause control
          if (shouldPlay && media.paused) {
            media.play().catch(() => {});
          } else if (!shouldPlay && !media.paused) {
            media.pause();
          }

          // Drift correction
          if (absDrift > ${DRIFT_HARD_THRESHOLD}) {
            // Hard seek
            media.currentTime = targetTime;
            if (shouldPlay) media.play().catch(() => {});
            return { status: 'hard-seek', drift };
          } else if (absDrift > ${DRIFT_SOFT_THRESHOLD}) {
            // Rate nudge — speed up or slow down to converge
            media.playbackRate = drift > 0 ? 0.92 : 1.08;
            return { status: 'rate-nudge', rate: media.playbackRate, drift };
          } else {
            /* Within acceptable range — restore normal speed */
            if (media.playbackRate !== 1) media.playbackRate = 1;
            return { status: 'ok', drift };
          }
        } catch (e) {
          return { status: 'error', error: e.message };
        }
      })()
    `;

    const result = await mainWindowRef.webContents
      .executeJavaScript(script)
      .catch(() => null);
    if (result && result.status !== "ok") {
      console.log(
        `[ListenAlong] Sync: ${result.status} drift=${result.drift?.toFixed(3)}s`,
      );
    }
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

  socket.on("connect", async () => {
    console.log("[ListenAlong] Socket connected, syncing clock...");
    await syncClock(socket);
    console.log("[ListenAlong] Registering as host");
    socket.emit("party:host-connect", { partyId, hostToken });
  });

  socket.on("party:host-ready", () => {
    console.log(`[ListenAlong] Party ${partyId} active (Host)`);
    startBroadcast();
    notifyStateChange();
  });

  socket.on("party:member-joined", ({ member, members }) => {
    currentMembers = members || [];
    notifyStateChange();
    if (member && member.name) {
      try {
        new Notification({
          title: "Listen Along",
          body: `${member.name} joined your party!`,
          silent: true,
        }).show();
      } catch (e) {}
    }
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
    if (currentParty && currentParty.role === "host") {
      closeParty(); // Triggers auto-host evaluation
    }
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
  navTargetId = null;
  navAttempts = 0;
  clockOffset = 0;
  clockSyncDone = false;
  notifyStateChange();

  evaluateAutoHost();
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

    isConnecting = true;
    socket = io(cleanUrl, {
      transports: ["websocket", "polling"],
      timeout: 8000,
    });

    socket.on("connect", async () => {
      console.log(`[ListenAlong] Socket connected, syncing clock...`);
      await syncClock(socket);
      console.log(
        `[ListenAlong] Joining party ${cleanPartyId} as "${cleanName}"`,
      );
      socket.emit("party:join", {
        partyId: cleanPartyId,
        displayName: cleanName,
      });
    });

    socket.on("party:joined", ({ partyId: pid, hostName, state, members }) => {
      if (settled) return;
      settled = true;
      isConnecting = false;

      currentParty = {
        role: "guest",
        id: pid,
        hostName: hostName || "Friend",
        guestName: cleanName,
        serverUrl: cleanUrl,
      };
      currentMembers = members || [];
      lastSongState = state || null;

      setGuestLock(true);
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
        isConnecting = false;
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
        isConnecting = false;
        if (socket) {
          socket.disconnect();
          socket = null;
        }
        reject(new Error("Could not connect to sync server."));
        evaluateAutoHost();
      }
    });

    socket.on("disconnect", () => {
      console.warn("[ListenAlong] Guest socket disconnected");
      if (currentParty && currentParty.role === "guest") {
        leaveParty(); // will evaluate auto host inside
      }
    });
  });
}

async function leaveParty() {
  if (!currentParty) return;

  await setGuestLock(false);

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  currentParty = null;
  currentMembers = [];
  lastSongState = null;
  lastNavigatedVideoId = null;
  navTargetId = null;
  navAttempts = 0;
  clockOffset = 0;
  clockSyncDone = false;
  notifyStateChange();

  evaluateAutoHost();
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

function setAutoHost(enabled, hostName) {
  autoHostEnabled = !!enabled;
  if (hostName !== undefined) autoHostName = hostName;
  evaluateAutoHost();
}

function evaluateAutoHost() {
  if (autoHostEnabled && !currentParty && !isConnecting) {
    // default to 'Host' if name is entirely empty to prevent blank hosts
    const nameToUse = (autoHostName || "").trim() || "Host";
    setTimeout(() => {
      if (autoHostEnabled && !currentParty && !isConnecting) {
        createParty(DEFAULT_SERVER_URL, nameToUse).catch(console.error);
      }
    }, 500);
  }
}

module.exports = {
  DEFAULT_SERVER_URL,
  initListenAlong,
  createParty,
  closeParty,
  joinParty,
  leaveParty,
  getListenAlongState,
  setAutoHost,
};
