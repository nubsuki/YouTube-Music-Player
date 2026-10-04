const themeOpts = document.querySelectorAll('.theme-btn[data-theme]');
const themeTitle = document.getElementById('title-text');
const labels = document.querySelectorAll('[data-i18n]');
const alwaysOnTopEl = document.getElementById('always-on-top');
const closeBtn = document.getElementById('close-btn');

if (closeBtn) closeBtn.addEventListener('click', () => window.close());

async function applyTranslations() {
    try {
        const translations = await window.electronAPI.getTranslations([
            'mini_player_settings', 'theme', 'theme_midnight', 'theme_blur', 'always_on_top'
        ]);

        themeTitle.textContent = translations['mini_player_settings'];
        labels.forEach(label => {
            const key = label.dataset.i18n;
            if (translations[key]) label.textContent = translations[key];
        });
    } catch (error) {
        console.error('Error applying translations:', error);
    }
}

async function initTheme() {
    const currentTheme = await window.electronAPI.getTheme();
    const allowedThemes = new Set(['midnight', 'blur']);

    const resolvedTheme = allowedThemes.has(currentTheme) ? currentTheme : 'midnight';
    if (resolvedTheme !== currentTheme) {
        window.electronAPI.setTheme(resolvedTheme);
    }

    document.body.className = resolvedTheme;
    themeOpts.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === resolvedTheme);
    });
}

async function initAlwaysOnTop() {
    if (!alwaysOnTopEl) return;

    const enabled = await window.electronAPI.getAlwaysOnTop();
    alwaysOnTopEl.checked = !!enabled;

    alwaysOnTopEl.addEventListener('change', () => {
        window.electronAPI.setAlwaysOnTop(alwaysOnTopEl.checked);
    });
}

themeOpts.forEach(opt => {
    opt.addEventListener('click', () => {
        const theme = opt.dataset.theme;
        document.body.className = theme;
        themeOpts.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        window.electronAPI.setTheme(theme);
    });
});

applyTranslations();
initTheme();
initAlwaysOnTop();
