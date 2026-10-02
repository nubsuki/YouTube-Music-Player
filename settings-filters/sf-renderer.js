document.addEventListener('DOMContentLoaded', async () => {
    const translations = await window.electronAPI.getTranslations();

    const filterListDiv = document.getElementById('filter-list');
    const saveButton = document.getElementById('save-button');
    const cancelButton = document.getElementById('cancel-button');
    const addFilterLink = document.getElementById('add-filter');
    const moreFiltersLink = document.getElementById('more-filters');
    const resetButton = document.getElementById('reset-button');
    const configTitle = document.getElementById('config-title');
    const closeBtn = document.getElementById('close-btn');

    if (closeBtn) closeBtn.addEventListener('click', () => window.close());

    configTitle.textContent = translations.ad_filter_config_title;
    document.getElementById('add-filter-text').textContent = translations.add_new_filter;
    document.getElementById('more-filters-text').textContent = translations.more_filters;
    document.getElementById('save-button-text').textContent = translations.save;
    document.getElementById('cancel-button-text').textContent = translations.cancel;
    document.getElementById('reset-button-text').textContent = translations.reset;

    const adblockStateEl = document.getElementById('adblock-state');
    const adblockEnabledListsEl = document.getElementById('adblock-enabled-lists');
    const adblockCheckedEl = document.getElementById('adblock-checked');
    const adblockBlockedEl = document.getElementById('adblock-blocked');
    const adblockHintEl = document.getElementById('adblock-hint');
    const resetAdblockStatsBtn = document.getElementById('reset-adblock-stats');

    const updateAdblockStatus = async () => {
        if (!window.electronAPI.getAdblockStats) return;
        if (!adblockStateEl || !adblockEnabledListsEl || !adblockCheckedEl || !adblockBlockedEl) return;

        try {
            const stats = await window.electronAPI.getAdblockStats();
            const isActive = !!stats.active;

            adblockStateEl.textContent = isActive ? 'Active' : 'Inactive';
            adblockStateEl.classList.toggle('active', isActive);
            adblockStateEl.classList.toggle('inactive', !isActive);

            adblockEnabledListsEl.textContent = (stats.enabledLists ?? 0).toLocaleString();
            adblockCheckedEl.textContent = (stats.checked ?? 0).toLocaleString();
            adblockBlockedEl.textContent = (stats.blocked ?? 0).toLocaleString();

            if (adblockHintEl) {
                if ((stats.enabledLists ?? 0) === 0) {
                    adblockHintEl.textContent = 'No filter lists enabled. Enable at least one list and press Save.';
                } else if (!isActive) {
                    adblockHintEl.textContent = 'Filters are enabled but not active yet. Try toggling a list and pressing Save, or restart the app.';
                } else if ((stats.checked ?? 0) === 0) {
                    adblockHintEl.textContent = 'Active. Counters will increase as requests are made.';
                } else if ((stats.blocked ?? 0) === 0) {
                    adblockHintEl.textContent = 'Active, but nothing has been blocked yet.';
                } else {
                    adblockHintEl.textContent = 'Active and blocking requests.';
                }
            }
        } catch {
            if (adblockHintEl) adblockHintEl.textContent = 'Unable to read adblock status.';
        }
    };

    if (resetAdblockStatsBtn && window.electronAPI.resetAdblockStats) {
        resetAdblockStatsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAPI.resetAdblockStats();
            updateAdblockStatus();
        });
    }

    updateAdblockStatus();
    setInterval(updateAdblockStatus, 1000);

    let allFilters = [];

    //load ad skipper settings
    const adSkipperEnabled = document.getElementById('ad-skipper-enabled');
    const adSkipSpeed = document.getElementById('ad-skip-speed');

    const adSkipperSettings = await window.electronAPI.getAdSkipperSettings();
    adSkipperEnabled.checked = adSkipperSettings.enabled;
    adSkipSpeed.value = adSkipperSettings.speed;

    adSkipSpeed.addEventListener('change', () => {});

    const renderFilters = () => {
        filterListDiv.innerHTML = '';
        allFilters.forEach((filter, index) => {
            const filterItem = document.createElement('div');
            filterItem.className = 'filter-item';
            
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = filter.enabled;
            checkbox.addEventListener('change', (e) => {
                filter.enabled = e.target.checked;
            });
            
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(filter.name));

            const content = document.createElement('div');
            content.className = 'filter-content';
            content.appendChild(label);

            const desc = document.createElement('div');
            desc.className = 'filter-desc';
            desc.textContent = filter.description || 'Custom filter list';
            content.appendChild(desc);

            filterItem.appendChild(content);

            if (!filter.isDefault) {
                const deleteButton = document.createElement('button');
                deleteButton.className = 'delete-btn';
                deleteButton.title = translations.delete;
                deleteButton.setAttribute('aria-label', translations.delete);
                
                const trashIcon = document.createElement('i');
                trashIcon.className = 'bi bi-trash';
                deleteButton.appendChild(trashIcon);
                
                deleteButton.addEventListener('click', () => {
                    allFilters.splice(index, 1);
                    renderFilters();
                });
                filterItem.appendChild(deleteButton);
            }

            filterListDiv.appendChild(filterItem);
        });
    };

    const initialFilters = await window.electronAPI.getFilters();
    allFilters = initialFilters;
    
    renderFilters();

    saveButton.addEventListener('click', (e) => {
        e.preventDefault();

        const filtersToSave = allFilters.map(f => ({
            name: f.name,
            url: f.url,
            description: f.description,
            enabled: f.enabled
        }));

        window.electronAPI.saveFilters(filtersToSave);

        window.electronAPI.saveAdSkipperSettings({
            enabled: adSkipperEnabled.checked,
            speed: parseInt(adSkipSpeed.value)
        });

        window.close();
    });

    cancelButton.addEventListener('click', (e) => {
        e.preventDefault();
        window.close();
    });

    const addFilterModal = document.getElementById('add-filter-modal');
    const addFilterName = document.getElementById('add-filter-name');
    const addFilterUrl = document.getElementById('add-filter-url');
    const addFilterError = document.getElementById('add-filter-error');
    const addFilterCancel = document.getElementById('add-filter-cancel');
    const addFilterConfirm = document.getElementById('add-filter-confirm');

    if (addFilterModal && addFilterName && addFilterUrl && addFilterError && addFilterCancel && addFilterConfirm) {
        document.getElementById('add-filter-modal-title').textContent = translations.add_new_filter;
        document.getElementById('add-filter-name-label').textContent = translations.filter_name;
        document.getElementById('add-filter-url-label').textContent = translations.filter_url;
        document.getElementById('add-filter-cancel-text').textContent = translations.cancel;
        document.getElementById('add-filter-confirm-text').textContent = translations.add_new_filter;

        const setModalError = (message) => {
            if (!message) {
                addFilterError.textContent = '';
                addFilterError.hidden = true;
                return;
            }
            addFilterError.textContent = message;
            addFilterError.hidden = false;
        };

        const hideAddFilterModal = () => {
            addFilterModal.hidden = true;
            setModalError('');
        };

        const showAddFilterModal = () => {
            addFilterName.value = '';
            addFilterUrl.value = '';
            setModalError('');
            addFilterModal.hidden = false;
            addFilterName.focus();
        };

        const normalizeAndValidateUrl = (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) return null;

            try {
                return new URL(trimmed).toString();
            } catch {
                try {
                    return new URL(`https://${trimmed}`).toString();
                } catch {
                    return null;
                }
            }
        };

        const confirmAddFilter = () => {
            const name = addFilterName.value.trim();
            if (!name) {
                setModalError('Please enter a filter name.');
                addFilterName.focus();
                return;
            }

            const url = normalizeAndValidateUrl(addFilterUrl.value);
            if (!url) {
                setModalError('Please enter a valid URL.');
                addFilterUrl.focus();
                return;
            }

            allFilters.push({ name, url, description: 'Custom filter list', enabled: true, isDefault: false });
            renderFilters();
            hideAddFilterModal();
        };

        addFilterLink.addEventListener('click', (e) => {
            e.preventDefault();
            showAddFilterModal();
        });

        addFilterCancel.addEventListener('click', (e) => {
            e.preventDefault();
            hideAddFilterModal();
        });

        addFilterConfirm.addEventListener('click', (e) => {
            e.preventDefault();
            confirmAddFilter();
        });

        addFilterModal.addEventListener('click', (e) => {
            if (e.target === addFilterModal) hideAddFilterModal();
        });

        const keyHandler = (e) => {
            if (addFilterModal.hidden) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                hideAddFilterModal();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmAddFilter();
            }
        };

        addFilterName.addEventListener('keydown', keyHandler);
        addFilterUrl.addEventListener('keydown', keyHandler);
    } else {
        addFilterLink.addEventListener('click', (e) => {
            e.preventDefault();
            allFilters.push({ name: '', url: '', enabled: true, isDefault: false });
            renderFilters();
        });
    }

    moreFiltersLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://github.com/uBlockOrigin/uAssets/tree/master');
    });

    resetButton.addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.resetFilters();
        window.close();
    });
});
