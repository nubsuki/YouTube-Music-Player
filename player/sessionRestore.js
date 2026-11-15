const ALLOWED_HOST_SUFFIXES = [
  "youtube.com",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "googlevideo.com",
  "ggpht.com",
  "ytimg.com",
];

function isAllowedHost(rawUrl) {
  try {
    const hostname = new URL(String(rawUrl)).hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

async function captureCurrentSongState(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    return await webContents.executeJavaScript(`
      (() => {
        try {
          const player = document.getElementById('movie_player');
          const video = document.querySelector('video');
          const audio = document.querySelector('audio');
          const media = (video && !isNaN(video.duration)) ? video : (audio && !isNaN(audio.duration)) ? audio : (video || audio);

          let songUrl = '';
          if (player && typeof player.getVideoUrl === 'function') {
            const vUrl = player.getVideoUrl();
            if (vUrl && (vUrl.includes('v=') || vUrl.includes('/watch'))) songUrl = vUrl;
          }
          if (!songUrl && player && typeof player.getVideoData === 'function') {
            const vData = player.getVideoData();
            if (vData && vData.video_id) {
              songUrl = 'https://music.youtube.com/watch?v=' + vData.video_id;
            }
          }
          if (!songUrl) {
            const link = document.querySelector('ytmusic-player-bar a[href*="watch?v="]') ||
                         document.querySelector('.title.ytmusic-player-bar a') ||
                         document.querySelector('a.ytp-title-link');
            if (link && link.href && (link.href.includes('v=') || link.href.includes('/watch'))) {
              songUrl = link.href;
            }
          }
          if (!songUrl) {
            const loc = window.location.href;
            if (loc && (loc.includes('music.youtube.com/watch') || loc.includes('v='))) {
              songUrl = loc;
            }
          }

          let currentTime = 0;
          if (player && typeof player.getCurrentTime === 'function') {
            const t = player.getCurrentTime();
            if (Number.isFinite(t) && t > 0) currentTime = Math.floor(t);
          }
          if (!currentTime && media && Number.isFinite(media.currentTime) && media.currentTime > 0) {
            currentTime = Math.floor(media.currentTime);
          }

          const isPlaying = media ? (!media.paused && !media.ended && media.currentTime > 0) : false;

          return { songUrl, currentTime, isPlaying };
        } catch (e) {
          return null;
        }
      })()
    `);
  } catch (err) {
    return null;
  }
}

function formatWatchUrl(rawUrl, currentTime, resumePlayback) {
  if (!rawUrl || typeof rawUrl !== "string") return "https://music.youtube.com";
  try {
    const urlObj = new URL(rawUrl);
    if (!isAllowedHost(rawUrl)) return "https://music.youtube.com";

    if (urlObj.pathname.includes("/watch") || urlObj.searchParams.has("v")) {
      if (resumePlayback && Number.isFinite(currentTime) && currentTime > 0) {
        urlObj.searchParams.set("t", Math.floor(currentTime));
      } else {
        urlObj.searchParams.delete("t");
      }
    }
    return urlObj.toString();
  } catch {
    return rawUrl;
  }
}

async function saveLastSongSession(webContents, { openLastSong = true, resumePlayback = false, defaultUrl = "https://music.youtube.com" } = {}) {
  if (!openLastSong) return defaultUrl;
  if (!webContents || webContents.isDestroyed()) return defaultUrl;

  try {
    const state = await captureCurrentSongState(webContents);
    let candidateUrl = state && state.songUrl ? state.songUrl : webContents.getURL();

    if (candidateUrl && isAllowedHost(candidateUrl)) {
      candidateUrl = formatWatchUrl(candidateUrl, state ? state.currentTime : 0, resumePlayback);
    } else {
      candidateUrl = defaultUrl;
    }

    // Pause audio and video before closing
    await webContents.executeJavaScript(`
      try {
        const player = document.getElementById('movie_player');
        if (player && typeof player.pauseVideo === 'function') player.pauseVideo();
        const audio = document.querySelector('audio');
        const video = document.querySelector('video');
        if (audio && !audio.paused) audio.pause();
        if (video && !video.paused) video.pause();
      } catch (e) {}
    `).catch(() => {});

    return candidateUrl;
  } catch (err) {
    console.error("[SessionRestore] Error saving last song session:", err);
    return defaultUrl;
  }
}

function computeStartupUrl(lastUrl, { openLastSong = true, resumePlayback = false, defaultUrl = "https://music.youtube.com" } = {}) {
  const fallback = defaultUrl;
  if (!lastUrl || typeof lastUrl !== "string") return fallback;

  try {
    const parsedUrl = new URL(lastUrl);
    if (!isAllowedHost(parsedUrl.toString())) return fallback;

    if (!openLastSong) {
      parsedUrl.pathname = "/";
      parsedUrl.search = "";
      return parsedUrl.toString();
    }

    if (!resumePlayback) {
      parsedUrl.searchParams.delete("t");
    }

    return parsedUrl.toString();
  } catch {
    return fallback;
  }
}

function applyStartupPlayback(webContents, { openLastSong = true, resumePlayback = false, lastUrl = "" } = {}) {
  if (!openLastSong || !lastUrl || !lastUrl.includes("/watch")) return;

  setTimeout(() => {
    if (!webContents || webContents.isDestroyed()) return;
    webContents.executeJavaScript(`
      (() => {
        let attempts = 0;
        const applyPlaybackState = () => {
          try {
            const player = document.getElementById('movie_player');
            const media = document.querySelector('video') || document.querySelector('audio');
            if (!player && !media && attempts < 10) {
              attempts++;
              setTimeout(applyPlaybackState, 500);
              return;
            }
            if (${Boolean(resumePlayback)}) {
              if (player && typeof player.playVideo === 'function') {
                player.playVideo();
              } else if (media && media.paused) {
                media.play().catch(() => {});
              }
            } else {
              if (player && typeof player.pauseVideo === 'function') {
                player.pauseVideo();
              } else if (media && !media.paused) {
                media.pause();
              }
            }
          } catch (e) {}
        };
        applyPlaybackState();
      })();
    `).catch(() => {});
  }, 1200);
}

module.exports = {
  captureCurrentSongState,
  formatWatchUrl,
  saveLastSongSession,
  computeStartupUrl,
  applyStartupPlayback,
};

