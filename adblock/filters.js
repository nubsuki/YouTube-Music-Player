const { app, session } = require('electron');
const { StaticNetFilteringEngine } = require('@gorhill/ubo-core');
const path = require('path');
const fs = require('fs').promises;

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const GHOSTERY_PREBUILT_URL = 'ghostery://prebuilt/ads-and-tracking';

let snfe;
let snfeCreated = false;
let snfeActive = false;
let ghosteryEngine;
let GhosteryRequest;
let webRequestHandlerRegistered = false;

const adblockStats = {
  checked: 0,
  blocked: 0,
  lastBlockedAt: 0
};

function resetAdblockStats() {
  adblockStats.checked = 0;
  adblockStats.blocked = 0;
  adblockStats.lastBlockedAt = 0;
}

const CACHE_DIR = path.join(app.getPath('userData'), 'ytmp-filters');
const CACHE_DURATION = 24 * 60 * 60 * 1000;
const USER_FILTERS_FILE = path.join(app.getPath('userData'), 'user-filters.json');

const defaultFilterLists = [
  { name: 'Ghostery (prebuilt)', url: GHOSTERY_PREBUILT_URL, description: 'Ghostery prebuilt Ads + Tracking (built-in)', enabled: false, isDefault: true },
  { name: 'Easylist', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/thirdparties/easylist/easylist.txt', description: 'EasyList (Ad blocking)', enabled: false, isDefault: true },
  { name: 'Ublock-filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/filters/filters.txt', description: 'uBlock filters (Enhanced ad blocking)', enabled: false, isDefault: true },
  { name: 'General filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/filters/filters-general.txt', description: 'General filters (Popular revolving adservers)', enabled: false, isDefault: true },
  { name: 'Ublock-Lite-filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/filters/ubol-filters.txt', description: 'Filters optimized for uBO Lite', enabled: false, isDefault: true },
  { name: 'Ublock-unbreak', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/filters/unbreak.txt', description: 'unbreak sites broken as a result of 3rd-party filter lists.', enabled: false, isDefault: true },
  { name: 'Ublock-privacy', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/heads/master/filters/privacy.txt', description: 'uBlock Privacy filters', enabled: false, isDefault: true }
];

const DEFAULT_FILTER_URLS = new Set(defaultFilterLists.map(f => f.url));

async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch { }
}
function filterCacheName(filterName) {
  return String(filterName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'list';
}
function getCacheFilePath(filterName) { return path.join(CACHE_DIR, `${filterCacheName(filterName)}.txt`); }
function getCacheMetaPath(filterName) { return path.join(CACHE_DIR, `${filterCacheName(filterName)}.meta.json`); }
async function isCacheValid(filterName) {
  try {
    const metaData = await fs.readFile(getCacheMetaPath(filterName), 'utf8');
    const { timestamp } = JSON.parse(metaData);
    return (Date.now() - timestamp) < CACHE_DURATION;
  } catch { return false; }
}
async function loadFromCache(filterName) {
  try { return await fs.readFile(getCacheFilePath(filterName), 'utf8'); } catch { return null; }
}
async function saveToCache(filterName, content) {
  try {
    await ensureCacheDir();
    await fs.writeFile(getCacheFilePath(filterName), content, 'utf8');
    await fs.writeFile(getCacheMetaPath(filterName), JSON.stringify({ timestamp: Date.now(), filterName }), 'utf8');
  } catch { }
}

function ensureGhosteryInFilters(filters) {
  if (!Array.isArray(filters)) return defaultFilterLists;

  const hasGhostery = filters.some(f => f && f.url === GHOSTERY_PREBUILT_URL);
  const list = hasGhostery
    ? filters
    : [
      { name: 'Ghostery (prebuilt)', url: GHOSTERY_PREBUILT_URL, description: 'Ghostery prebuilt Ads + Tracking (built-in)', enabled: false },
      ...filters
    ];

  return list.map(f => (f && typeof f === 'object' ? { ...f, isDefault: DEFAULT_FILTER_URLS.has(f.url) } : f));
}

async function loadUserFilters() {
  try {
    const data = await fs.readFile(USER_FILTERS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const migrated = ensureGhosteryInFilters(parsed);

    if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
      await fs.writeFile(USER_FILTERS_FILE, JSON.stringify(migrated, null, 2), 'utf8');
    }

    return migrated;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(USER_FILTERS_FILE, JSON.stringify(defaultFilterLists, null, 2), 'utf8');
      return defaultFilterLists;
    }

    return defaultFilterLists;
  }
}

async function saveUserFilters(filters) {
  await fs.writeFile(USER_FILTERS_FILE, JSON.stringify(filters, null, 2), 'utf8');
}

async function resetFilters() {
  await fs.writeFile(USER_FILTERS_FILE, JSON.stringify(defaultFilterLists, null, 2), 'utf8');
}

async function downloadFilter(filterList) {
  try {
    if (!/^https:\/\//i.test(String(filterList.url || ''))) return null;
    const response = await fetch(filterList.url);
    if (response.ok) {
      const content = await response.text();
      await saveToCache(filterList.name, content);
      return content;
    }
    return null;
  } catch { return null; }
}

async function loadFilter(filterList, forceUpdate = false) {
  if (!forceUpdate && await isCacheValid(filterList.name)) {
    const cachedContent = await loadFromCache(filterList.name);
    if (cachedContent) return cachedContent;
  }
  return await downloadFilter(filterList);
}

let initEngineQueue = Promise.resolve();
function initializeFilterEngine(forceUpdate = false) {
  initEngineQueue = initEngineQueue.catch(() => {}).then(() => _doInitializeFilterEngine(forceUpdate));
  return initEngineQueue;
}

async function _doInitializeFilterEngine(forceUpdate = false) {
  try {
    resetAdblockStats();

    const allFilterLists = await loadUserFilters();
    const enabledFilterLists = allFilterLists.filter(f => f && f.enabled);

    const ghosteryEnabled = enabledFilterLists.some(f => f.url === GHOSTERY_PREBUILT_URL);

    if (ghosteryEnabled) {
      try {
        const ghostery = await import('@ghostery/adblocker-electron');
        GhosteryRequest = ghostery.Request;
        ghosteryEngine = await ghostery.FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
        // Clear snfe lists (don't destroy — singleton can't be re-created)
        if (snfe) { await snfe.useLists([]); snfeActive = false; }
        return true;
      } catch (err) {
        console.error('Ghostery initialization failed:', err);
        ghosteryEngine = undefined;
        GhosteryRequest = undefined;
      }
    } else {
      ghosteryEngine = undefined;
      GhosteryRequest = undefined;
    }

    const enabledNetLists = enabledFilterLists.filter(f => f.url !== GHOSTERY_PREBUILT_URL);
    if (enabledNetLists.length === 0) {
      if (snfe) { await snfe.useLists([]); snfeActive = false; }
      return false;
    }

    if (!snfeCreated) {
      snfe = await StaticNetFilteringEngine.create();
      snfeCreated = true;
    }

    const filterPromises = enabledNetLists.map(f =>
      loadFilter(f, forceUpdate).then(content => content ? { name: f.name, raw: content } : null)
    );

    const results = await Promise.all(filterPromises);
    const validFilters = results.filter(x => x !== null);

    if (validFilters.length > 0) { await snfe.useLists(validFilters); snfeActive = true; }
    else snfeActive = false;
    return validFilters.length > 0;
  } catch (err) {
    console.error('Adblock engine initialization failed:', err);
    ghosteryEngine = undefined;
    GhosteryRequest = undefined;
    snfeActive = false;
    if (snfe) { try { await snfe.useLists([]); } catch { } }
    return false;
  }
}

function setupWebRequestHandler() {
  if (!ghosteryEngine && !snfeActive) return;
  if (webRequestHandlerRegistered) return;

  webRequestHandlerRegistered = true;

  const blockableResourceTypes = {
    script: true, stylesheet: false, image: true, font: false, xhr: true, fetch: true,
    websocket: false, media: true, object: true, ping: true, csp_report: true,
    preflight: false, navigation: false, sub_frame: true
  };

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!ghosteryEngine && !snfeActive) return callback({});

    const shouldCheck = blockableResourceTypes[details.resourceType];
    if (!shouldCheck) return callback({});

    adblockStats.checked += 1;

    const map = {
      script: 'script', stylesheet: 'stylesheet', image: 'image', font: 'font',
      xhr: 'xmlhttprequest', fetch: 'fetch', websocket: 'websocket',
      media: 'media', object: 'object', ping: 'ping', csp_report: 'csp_report', sub_frame: 'sub_frame'
    };
    const type = map[details.resourceType] || 'other';

    if (ghosteryEngine && GhosteryRequest) {
      try {
        const { match } = ghosteryEngine.match(GhosteryRequest.fromRawDetails({
          url: details.url,
          type,
          sourceUrl: details.referrer || details.url
        }));

        if (match) {
          adblockStats.blocked += 1;
          adblockStats.lastBlockedAt = Date.now();
          return callback({ cancel: true });
        }
      } catch {
        return callback({});
      }

      return callback({});
    }

    const shouldBlock = snfeActive ? snfe.matchRequest({ originURL: details.referrer || details.url, url: details.url, type }) : 0;

    if (shouldBlock !== 0) {
      adblockStats.blocked += 1;
      adblockStats.lastBlockedAt = Date.now();
      return callback({ cancel: true });
    }

    callback({});
  });
}

async function getAdblockStats() {
  let enabledLists = 0;

  try {
    const all = await loadUserFilters();
    enabledLists = Array.isArray(all) ? all.filter(f => f && f.enabled).length : 0;
  } catch {
    enabledLists = 0;
  }

  return {
    engineReady: !!ghosteryEngine || snfeActive,
    enabledLists,
    checked: adblockStats.checked,
    blocked: adblockStats.blocked,
    lastBlockedAt: adblockStats.lastBlockedAt
  };
}

module.exports = { initializeFilterEngine, setupWebRequestHandler, getUserFilters: loadUserFilters, saveUserFilters, resetFilters, getAdblockStats, resetAdblockStats };
