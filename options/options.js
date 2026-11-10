const api = window.optionsAPI;

// Tab navigation
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

// Back button & Escape key
document.getElementById('back-btn').addEventListener('click', () => {
  api.closeOptions();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const addModal = document.getElementById('add-filter-modal');
    if (addModal && !addModal.hidden) return;
    api.closeOptions();
  }
});

// Status helper
function showStatus(el, msg, ok = true) {
  el.textContent = msg;
  el.style.color = ok ? '#22c55e' : '#ef4444';
  setTimeout(() => { el.textContent = ''; }, 2500);
}

// App settings tab
const startWithSystem = document.getElementById('start-with-system');
const openLastSongEl  = document.getElementById('open-last-song');
const resumePlayEl    = document.getElementById('resume-playback');
const minToTrayEl     = document.getElementById('minimize-to-tray');
const mpOnMinimizeEl  = document.getElementById('miniplayer-on-minimize');
const resumeRow       = document.getElementById('resume-row');
const mpMinimizeRow   = document.getElementById('miniplayer-on-minimize-row');

function syncSubToggles() {
  resumeRow.classList.toggle('enabled', openLastSongEl.checked);
  mpMinimizeRow.classList.toggle('enabled', minToTrayEl.checked);
}

async function autoSaveAppSettings() {
  syncSubToggles();
  await api.saveAppSettings({
    startWithSystem:          startWithSystem.checked,
    openLastSong:             openLastSongEl.checked,
    resumePlayback:           resumePlayEl.checked,
    minimizeToTray:           minToTrayEl.checked,
    openMiniPlayerOnMinimize: mpOnMinimizeEl.checked,
  });
}

[startWithSystem, openLastSongEl, resumePlayEl, minToTrayEl, mpOnMinimizeEl].forEach(el => {
  el.addEventListener('change', autoSaveAppSettings);
});

async function loadAppSettings() {
  const s = await api.getAppSettings();
  startWithSystem.checked = s.startWithSystem;
  openLastSongEl.checked  = s.openLastSong;
  resumePlayEl.checked    = s.resumePlayback;
  minToTrayEl.checked     = s.minimizeToTray;
  mpOnMinimizeEl.checked  = s.openMiniPlayerOnMinimize;
  syncSubToggles();
}

// Ad & filters tab
let allFilters = [];

function autoSaveFilters() {
  const toSave = allFilters.map(f => ({ name: f.name, url: f.url, description: f.description, enabled: f.enabled }));
  api.saveFilters(toSave);
  api.saveAdSkipperSettings({
    enabled: document.getElementById('ad-skipper-enabled').checked,
    speed: parseInt(document.getElementById('ad-skip-speed').value),
  });
}

const adblockStateEl   = document.getElementById('adblock-state');
const adblockListsEl   = document.getElementById('adblock-enabled-lists');
const adblockCheckedEl = document.getElementById('adblock-checked');
const adblockBlockedEl = document.getElementById('adblock-blocked');

async function updateAdblockStatus() {
  try {
    const stats = await api.getAdblockStats();
    const isActive = !!stats.active;

    adblockStateEl.className = 'status-value state-indicator ' + (isActive ? 'active' : 'inactive');
    adblockStateEl.textContent = isActive ? 'Active' : 'Inactive';

    adblockListsEl.textContent   = (stats.enabledLists ?? 0).toLocaleString();
    adblockCheckedEl.textContent = (stats.checked ?? 0).toLocaleString();
    adblockBlockedEl.textContent = (stats.blocked ?? 0).toLocaleString();
  } catch {}
}

function renderFilters() {
  const list = document.getElementById('filter-list');
  list.innerHTML = '';
  allFilters.forEach((filter, i) => {
    const item = document.createElement('div');
    item.className = 'filter-item';

    const content = document.createElement('div');
    content.className = 'filter-content';

    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = filter.enabled;
    cb.addEventListener('change', e => {
      filter.enabled = e.target.checked;
      autoSaveFilters();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(filter.name));
    content.appendChild(label);

    const desc = document.createElement('div');
    desc.className = 'filter-desc';
    desc.textContent = filter.description || 'Custom filter list';
    content.appendChild(desc);
    item.appendChild(content);

    if (!filter.isDefault) {
      const del = document.createElement('button');
      del.className = 'delete-btn'; del.title = 'Delete';
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      del.addEventListener('click', () => {
        allFilters.splice(i, 1);
        renderFilters();
        autoSaveFilters();
      });
      item.appendChild(del);
    }
    list.appendChild(item);
  });
}

async function loadFilters() {
  allFilters = await api.getFilters();
  renderFilters();
  const s = await api.getAdSkipperSettings();
  document.getElementById('ad-skipper-enabled').checked = s.enabled;
  document.getElementById('ad-skip-speed').value = s.speed;

  document.getElementById('ad-skipper-enabled').addEventListener('change', autoSaveFilters);
  document.getElementById('ad-skip-speed').addEventListener('change', autoSaveFilters);
}

document.getElementById('reset-filters-btn').addEventListener('click', () => {
  api.resetFilters();
  setTimeout(loadFilters, 500);
});

document.getElementById('more-filters').addEventListener('click', e => {
  e.preventDefault();
  api.openExternal('https://github.com/uBlockOrigin/uAssets/tree/master');
});

// Add filter modal
const addModal     = document.getElementById('add-filter-modal');
const addNameEl    = document.getElementById('add-filter-name');
const addUrlEl     = document.getElementById('add-filter-url');
const addErrorEl   = document.getElementById('add-filter-error');

function showAddModal() { addNameEl.value = ''; addUrlEl.value = ''; addErrorEl.hidden = true; addModal.hidden = false; addNameEl.focus(); }
function hideAddModal() { addModal.hidden = true; }

function validateUrl(raw) {
  const t = raw.trim(); if (!t) return null;
  try { return new URL(t).toString(); } catch { try { return new URL('https://' + t).toString(); } catch { return null; } }
}

function confirmAdd() {
  const name = addNameEl.value.trim();
  if (!name) { addErrorEl.textContent = 'Please enter a filter name.'; addErrorEl.hidden = false; addNameEl.focus(); return; }
  const url = validateUrl(addUrlEl.value);
  if (!url) { addErrorEl.textContent = 'Please enter a valid URL.'; addErrorEl.hidden = false; addUrlEl.focus(); return; }
  allFilters.push({ name, url, description: 'Custom filter list', enabled: true, isDefault: false });
  renderFilters();
  hideAddModal();
  autoSaveFilters();
}

document.getElementById('add-filter-btn').addEventListener('click', showAddModal);
document.getElementById('add-filter-cancel').addEventListener('click', hideAddModal);
document.getElementById('add-filter-confirm').addEventListener('click', confirmAdd);
addModal.addEventListener('click', e => { if (e.target === addModal) hideAddModal(); });
[addNameEl, addUrlEl].forEach(el => el.addEventListener('keydown', e => {
  if (addModal.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); hideAddModal(); }
  if (e.key === 'Enter') { e.preventDefault(); confirmAdd(); }
}));

// Mini player tab
async function loadMiniPlayer() {
  const theme = await api.getMiniPlayerTheme();
  const aot   = await api.getMiniPlayerAlwaysOnTop();
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  document.getElementById('always-on-top').checked = aot;
  applyMpPreview(theme);
}

function applyMpPreview(theme) {
  const card = document.getElementById('mp-preview-card');
  if (theme === 'blur') {
    card.style.background = 'rgba(255,255,255,0.1)';
    card.style.backdropFilter = 'blur(16px)';
  } else {
    card.style.background = 'rgba(0,0,0,0.75)';
    card.style.backdropFilter = 'none';
  }
}

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    api.setMiniPlayerTheme(btn.dataset.theme);
    applyMpPreview(btn.dataset.theme);
  });
});

document.getElementById('always-on-top').addEventListener('change', e => {
  api.setMiniPlayerAlwaysOnTop(e.target.checked);
});

// Listen along tab
function switchLaTab(tab) {
  document.getElementById('la-tab-join').classList.toggle('active', tab === 'join');
  document.getElementById('la-tab-host').classList.toggle('active', tab === 'host');
  document.getElementById('la-pane-join').style.display = tab === 'join' ? '' : 'none';
  document.getElementById('la-pane-host').style.display = tab === 'host' ? '' : 'none';
}

document.getElementById('la-tab-join').addEventListener('click', () => switchLaTab('join'));
document.getElementById('la-tab-host').addEventListener('click', () => switchLaTab('host'));

function setLaStatus(msg) { document.getElementById('la-status-msg').textContent = msg; }

function showLaActive(state) {
  const isActive = state && state.isActive;
  document.getElementById('la-inactive-view').style.display = isActive ? 'none' : '';
  document.getElementById('la-active-view').style.display   = isActive ? '' : 'none';
  if (isActive) {
    document.getElementById('la-role-label').textContent = state.isHost ? 'You are hosting' : 'You have joined';
    document.getElementById('la-party-code-display').textContent = state.partyId || '------';
    document.getElementById('la-stop-btn').textContent = state.isHost ? 'Stop Party' : 'Leave Party';
  }
}

function getDisplayName() { return document.getElementById('la-display-name').value.trim(); }

function validateLaName() {
  const name = getDisplayName();
  const joinBtn = document.getElementById('la-join-btn');
  const hostBtn = document.getElementById('la-host-btn');
  const hint = document.getElementById('la-name-hint');
  const nameInput = document.getElementById('la-display-name');

  if (name.length < 3) {
    if (joinBtn) joinBtn.disabled = true;
    if (hostBtn) hostBtn.disabled = true;
    if (hint) {
      hint.textContent = name.length === 0
        ? 'Name must be at least 3 characters.'
        : `Name too short (${name.length}/3 characters min).`;
      hint.style.color = name.length === 0 ? 'var(--text-muted)' : 'var(--danger)';
    }
    return false;
  } else {
    if (joinBtn) joinBtn.disabled = false;
    if (hostBtn) hostBtn.disabled = false;
    if (nameInput) nameInput.classList.remove('input-error');
    if (hint) {
      hint.textContent = '';
    }
    return true;
  }
}

document.getElementById('la-display-name').addEventListener('input', () => {
  const name = getDisplayName();
  api.laSaveConfig({ hostName: name });
  validateLaName();
});

async function loadLaState() {
  const [state, cfg] = await Promise.all([api.laGetState(), api.laGetConfig()]);
  if (cfg.hostName) document.getElementById('la-display-name').value = cfg.hostName;
  document.getElementById('la-auto-host').checked = !!cfg.autoHost && ((cfg.hostName || '').trim().length >= 3);
  validateLaName();
  showLaActive(state);
}

api.onLaStateChange(state => showLaActive(state));

document.getElementById('la-join-btn').addEventListener('click', async () => {
  const name = getDisplayName();
  if (name.length < 3) {
    const nameInput = document.getElementById('la-display-name');
    nameInput.classList.add('input-error');
    nameInput.focus();
    const hint = document.getElementById('la-name-hint');
    if (hint) {
      hint.textContent = 'Display name must be at least 3 characters.';
      hint.style.color = 'var(--danger)';
    }
    setLaStatus('Display name must be at least 3 characters.');
    return;
  }
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) { setLaStatus('Please enter a party code.'); return; }
  setLaStatus('Joining…');
  try {
    api.laSaveConfig({ hostName: name });
    const result = await api.laJoinParty(code, name);
    if (result && result.success) { setLaStatus(''); showLaActive({ isActive: true, isHost: false, partyId: code }); }
    else setLaStatus('Could not join. Check the code and try again.');
  } catch (e) { setLaStatus('Error: ' + e.message); }
});

function extractPartyCode(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();

  // 1. Full URL with /party/CODE
  const urlMatch = trimmed.match(/\/party\/([a-zA-Z0-9]{4,8})/i);
  if (urlMatch) return urlMatch[1].toUpperCase();

  // 2. Prefix like "Code: ABC123" or "party: ABC123"
  const prefixMatch = trimmed.match(/(?:code|party|id)[\s:#=-]+([a-zA-Z0-9]{4,8})/i);
  if (prefixMatch) return prefixMatch[1].toUpperCase();

  // 3. Direct clean code (spaces, hyphens, hashes stripped)
  const stripped = trimmed.replace(/[\s\-_#]/g, '');
  if (/^[a-zA-Z0-9]{3,8}$/.test(stripped)) {
    return stripped.slice(0, 6).toUpperCase();
  }

  // 4. Standalone 6-character word
  const wordMatch = trimmed.match(/\b([a-zA-Z0-9]{6})\b/);
  if (wordMatch) return wordMatch[1].toUpperCase();

  // 5. Fallback: strip non-alphanumeric and take first 6
  return stripped.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
}

async function getClipboardText() {
  let text = '';
  try {
    if (api && typeof api.laReadClipboard === 'function') {
      text = await api.laReadClipboard();
    }
  } catch (e) {
    console.warn('IPC clipboard read failed:', e);
  }
  if (!text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        text = await navigator.clipboard.readText();
      }
    } catch (e) {
      console.warn('navigator.clipboard read failed:', e);
    }
  }
  return (text || '').trim();
}

const pasteBtn = document.getElementById('paste-btn');
const joinCodeInput = document.getElementById('join-code');

joinCodeInput.addEventListener('paste', (e) => {
  const pasted = (e.clipboardData || window.clipboardData)?.getData('text');
  if (pasted) {
    const extracted = extractPartyCode(pasted);
    if (extracted) {
      e.preventDefault();
      joinCodeInput.value = extracted;
    }
  }
});

pasteBtn.addEventListener('click', async () => {
  const originalText = pasteBtn.textContent;
  try {
    const raw = await getClipboardText();
    const code = extractPartyCode(raw);
    if (code) {
      joinCodeInput.value = code;
      joinCodeInput.focus();
      pasteBtn.textContent = 'Pasted!';
      setTimeout(() => { pasteBtn.textContent = originalText; }, 1200);
      setLaStatus('');
    } else {
      pasteBtn.textContent = 'Empty';
      setLaStatus(raw ? 'No valid party code found in clipboard.' : 'Clipboard is empty.');
      setTimeout(() => { pasteBtn.textContent = originalText; }, 1200);
    }
  } catch (e) {
    setLaStatus('Could not read clipboard.');
  }
});

document.getElementById('la-host-btn').addEventListener('click', async () => {
  const name = getDisplayName();
  if (name.length < 3) {
    const nameInput = document.getElementById('la-display-name');
    nameInput.classList.add('input-error');
    nameInput.focus();
    const hint = document.getElementById('la-name-hint');
    if (hint) {
      hint.textContent = 'Display name must be at least 3 characters.';
      hint.style.color = 'var(--danger)';
    }
    setLaStatus('Display name must be at least 3 characters.');
    return;
  }
  setLaStatus('Creating party…');
  try {
    api.laSaveConfig({ hostName: name, autoHost: document.getElementById('la-auto-host').checked });
    const result = await api.laCreateParty(name);
    if (result && result.partyId) { setLaStatus(''); showLaActive({ isActive: true, isHost: true, partyId: result.partyId }); }
    else setLaStatus('Could not create party. Try again.');
  } catch (e) { setLaStatus('Error: ' + e.message); }
});

document.getElementById('la-auto-host').addEventListener('change', e => {
  const name = getDisplayName();
  if (e.target.checked && name.length < 3) {
    e.target.checked = false;
    const nameInput = document.getElementById('la-display-name');
    nameInput.classList.add('input-error');
    nameInput.focus();
    const hint = document.getElementById('la-name-hint');
    if (hint) {
      hint.textContent = 'Name must be at least 3 characters before enabling auto-host.';
      hint.style.color = 'var(--danger)';
    }
    setLaStatus('Display name must be at least 3 characters.');
    return;
  }
  api.laSaveConfig({ autoHost: e.target.checked, hostName: name });
});

document.getElementById('la-copy-code-btn').addEventListener('click', () => {
  const code = document.getElementById('la-party-code-display').textContent;
  api.laCopyText(code);
  document.getElementById('la-copy-code-btn').textContent = 'Copied!';
  setTimeout(() => { document.getElementById('la-copy-code-btn').textContent = 'Copy Code'; }, 1500);
});

document.getElementById('la-open-page-btn').addEventListener('click', () => {
  const code = document.getElementById('la-party-code-display').textContent;
  api.laOpenPartyPage(code);
});

document.getElementById('la-stop-btn').addEventListener('click', async () => {
  const state = await api.laGetState();
  if (state && state.isHost) await api.laCloseParty();
  else await api.laLeaveParty();
  showLaActive({ isActive: false });
  setLaStatus('');
});

// About tab
async function loadAbout() {
  const info = await api.getAboutInfo();
  document.getElementById('about-name').textContent    = info.appName;
  document.getElementById('about-desc').textContent    = info.appDescription;
  document.getElementById('about-version').textContent = info.translations.version;
  const gh = document.getElementById('about-github');
  gh.addEventListener('click', e => { e.preventDefault(); api.openExternal(info.githubUrl); });
}

document.getElementById('check-updates-btn').addEventListener('click', async () => {
  const btn = document.getElementById('check-updates-btn');
  const status = document.getElementById('update-status');
  btn.disabled = true; status.textContent = 'Checking…';
  try {
    const result = await api.checkForUpdates();
    status.textContent = result.message || 'Check complete.';
  } catch (e) {
    status.textContent = 'Could not check for updates.';
  } finally {
    btn.disabled = false;
  }
});

// Init - load everything
(async () => {
  await Promise.all([
    loadAppSettings(),
    loadFilters(),
    loadMiniPlayer(),
    loadLaState(),
    loadAbout(),
    updateAdblockStatus(),
  ]);
  setInterval(updateAdblockStatus, 2000);
})();

