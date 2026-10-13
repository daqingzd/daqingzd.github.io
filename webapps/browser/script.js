// Premium Browser - Performance Optimized Script
// Key optimizations: event delegation, debouncing, cached DOM, reduced reflows

'use strict';

var pwaos_ = null;
var is_pwaos = false;
var bookmark_service = null;
var download_service = null;
var history_service = null;

// ============================================
// Favicon URL — CN users get favicon.im, others get logo.clearbit
// ============================================
const _isCN = () => {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return /^Asia\/Shanghai$|^Asia\/Hong_Kong$|^Asia\/Beijing$|^Asia\/Chongqing$|^Asia\/Harbin$|^Asia\/Kashgar$/i.test(tz);
    } catch { return false; }
};
const faviconUrl = host => {
    const base = _isCN() ? 'https://favicon.im' : 'https://logo.clearbit.com';
    return `${base}/${encodeURIComponent(host)}`;
};

// ============================================
// DOM Cache - Avoid repeated queries
// ============================================
const cache = {};
function $(id) {
    if (!cache[id]) cache[id] = document.getElementById(id);
    return cache[id];
}

// ============================================
// Debounce Utility
// ============================================
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

function throttle(fn, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ============================================
// State
// ============================================
let tabs = [];
// Monotonic id assigned to each tab on creation. Used to round-trip a
// tab reference from the context-menu HTML (where only data-attributes
// survive innerHTML serialization) back to the live DOM element. See
// handleContextMenuClick() which reads data-tab-id and resolves it
// against this id via tabs[].
let nextTabId = 1;
let restoringTabs = [];
let currIndexOfrestoringTabs = undefined;
let currentTab = null;
// Closed-tabs history for Ctrl+Shift+T (restore last closed tab)
let recentlyClosedTabs = [];
// Tab groups: { groupId: { id, name, color, collapsed, tabs: [] } }
let tabGroups = {};
let nextGroupId = 1;
const GROUP_COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4'];

// ============================================
// Session Persistence (beforeunload / init)
// ============================================
const SESSION_KEY = 'ffSession';

async function saveSession() {
    if (!Settings.get('restoreSession')) return;

    try {
        const validTabs = tabs.filter(t => t._url && t._url.trim() !== '' && !_isSpecialPage(t._url));
        const currentTabIndex = validTabs.indexOf(currentTab);
        const data = {
            tabs: validTabs.map(t => ({
                url: t._url || '',
                title: t._title || '标签页',
                groupId: t._groupId || null,
                zoom: t._zoom || 1,
                textZoom: t._textZoom || 1,
                app_id: t.app_id || null,
                sessionId: t.sessionId || null,
            })),
            currentIndex: currentTabIndex >= 0 ? currentTabIndex : 0,
            groups: Object.values(tabGroups).map(g => ({
                id: g.id,
                name: g.name,
                color: g.color,
                collapsed: g.collapsed,
            })),
            ts: Date.now(),
        };
        await BrowserStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch (_) {}
}
async function restoreSession() {
    try {
        const raw = await BrowserStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data?.tabs?.length) {
            return;
        }
        // Only restore if session is recent (within 7 days)
        if (Date.now() - data.ts > 7 * 24 * 60 * 60 * 1000) return;

        // Restore groups first
        if (data.groups) {
            data.groups.forEach(g => {
                tabGroups[g.id] = { ...g, tabs: [] };
                if (g.id >= nextGroupId) nextGroupId = g.id + 1;
            });
        }

        // Restore current tab
        currIndexOfrestoringTabs = data.currentIndex;

        // Restore tabs async
        const maxRestored = Math.min(data.tabs.length, 20);
        for (let i = 0; i < maxRestored; i++) {
            const t = data.tabs[i];
            t.app_id = await launchApp(t.url, t.sessionId);
            restoringTabs.push(t);
        }
    } catch (_) {}
}
function restoreTab(tab) {
    let bRestored = false;
    restoringTabs.forEach(t => {
        if (t.app_id == tab.app_id) {
            tab._groupId = t.groupId || null;
            tab._zoom = t.zoom || 1;
            tab._textZoom = t.textZoom || 1;

            bRestored = true;
        }
    });
    // restore完成，过滤掉已经处理完成的tab记录
    restoringTabs = restoringTabs.filter(t => t.app_id !== tab.app_id);

    // Restore group tab associations
    tabs.forEach(t => {
        if (t._groupId && tabGroups[t._groupId]) {
            tabGroups[t._groupId].tabs.push(t);
        }
    });

    if (currIndexOfrestoringTabs >= 0 && currIndexOfrestoringTabs < tabs.length) {
        switchToTab(tabs[currIndexOfrestoringTabs]);
        currIndexOfrestoringTabs = undefined;
    }

    return bRestored;
}

// Auto-save on unload
window.addEventListener('beforeunload', saveSession);
// Migrate legacy bookmark data (addedAt timestamp + dedupe) before any UI
// code looks at it; idempotent across calls.
let bookmarks = [];
normalizeBookmarkStore().then(migrated => {
    bookmarks = migrated;
}).catch(() => {
    BrowserStorage.getItem('ffBookmarks').then(v => {
        if (v) bookmarks = JSON.parse(v);
    });
});

// Downloads manager
let downloads = [];
BrowserStorage.getItem('ffDownloads').then(v => {
    if (v) downloads = JSON.parse(v);
});
async function saveDownloads() {
    await BrowserStorage.setItem('ffDownloads', JSON.stringify(downloads));
}

function addDownload(url, filename) {
    const dl = {
        id: Date.now(),
        url,
        filename: filename || url.split('/').pop() || 'untitled',
        timestamp: Date.now(),
        size: null,
        completed: false,
    };
    downloads.unshift(dl);
    if (downloads.length > 100) downloads.pop();
    saveDownloads();
    window.dispatchEvent(new CustomEvent('downloads-changed'));
    return dl;
}

function removeDownload(id) {
    downloads = downloads.filter(d => d.id !== id);
    saveDownloads();
    window.dispatchEvent(new CustomEvent('downloads-changed'));
}

function completeDownload(id) {
    const dl = downloads.find(d => d.id === id);
    if (dl) { dl.completed = true; saveDownloads(); }
}
async function loadBookmarks() {
    try {
        bookmarks = await normalizeBookmarkStore();
    } catch (_e) {
        const v = await BrowserStorage.getItem('ffBookmarks');
        bookmarks = v ? JSON.parse(v) : [];
    }
}
let history = [];
async function initHistory() {
    const raw = await BrowserStorage.getItem('ffHistory');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    if (parsed.length > 0 && typeof parsed[0] === 'string') {
        // Old format: array of URL strings → migrate
        const migrated = parsed.map((url, i) => ({
            url, title: url, visitedAt: Date.now() - i * 60000,
        }));
        await BrowserStorage.setItem('ffHistory', JSON.stringify(migrated));
        const flat = migrated.map(e => e.url);
        await BrowserStorage.setItem('ffHistoryFlat', JSON.stringify(flat));
        history = flat;
        return;
    }
    // New format: array of {url, title, visitedAt}
    history = parsed.filter(e => e && typeof e.url === 'string').map(e => e.url);
}
initHistory();
let titleUpdateInterval = null;
let currentSidebarView = 'bookmarks';

// Show a transient bottom-centered notification. The original showToast
// was called from many call sites but never actually defined anywhere —
// we now provide a real implementation that auto-dismisses, supports a
// cancel by returning a dismiss handle, and stacks if invoked in rapid
// succession.
function showToast(message, level = 'info', duration = 2500) {
    const container = $('toast-container');
    if (!container) return null;
    const toast = document.createElement('div');
    toast.className = `toast ${level}`;
    toast.textContent = message;
    toast.setAttribute('role', 'status');
    container.appendChild(toast);

    let dismissed = false;
    function dismiss() {
        if (dismissed) return;
        dismissed = true;
        toast.classList.add('leaving');
        // Remove from DOM after the fade-out completes.
        setTimeout(() => toast.remove(), 200);
    }
    const timer = setTimeout(dismiss, Math.max(800, duration));
    // Click anywhere on the toast to dismiss early.
    toast.addEventListener('click', dismiss);
    return { dismiss, element: toast, duration: timer };
}


// ============================================
// PwaOS Init
// ============================================
// PWA Install Prompt Handler
let deferredPrompt = null;
let isPWAInstalled = false;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Show custom install button or banner
    console.log('PWA install prompt available');
});

window.addEventListener('appinstalled', () => {
    isPWAInstalled = true;
    deferredPrompt = null;
    console.log('PWA installed successfully');
});

// Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
            .then(registration => {
                console.log('SW registered:', registration.scope);
                
                // Check for updates periodically
                setInterval(() => {
                    registration.update();
                }, 60 * 60 * 1000); // Check every hour
            })
            .catch(err => console.log('SW registration failed:', err));
    });
}

document.addEventListener('DOMContentLoaded', init);

function init() {
    let use_pwaos = false;
    // Check if running as installed PWA
    if (window.matchMedia('(display-mode: standalone)').matches) {
        isPWAInstalled = true;
    }
    
    if (window.requestService) {
        use_pwaos = true;
        customElements.define('my-webappgroup', WebAppGroup);
        window.requestService('pwaos.runtime').then(success => {
            if (success) {
                pwaos_ = pwaos.runtime;
                console.log("PwaOS version: " + pwaos_.kVersion);
                pwaos_.init().then(pwaos_onLoad);
            }
        }).catch(err => console.error("Failed to requestService: " + err));
    } else {
        customElements.define('my-webappgroup', StandaloneWebAppGroup);
    }
    initBrowser();
    setupReloadAnimation();

    window.addEventListener('storage', (e) => {
        if (e.key === 'ffSearchEngine') {
            handleUrlInputSearchEngine();
        } else if (e.key === 'ffBookmarks') {
            // Another tab/window changed bookmarks — refresh the bar.
            refreshBookmarksUI();
        }
    });

    handleUrlInputSearchEngine();

    // Sync suggestions-url-panel width to url-bar in real time
    const urlBar = $('url-bar');
    if (urlBar) {
        const ro = new ResizeObserver(() => {
            const panel = $('suggestions-url-panel');
            if (!panel || panel.hidden) return;
            const r = urlBar.getBoundingClientRect();
            panel.style.setProperty('--sup-anchor-l', `${Math.max(4, Math.round(r.left))}px`);
            panel.style.setProperty('--sup-anchor-t', `${Math.round(r.bottom + 6)}px`);
            panel.style.setProperty('--sup-width', `${Math.round(r.width)}px`);
        });
        ro.observe(urlBar);
    }
    document.addEventListener('keydown', e => {
        // Ctrl+L / Cmd+L — focus address bar (Firefox/Chrome standard)
        if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
            e.preventDefault();
            const input = $('url-input');
            if (input) { input.focus(); input.select(); }
            return;
        }
        if (e.key === 'Escape' && !$('page-info-panel').hidden) {
            PageInfo.close();
        }
        if (e.key === 'Escape' && !$('search-engine-panel').hidden) {
            SearchEnginePanel.close();
        }
        if (e.key === 'Escape' && !$('suggestions-url-panel').hidden) {
            SuggestionsUrlPanel.close();
        }
    });

    // Close floating panels when user clicks outside them.
        // Excludes panels that should stay open (sidebar, app-menu, etc.)
        // since they have their own outside-click guards or are controlled explicitly.
        // Toggle sources — clicking a panel's own trigger must not be treated as
        // "outside" because the click handler restores the panel immediately.
    const PANEL_TOGGLES = {
        'page-info-panel': ['#url-icon'],
        'suggestions-url-panel': ['#url-input'],
        'cmd-palette': [],
    };
    const OUTSIDE_CLOSE_PANELS = Object.keys(PANEL_TOGGLES);
    document.addEventListener('mousedown', (e) => {
        for (const id of OUTSIDE_CLOSE_PANELS) {
            const panel = $(id);
            if (!panel) continue;
            // hidden panels are already "closed"
            if (panel.hidden || (panel.classList && panel.classList.contains('hidden'))) continue;
            // Skip if click is inside the panel itself
            if (panel.contains(e.target)) continue;
            // Skip if click is on the panel's own toggle trigger(s)
            const triggers = PANEL_TOGGLES[id] || [];
            if (triggers.some(sel => e.target?.closest?.(sel))) continue;
            // Close it
            if (id === 'page-info-panel') PageInfo.close();
            else if (id === 'suggestions-url-panel') SuggestionsUrlPanel.close();
            else if (id === 'cmd-palette') CommandPalette.close();
        }
    });

    if (!use_pwaos)
        addTab();
}

// ============================================
// Reload Button Animation
// ============================================
function updateReloadSpinner(loading) {
    const reloadBtn = $('reload-btn');
    const apply = (btn) => {
        if (!btn) return;
        if (loading) {
            btn.classList.add('reloading');
            btn.title = i18n.t('stop') || '停止';
            reloadBtn.disabled = false;
        } else {
            btn.classList.remove('reloading');
            btn.title = i18n.t('refresh') || '刷新';
        }
    };
    apply(reloadBtn);
}

function setupReloadAnimation() {
    const webAppView = $('webappgroup');
    const reloadBtn = $('reload-btn');

    // Also hook into webappgroup's reload() calls directly
    const origReload = webAppView.reload?.bind(webAppView);
    if (origReload) {
        webAppView.reload = (...args) => {
            updateReloadSpinner(true);
            startTitleUpdateInterval();
            return origReload(...args);
        };
    }
    const origStop = webAppView.stop?.bind(webAppView);
    if (origStop) {
        webAppView.stop = (...args) => {
            updateReloadSpinner(false);
            return origStop?.(...args);
        };
    }
}

function pwaos_onLoad() {
    is_pwaos = true;
    // ==== PWAOS_PATH_TRACE (testing aid) ====
    try { localStorage.setItem('__pwaos_path_probe', 'onLoad ' + new Date().toISOString() + ' v=' + (pwaos_.kVersion||'?')); } catch(e){}

    pwaos_.createObjectWithNativeInterface('Settings').then(function(value) {
        pwaos_.Settings = value;
    }).catch(err => console.warn('[settings] createObjectWithNativeInterface', err.message || err));

    // =====================================
    const webAppView = $('webappgroup');
    webAppView.init();

    webAppView.registerEvent('onNewWebViewCreated', (app_id, info) => {
        if (!currentTab) {
            addTab().then(tab => {
                webAppView.curr_app_id = tab.app_id = app_id;
                restoreTab(tab);
                startTitleUpdateInterval();
            });
        }
        else if (!currentTab.app_id) {
            webAppView.curr_app_id = currentTab.app_id = app_id;
            restoreTab(currentTab);
            startTitleUpdateInterval();
        } else if (currentTab.app_id != app_id) {
            addTab().then(tab => {
                webAppView.curr_app_id = tab.app_id = app_id;
                if (!restoreTab(tab))
                    switchToTab(tab);
                startTitleUpdateInterval();
            });
        } else {
            restoreTab(currentTab);
        }
    });

    webAppView.registerEvent('onShowContextMenu', (params) => {
        window._contextTarget = webAppView.getActiveElement();
        showContextMenu(params.x, params.y, params);
    });
    webAppView.registerEvent('onHideContextMenu', hideContextMenu);
    webAppView.registerEvent('onToggleFullscreen', (fullscreen) => {
        if (fullscreen != Fullscreen.isActive())
            Fullscreen.toggle();

        if (fullscreen) {
            const navBar = document.getElementById('desktop-nav');
            const tabBar = document.getElementById('tab-bar');
            if (navBar) navBar.style.display = 'none';
            if (tabBar) tabBar.style.display = 'none';
        } else {
            const navBar = document.getElementById('desktop-nav');
            const tabBar = document.getElementById('tab-bar');
            if (navBar) navBar.style.display = '';
            if (tabBar) tabBar.style.display = '';
        }
    });

    // Initialize accelerators
    pwaos_.registerEvent('windowManager', 'onAcceleratorPressed', (shortcut) => {
        if (shortcut == 'Alt+1') {
            if (tabs[0]) switchToTab(tabs[0]);
        } else if (shortcut == 'Alt+2') {
            if (tabs[1]) switchToTab(tabs[1]);
        } else if (shortcut == 'Alt+3') {
            if (tabs[2]) switchToTab(tabs[2]);
        } else if (shortcut == 'Alt+4') {
            if (tabs[3]) switchToTab(tabs[3]);
        } else if (shortcut == 'Alt+5') {
            if (tabs[4]) switchToTab(tabs[4]);
        } else if (shortcut == 'Alt+6') {
            if (tabs[5]) switchToTab(tabs[5]);
        } else if (shortcut == 'Alt+7') {
            if (tabs[6]) switchToTab(tabs[6]);
        } else if (shortcut == 'Alt+8') {
            if (tabs[7]) switchToTab(tabs[7]);
        } else if (shortcut == 'Alt+9') {
            if (tabs[8]) switchToTab(tabs[8]);
        } else if (shortcut == 'Alt+F') {
            toggleAppMenu();
        } else if (shortcut == 'Ctrl+L') {
            const input = $('url-input');
            if (input) { input.focus(); input.select(); }
        } else if (shortcut == 'Ctrl+T') {
            addTab();
        } else if (shortcut == 'Ctrl+W') {
            if (currentTab)
              closeTab(currentTab);
        } else if (shortcut == 'Ctrl+B') {
            toggleSidebar();
        } else if (shortcut == 'Ctrl+D') {
            toggleBookmark();
        } else if (shortcut == 'Ctrl+N') {
            openNewWindow();
        } else if (shortcut == 'Ctrl+F') {
            FindBar.open();
        } else if (shortcut == 'Ctrl+I') {
            PageInfo.toggle();
        } else if (shortcut == 'Ctrl+P') {
            window.print?.();
        } else if (shortcut == 'Ctrl+Tab') {
            doTabCycle(1);
        } else if (shortcut == 'Ctrl+0') {
            resetZoom();
        } else if (shortcut == 'Ctrl+=') {
            adjustZoom(ZOOM_STEP);
        } else if (shortcut == 'Ctrl+-') {
            adjustZoom(-ZOOM_STEP);
        } else if (shortcut == 'Ctrl+Shift+Tab') {
            doTabCycle(-1);
        } else if (shortcut == 'Ctrl+Shift+P') {
            CommandPalette.toggle();
        } else if (shortcut == 'F5') {
            toggleReload();
        } else if (shortcut == 'F11') {
            Fullscreen.toggle();
        } else if (shortcut == 'F12') {
            openDeveloperTools();
        } else if (shortcut == 'Alt+Left Arrow') {
            goBack();
        } else if (shortcut == 'Alt+Right Arrow') {
            goForward();
        }
    });
    pwaos_.appManager.getCurrentAppID().then(function(value) {
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit1", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit2", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit3", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit4", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit5", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit6", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit7", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit8", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit9", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyI", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyL", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyT", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyW", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyB", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyD", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyN", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyF", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyF", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyP", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "Digit0", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "Equal", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "Minus", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyA", true, true, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "KeyP", true, true, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "Tab", true, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "Tab", true, true, false);
        //pwaos_.windowManager.registerAccelerator(value.appId, "F5", false, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "F11", false, false, false);
        //pwaos_.windowManager.registerAccelerator(value.appId, "F12", false, false, false);
        pwaos_.windowManager.registerAccelerator(value.appId, "ArrowLeft", false, false, true);
        pwaos_.windowManager.registerAccelerator(value.appId, "ArrowRight", false, false, true);
    });

    if (pwaos_?.get_bookmarkService) {
        pwaos_.get_bookmarkService().then(function(result){
            bookmark_service = result;
        });
    }
    if (pwaos_?.get_downloadService) {
        pwaos_.get_downloadService().then(function(result){
            download_service = result;
        });
    }
    if (pwaos_?.get_historyService) {
        pwaos_.get_historyService().then(function(result){
            history_service = result;
        });
    }

    Settings.get('restoreSession').then(function(value){
        if (value) {
            restoreSession().then(function() {
                if (tabs.length == 0 && restoringTabs.length == 0)
                    addTab();
            });
        } else {
            addTab();
        }
    });
}

// ============================================
// Bookmarks Bar
// ============================================
function initBookmarksBar() {
    updateBookmarksBar();
    // Restore the persisted visibility. The context menu stores
    // 'hidden'/'visible' in localStorage under ffBookmarksBar; a
    // missing key (or unknown value) means the default: visible.
    try {
        if (localStorage.getItem('ffBookmarksBar') === 'hidden') {
            const bar = document.getElementById('bookmarks-bar');
            if (bar) bar.style.display = 'none';
        }
    } catch(_) {}
    // Listen for bookmark changes to refresh every surface. All three
    // triggers (library-page postMessage, cross-tab storage, chrome-side
    // writer dispatch) reload the store from storage first — the
    // in-memory array can be stale when the writer mutated storage
    // directly, so updateBookmarksBar alone would re-render old data.
    window.addEventListener('bookmarks-changed', refreshBookmarksUI);
    // Multi-level folder dropdowns: document-level click + keyboard
    // listeners, registered once (updateBookmarksBar re-renders the bar
    // but must not stack duplicate listeners).
    initBookmarksDropdownKeys();
}

// ============================================
// Folder picker dialog (tree UI for promptForFolder)
// ============================================
let _folderPicker = null;   // { resolve, selected, dialog, scrim }

// Prompt the user for a bookmark name + folder in ONE merged dialog.
// Used by toggleBookmark and editBookmark. Renders a modal dialog with
// a name input (pre-filled by the caller; required for OK) and the
// bookmark directory as a tree UI: folders nested via "/" segments
// (same hierarchy as the bar dropdowns and the library tree), a root
// row, and a new-folder input that creates a nested path under the
// selection ("Work" + "Design" -> "Work/Design"; type a full path from
// the root to nest at any depth).
// Returns a Promise: the trimmed folder path ('' for root) on OK, or
// null when the user cancels (Cancel / Escape / close button). The
// required name typed into the dialog is exposed via _bfpName for the
// caller to read after the promise resolves.
// Name typed into the merged dialog's name input (read by toggleBookmark
// / editBookmark after the promise resolves; NOT the resolved value —
// the promise resolves the folder path).
let _bfpName = null;

async function promptForFolder(defaultName = '', defaultTitle = '') {
    // A previous picker still open (rapid double call): cancel it —
    // the new call supersedes it.
    if (_folderPicker) bfpFinish(null);
    return new Promise(resolve => {
        const scrim = document.createElement('div');
        scrim.id = 'folder-picker-scrim';
        scrim.className = 'bfp-scrim';
        const dialog = document.createElement('div');
        dialog.id = 'folder-picker-dialog';
        dialog.className = 'glass-panel bfp-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', '选择文件夹');
        // Tree of existing folders (nested via "/" segments). The root
        // row starts selected.
        const tree = getBookmarkFolderTree();
        const treeHtml = bfpBranchesHTML(tree.get('').children, tree);
        dialog.innerHTML = `
            <div class="bfp-header">
                <span class="bfp-title">选择文件夹</span>
                <button type="button" class="bfp-close" aria-label="关闭">×</button>
            </div>
            <div class="bfp-namerow"><input type="text" class="bfp-nameinput" placeholder="${bookmarksEscapeAttr(defaultTitle)}" autocomplete="off"></div>
            <div class="bfp-tree">${treeHtml}</div>
            <div class="bfp-newrow">
                <input type="text" class="bfp-newinput" placeholder="新文件夹名（可选，可用 / 表示层级）" autocomplete="off">
            </div>
            <div class="bfp-footer">
                <button type="button" class="bfp-btn bfp-cancel">取消</button>
                <button type="button" class="bfp-btn bfp-ok">确定</button>
            </div>`;
        scrim.appendChild(dialog);
        document.body.appendChild(scrim);

        _folderPicker = { resolve, selected: '', name: null, dialog, scrim };
        _bfpName = null;

        // Wiring: one delegated click listener on the dialog (the DOM
        // is built once per open — no innerHTML re-render afterwards,
        // so listeners never stack). Keydown on the document with
        // capture so Enter/Escape work while the input holds focus.
        dialog.addEventListener('click', e => {
            if (e.target.closest('.bfp-close')) { bfpFinish(null); return; }
            if (e.target.closest('.bfp-cancel')) { bfpFinish(null); return; }
            if (e.target.closest('.bfp-ok')) { bfpOk(); return; }
            const caret = e.target.closest('.bfp-caret');
            if (caret) {
                e.preventDefault();
                e.stopPropagation();
                const node = caret.closest('.bfp-node');
                const kids = node.querySelector(':scope > .bfp-children');
                const expanded = caret.getAttribute('aria-expanded') === 'true';
                caret.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                if (kids) kids.style.display = expanded ? 'none' : '';
                return;
            }
            const row = e.target.closest('.bfp-row');
            if (row) bfpSelect(row.dataset.folder || '', row);
        });
        document.addEventListener('keydown', bfpOnKey, true);

        // Pre-select the default folder when it exists (editBookmark
        // passes the bookmark's current folder).
        if (defaultName) {
            const row = [...dialog.querySelectorAll('.bfp-row')]
                .find(r => (r.dataset.folder || '') === defaultName);
            if (row) bfpSelect(defaultName, row);
        }
        // Pre-fill the name input (toggleBookmark/editBookmark pass the
        // page title / current name) and focus it — the common first action.
        const inp = dialog.querySelector('.bfp-nameinput');
        if (inp) {
            if (defaultTitle) inp.value = defaultTitle;
            inp.focus();
        }
    });
}

// Recursive branches HTML for the picker tree. Leaf folders keep the
// caret slot (visibility:hidden) so all rows stay aligned.
function bfpBranchesHTML(paths, tree) {
    let html = '';
    for (const p of paths) {
        const node = tree.get(p);
        const hasKids = node.children.length > 0;
        const caretAttr = hasKids ? ' aria-expanded="true"' : ' aria-hidden="true"';
        html += `
        <div class="bfp-node" data-folder="${bookmarksEscapeAttr(p)}">
            <div class="bfp-row" data-folder="${bookmarksEscapeAttr(p)}" role="button" tabindex="0">
                <svg class="bfp-caret${hasKids ? '' : ' bfp-caret-leaf'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"${caretAttr}><polyline points="9 18 15 12 9 6"></svg>
                <svg class="bfp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></svg>
                <span class="bfp-label">${bookmarksEscapeAttr(node.name)}</span>
            </div>
            ${hasKids ? `<div class="bfp-children">${bfpBranchesHTML(node.children, tree)}</div>` : ''}
        </div>`;
    }
    return html;
}

// Select a folder row (radio-style highlight).
function bfpSelect(path, rowEl) {
    if (!_folderPicker) return;
    _folderPicker.selected = path;
    _folderPicker.dialog.querySelectorAll('.bfp-row').forEach(r => r.classList.remove('bfp-selected'));
    if (rowEl) rowEl.classList.add('bfp-selected');
}

// Enter/Escape for the picker. Capture-phase so they win while the
// new-folder input holds focus. Only fires while the picker is open.
function bfpOnKey(e) {
    if (!_folderPicker) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        bfpFinish(null);
    } else if (e.key === 'Enter') {
        if (!_folderPicker.dialog.contains(e.target)) return;
        e.preventDefault();
        bfpOk();
    }
}

// Resolve with OK: empty input -> the selected folder path ('' = root);
// non-empty input -> nested under the selection ("Work" + "Design" ->
// "Work/Design").
function bfpOk() {
    if (!_folderPicker) return;
    // Name is required in the merged dialog — OK with an empty name
    // shakes the name input and keeps the dialog open.
    const nameInp = _folderPicker.dialog.querySelector('.bfp-nameinput');
    const name = nameInp ? (nameInp.value || '').trim() : '';
    if (!name) {
        if (nameInp) {
            nameInp.classList.add('bfp-shake');
            nameInp.focus();
        }
        return;
    }
    _folderPicker.name = name;
    _bfpName = name;
    const inp = _folderPicker.dialog.querySelector('.bfp-newinput');
    const extra = inp ? (inp.value || '').trim() : '';
    const sel = _folderPicker.selected || '';
    bfpFinish(extra ? (sel ? sel + '/' + extra : extra) : sel);
}

// Tear down the picker and resolve. result === null cancels; strings
// are trimmed before resolving.
function bfpFinish(result) {
    const picker = _folderPicker;
    if (!picker) return;
    _folderPicker = null;
    _bfpName = null;
    document.removeEventListener('keydown', bfpOnKey, true);
    picker.scrim.remove();
    picker.resolve(typeof result === 'string' ? result.trim() : null);
}

// True when the bookmarks bar is currently visible to the user.
// The bar can be hidden via the context menu, in which case its
// `style.display` is 'none'. Inline-style values reliably reflect
// our hide/show actions; we only ever toggle display via JS.
function isBookmarksBarVisible() {
    const bar = document.getElementById('bookmarks-bar');
    if (!bar) return false;
    return bar.style.display !== 'none';
}

function updateBookmarksBar() {
    const bar = $('bookmarks-bar');
    if (!bar) return;

    const bm = (typeof bookmarks !== 'undefined' && bookmarks.length) ? bookmarks : [];
    if (!bm.length) {
        bar.innerHTML = '';
        return;
    }

    // The bar is a quick-access strip: root-level bookmarks as direct
    // pills, plus one pill per folder. Clicking a folder pill opens a
    // dropdown menu beneath the nav bar; folder dropdowns nest into
    // submenus at multiple levels (folder names may use "/" to express
    // nesting, e.g. "Work/Design"). Dedupe root pills by URL just in
    // case. Also dedupe the folder list via getBookmarkFolders().
    const seen = new Set();
    const root = [];
    for (const b of bm) {
        if (b.folder) continue;            // folder members live in dropdowns
        const key = b.url || b.title;
        if (seen.has(key)) continue;
        seen.add(key);
        root.push(b);
        if (root.length >= 12) break;
    }
    // Top-level folders only — deeper levels ("/" in the name) are
    // submenus inside their parent's dropdown, not bar pills.
    const folders = getBookmarkFolderTree().get('').children;
    if (!root.length && !folders.length) {
        bar.innerHTML = '';
        return;
    }
    const rootHtml = root.map(b => `
        <a class="bar-item" href="#" data-url="${b.url}" title="${b.title}">
            <img class="bar-item-icon" src="${bookmarkFaviconSrc(b)}" alt="" loading="lazy" onerror="this.style.display='none'">
            <span>${b.title}</span>
        </a>
    `).join('');
    const folderHtml = folders.map(f => {
        const ef = bookmarksEscapeAttr(f);
        return `
        <button type="button" class="bar-item bar-folder" data-folder="${ef}" aria-haspopup="true" aria-expanded="false" title="${ef}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>${ef}</span>
            <svg class="bar-folder-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
    `; }).join('');
    bar.innerHTML = folderHtml + rootHtml;

    // Event delegation: one listener on the bar instead of N per item.
    // Folder pills toggle their dropdown; plain pills navigate.
    if (!bar._barDelegate) {
        bar._barDelegate = true;
        bar.addEventListener('click', e => {
            const folder = e.target.closest('.bar-folder');
            if (folder) {
                e.preventDefault();
                toggleBookmarksDropdown(folder.dataset.folder, folder);
                return;
            }
            const item = e.target.closest('.bar-item');
            if (!item) return;
            e.preventDefault();
            navigateToUrl(item.dataset.url);
        });
    }
}

// ============================================
// Bookmarks bar folder dropdowns (multi-level)
// ============================================
// One shared dropdown panel anchored beneath the bar trigger, plus one
// submenu panel per open level. Panels are appended to document.body
// with fixed positioning — the same pattern as #context-menu — because
// .bookmarks-bar has `contain: content`, which would clip children.

// Real favicon for a bookmark: stored data: favicon wins; otherwise
// hostname-based provider URL (same source as sidebar/history).
function bookmarkFaviconSrc(b) {
    if (b.favicon && b.favicon.startsWith('data:')) return b.favicon;
    try { return faviconUrl(new URL(b.url).hostname); } catch { return ''; }
}

// Escape a folder/title for safe interpolation into an HTML attribute.
// Folder names come from window.prompt, so they are user-controlled.
function bookmarksEscapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]
    ));
}

// Build the folder tree from the flat bookmark store. Folder names may
// nest with "/" ("Work/Design"): each path segment becomes a submenu
// level, so "Work" contains "Design", which may contain deeper folders.
// Returns a Map: path -> { name, items: [bookmarks], children: [paths] }.
function getBookmarkFolderTree() {
    const tree = new Map();
    const ensure = (path) => {
        if (!tree.has(path)) {
            const name = path.split('/').pop();
            tree.set(path, { name, items: [], children: [] });
        }
        return tree.get(path);
    };
    ensure('');
    for (const b of bookmarks) {
        if (!b.folder) continue;
        ensure(b.folder).items.push(b);
        // Register ancestor segments so intermediate folders exist even
        // when they hold no direct bookmarks ("Work/Design/A" -> "Work").
        const segs = b.folder.split('/');
        for (let i = 1; i < segs.length; i++) ensure(segs.slice(0, i).join('/'));
    }
    for (const p of tree.keys()) {
        if (p === '') continue;
        const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        tree.get(parent).children.push(p);
    }
    for (const node of tree.values()) {
        node.children.sort((a, b) => a.localeCompare(b, 'zh'));
    }
    return tree;
}

function getBookmarksDropdown() {
    return document.getElementById('bookmarks-dropdown');
}

function closeBookmarksSubmenus() {
    document.querySelectorAll('.bm-submenu').forEach(el => el.remove());
}

function closeBookmarksDropdown() {
    closeBookmarksSubmenus();
    const dd = getBookmarksDropdown();
    if (dd) {
        dd.classList.remove('visible');
        dd.innerHTML = '';
        dd._folder = null;
    }
    document.querySelectorAll('#bookmarks-bar .bar-folder[aria-expanded="true"]')
        .forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}

// Open (or toggle closed) the dropdown for a top-level folder pill.
function toggleBookmarksDropdown(folder, trigger) {
    const dd = getBookmarksDropdown();
    if (!dd) return;
    if (dd.classList.contains('visible') && dd._folder === folder) {
        closeBookmarksDropdown();
        return;
    }
    closeBookmarksDropdown();
    const node = getBookmarkFolderTree().get(folder);
    if (!node) return;
    dd._folder = folder;
    dd.innerHTML = buildBookmarksMenuHTML(node);
    positionBookmarksPanel(dd, trigger.getBoundingClientRect(), 'below');
    dd.classList.add('visible');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
}

// Position a fixed panel near a trigger rect. Mode 'below' anchors under
// the bar (level 0); 'side' anchors to the right of a submenu item,
// flipping left when there is no room. Viewport edges clamp to 8px,
// mirroring showContextMenu.
function positionBookmarksPanel(panel, rect, mode) {
    panel.style.left = '0px';
    panel.style.top = '0px';
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let x, y;
    if (mode === 'below') {
        x = rect.left;
        y = rect.bottom + 4;
    } else {
        x = rect.right + 2;
        y = rect.top - 4;
    }
    if (x + w > vw - 8) x = Math.max(8, (mode === 'below' ? rect.right : rect.left) - w - 2);
    if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
    panel.style.left = Math.round(x) + 'px';
    panel.style.top = Math.round(y) + 'px';
}

// Render a folder node as menu items: its bookmarks first, then its
// subfolders (each opens the next nested level). Shared by the level-0
// dropdown and every deeper .bm-submenu.
function buildBookmarksMenuHTML(node) {
    const tree = getBookmarkFolderTree();
    const esc = bookmarksEscapeAttr;
    const itemHtml = node.items.map(b => `
        <button type="button" class="bm-menu-item" data-url="${esc(b.url)}" title="${esc(b.title)}">
            <img class="bm-menu-icon" src="${bookmarkFaviconSrc(b)}" alt="" loading="lazy" onerror="this.style.display='none'">
            <span class="bm-menu-label">${esc(b.title)}</span>
        </button>
    `).join('');
    const subHtml = node.children.map(p => {
        const child = tree.get(p);
        return `
        <button type="button" class="bm-menu-item bm-menu-folder" data-folder="${esc(p)}" aria-haspopup="true" title="${esc(child.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span class="bm-menu-label">${esc(child.name)}</span>
            <svg class="bm-menu-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
    `; }).join('');
    return itemHtml + subHtml;
}

// Walk from a clicked item up through panel -> trigger -> panel,
// collecting the open chain, then remove every submenu outside it.
// Keeps ancestor levels open — native menu behaviour.
function closeDeeperBookmarksSubmenus(item) {
    const chain = new Set();
    let cur = item;
    while (cur) {
        const panel = cur.closest('#bookmarks-dropdown, .bm-submenu');
        if (!panel) break;
        chain.add(panel);
        cur = panel._trigger || null;
    }
    document.querySelectorAll('.bm-submenu').forEach(sub => {
        if (!chain.has(sub)) sub.remove();
    });
}

// Open the submenu for folder `path`, anchored to its trigger item.
// Clicking the same item again toggles its submenu closed.
function openBookmarksSubmenu(path, triggerEl) {
    const node = getBookmarkFolderTree().get(path);
    if (!node) return;
    for (const sub of document.querySelectorAll('.bm-submenu')) {
        if (sub._trigger === triggerEl) { sub.remove(); return; }
    }
    closeDeeperBookmarksSubmenus(triggerEl);
    const sub = document.createElement('div');
    sub.className = 'glass-panel bm-submenu';
    sub.dataset.folder = path;
    sub._trigger = triggerEl;
    sub.innerHTML = buildBookmarksMenuHTML(node);
    document.body.appendChild(sub);
    positionBookmarksPanel(sub, triggerEl.getBoundingClientRect(), 'side');
}

// Register the document-level listeners for the dropdown + submenus.
// Called once from initBookmarksBar — updateBookmarksBar re-renders the
// bar on every bookmarks-changed and must not stack duplicate listeners.
// handleOutsideClick (registered earlier in initBrowser) already guards
// against menu clicks via .closest('#bookmarks-dropdown') / '.bm-submenu'
// / '.bar-folder', so both listeners coexist without double-closing.
function initBookmarksDropdownKeys() {
    document.addEventListener('click', e => {
        const item = e.target.closest?.('.bm-menu-item');
        if (!item) return;
        const panel = item.closest('#bookmarks-dropdown, .bm-submenu');
        if (!panel) return;
        if (item.classList.contains('bm-menu-folder')) {
            e.preventDefault();
            openBookmarksSubmenu(item.dataset.folder, item);
            return;
        }
        e.preventDefault();
        const url = item.dataset.url;
        closeBookmarksDropdown();
        if (url) navigateToUrl(url);
    });

    // Keyboard: ArrowUp/Down move focus among the open panel's items,
    // ArrowRight opens a folder item's submenu, ArrowLeft / Escape close
    // the deepest submenu (or the whole dropdown). Only fires while the
    // dropdown or a submenu is open and focus is not in a text field.
    document.addEventListener('keydown', e => {
        const dd = getBookmarksDropdown();
        const subs = document.querySelectorAll('.bm-submenu');
        const ddOpen = dd && dd.classList.contains('visible');
        if (!ddOpen && subs.length === 0) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const topPanel = subs.length ? subs[subs.length - 1] : dd;
        const items = Array.from(topPanel.querySelectorAll('.bm-menu-item'));
        const focused = document.activeElement?.closest?.('.bm-menu-item');
        const idx = focused ? items.indexOf(focused) : -1;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!items.length) return;
            const next = e.key === 'ArrowDown'
                ? (idx + 1) % items.length
                : (idx <= 0 ? items.length - 1 : idx - 1);
            items[next].focus();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (focused && focused.classList.contains('bm-menu-folder')) {
                openBookmarksSubmenu(focused.dataset.folder, focused);
                const sub = document.querySelectorAll('.bm-submenu');
                const fresh = sub[sub.length - 1];
                fresh?.querySelector('.bm-menu-item')?.focus();
            }
        } else if (e.key === 'ArrowLeft') {
            if (subs.length) {
                e.preventDefault();
                const top = subs[subs.length - 1];
                const trigger = top._trigger;
                top.remove();
                trigger?.focus();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (subs.length) {
                const top = subs[subs.length - 1];
                const trigger = top._trigger;
                top.remove();
                trigger?.focus();
            } else {
                closeBookmarksDropdown();
            }
        }
    });
}

// Reload the in-memory bookmark store from storage and refresh every
// bookmarks surface (bar + sidebar). Called when an EXTERNAL actor
// mutates ffBookmarks: the library page posts {type:'bookmarks-changed'}
// after its writes, and another tab/window mutating the key fires a
// storage event. updateBookmarksBar alone only renders in-memory state,
// so external changes never reached it without this reload.
async function refreshBookmarksUI() {
    await loadBookmarks();
    // An open folder dropdown would show stale items after an external
    // write — close it; the user reopens from the refreshed bar.
    closeBookmarksDropdown();
    updateBookmarksBar();
    if ($('sidebar').classList.contains('visible') && currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
}

// ============================================
// Event Delegation - Single listener per container
// ============================================
function initBrowser() {
    // Tab bar events
    $('tab-add-btn').addEventListener('click', () => addTab());
    $('hamburger-btn').addEventListener('click', toggleAppMenu);
    $('tab-strip').addEventListener('click', handleTabStripClick);
    $('tab-strip').addEventListener('close-tab', handleCloseTab);
    $('tab-strip').addEventListener('contextmenu', handleTabStripContextMenu);
    // The bar lives under #desktop-nav now (was inside #tab-bar). Wire
    // its right-click to the context menu so the user can hide it.
    $('bookmarks-bar').addEventListener('contextmenu', handleBookmarksBarContextMenu);
    // The library page posts {type:'bookmarks-changed'} after writing
    // ffBookmarks — reload + re-render so bar-items stay current. Origin
    // check mirrors library.html's own listener (file:// posts use '*').
    window.addEventListener('message', (e) => {
        if (location.origin !== 'file://' && e.origin !== location.origin) return;
        const d = e.data;
        if (d && d.type === 'bookmarks-changed') refreshBookmarksUI();
    });
    // Right-clicking the nav-bar (the row above the bookmarks bar)
    // also surfaces a bookmarks-bar toggle in its context menu —
    // useful when the bar is hidden and the user wants to bring
    // it back. Mirrors the same pattern as the bookmarks bar itself.
    $('desktop-nav')?.addEventListener('contextmenu', handleNavBarContextMenu);
    initBookmarksBar();
    initTabDragDrop();
    Settings.init();          // wires #settings-btn, applies persisted prefs
    Theme.init();
    Theme.updateButton();

    // Tab Strip keyboard navigation — standalone document listener (tab-strip is
    // always visible, so uses focus-in-tabstrip detection instead of a panel-closed
    // check). Arrows=switch tabs, Enter=activate, Del=close, Home/End.
    document.addEventListener('keydown', (e) => {
        // Only fire when focus is inside the tab strip
        if (!document.activeElement?.closest('#tab-strip')) return;
        const tabInFocus = document.activeElement.closest('.tab');
        const addInFocus = document.activeElement.id === 'tab-add';
        const idx = tabInFocus ? tabs.indexOf(tabInFocus) : -1;

        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (tabs.length <= 1) return;
            const prev = Math.max(0, idx - 1);
            tabs[prev].focus();
            switchToTab(tabs[prev]);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (tabs.length <= 1) return;
            const next = Math.min(tabs.length - 1, idx + 1);
            tabs[next].focus();
            switchToTab(tabs[next]);
        } else if (e.key === 'Home') {
            e.preventDefault();
            if (tabs[0]) { tabs[0].focus(); switchToTab(tabs[0]); }
        } else if (e.key === 'End') {
            e.preventDefault();
            const last = tabs[tabs.length - 1];
            if (last) { last.focus(); switchToTab(last); }
        } else if (e.key === 'Enter' && tabInFocus) {
            e.preventDefault();
            if (tabInFocus !== currentTab) switchToTab(tabInFocus);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && tabInFocus) {
            e.preventDefault();
            closeTab(tabInFocus);
        } else if (e.key === 'Escape' && tabInFocus) {
            $('webappgroup')?.focus();
        }
    });

    // Also bind to the newtab iframe for the same experience.
    const newtabFrame = document.querySelector('.browser-container iframe');
    if (newtabFrame) {
        newtabFrame.addEventListener('contextmenu', handlePageContextMenu);
    }

    // Desktop nav
    $('back-btn')?.addEventListener('click', goBack);
    $('forward-btn')?.addEventListener('click', goForward);
    $('reload-btn')?.addEventListener('click', toggleReload);
    $('home-btn')?.addEventListener('click', goHome);
    
    $('library-btn')?.addEventListener('click', toggleSidebar);
    $('star-btn')?.addEventListener('click', toggleBookmark);
    // Firefox-style: the lock/identity button to the left of the URL opens
    // page info; clicking again closes it. Mirror Ctrl+I for parity.
    $('url-icon')?.addEventListener('click', PageInfo.toggle);
    $('page-info-panel')?.querySelector('.settings-close')?.addEventListener('click', PageInfo.close);
    $('theme-btn')?.addEventListener('click', Theme.toggle);
    $('search-engine-btn')?.addEventListener('click', () => SearchEnginePanel.toggle());

    // Zoom cluster (URL-bar pills): − percent +. Chrome/Edge-style:
    // dec/in step the page zoom, the percent pill resets to 100%.
    $('zoom-dec')?.addEventListener('click', () => adjustZoom(-ZOOM_STEP));
    $('zoom-inc')?.addEventListener('click', () => adjustZoom(ZOOM_STEP));
    $('zoom-pct')?.addEventListener('click', resetZoom);

    $('search-engine-panel')?.querySelector('.settings-close')?.addEventListener('click', SearchEnginePanel.close);
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            SearchEnginePanel.toggle();
        }
    });

    // Find Bar - debounced search + keyboard nav
    $('find-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Return') {
            e.preventDefault();
            FindBar.step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            FindBar.close();
            $('url-input')?.focus();
        }
    });
    $('find-prev')?.addEventListener('click', () => FindBar.step(-1));
    $('find-next')?.addEventListener('click', () => FindBar.step(1));
    $('find-close')?.addEventListener('click', () => FindBar.close());

    // URL bar - debounced
    $('url-input')?.addEventListener('keydown', handleUrlbarKeydown);
    $('url-input')?.addEventListener('contextmenu', handleUrlInputContextMenu);
    $('url-input')?.addEventListener('focus', () => {
        $('search-engine-select')?.parentElement?.classList.toggle('visible', true);
    });
    $('url-input')?.addEventListener('input', debounce(handleUrlbarInput, 150));
    $('url-input')?.addEventListener('blur', () => { SuggestionsUrlPanel._blurTimer = setTimeout(SuggestionsUrlPanel.close, 200); });

    // Ensure panelKBNav registry exists
    if (!window.panelKBNav) window.panelKBNav = {};

    // Menus - event delegation
    $('hamburger-btn').addEventListener('focusout', handleMenuOrPanelFocusOut.bind(null, $('app-menu')));
    $('app-menu').addEventListener('click', handleAppMenuClick);
    $('app-menu').addEventListener('focusout', handleMenuOrPanelFocusOut.bind(null, $('app-menu')));
    $('settings-panel').addEventListener('focusout', handleMenuOrPanelFocusOut.bind(null, $('settings-panel')));
    $('sidebar').addEventListener('click', handleSidebarClick);
    $('sidebar').addEventListener('contextmenu', handleSidebarContextMenu);
    // Enter/Space on a focused tree folder row toggles the branch (the
    // row has tabindex="0" role="button"; a div doesn't fire click on
    // Enter natively). stopPropagation keeps panelKBNav's document
    // keydown from acting on a stale kb-selected item.
    $('sidebar').addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const toggle = e.target.closest ? e.target.closest('.sidebar-tree-toggle') : null;
        if (!toggle || !toggleSidebarTreeFolder(toggle)) return;
        e.preventDefault();
        e.stopPropagation();
    });
    $('context-menu').addEventListener('click', handleContextMenuClick);
    $('context-menu').addEventListener('focusout', handleMenuOrPanelFocusOut.bind(null, $('context-menu')));

    // Sidebar toolbar
    $('sidebar').querySelector('.sidebar-toolbar')?.addEventListener('click', handleSidebarToolbarClick);

    // Sidebar search
    const searchInput = $('sidebar-search-input');
    if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                showSidebarContent(currentSidebarView, e.target.value);
            }, 150);
        });
        // Prevent sidebar click from triggering when clicking input
        searchInput.addEventListener('click', (e) => e.stopPropagation());
    }

// Sidebar resizer drag handling - high-performance version.
//
// The drag updates --sidebar-width on the documentElement, which causes
// .sidebar and my-webappgroup to relayout. The browser does the layout
// every animation frame regardless of how often we touch the variable.
// Two savings help: rAF coalescing of mousemove events, and
// short-circuiting setProperty when the rAF tick produces the same value
// as last frame. Setter writes the same value back-to-back when the
// cursor settles near integer pixels and that's wasted work; we track
// lastAppliedWidth and bail out when unchanged.
//
// During the drag we also drop a transparent overlay over the
// webappgroup area so the iframe inside doesn't see mousemove events.
// The iframe's own hit-testing and event handling was the visible
// cost when growing the sidebar - the page content kept trying to
// react to the cursor while we were just trying to drag a divider.
    const sidebarResizer = $('sidebar-resizer');
    const sidebar = $('sidebar');
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;
    let rafId = null;
    let lastAppliedWidth = 0;

    function updateSidebarWidth(width) {
        // Skip duplicate updates - the browser layout pipeline already
        // coalesces syncs but writing the same value to a CSS property
        // still costs a small amount of style invalidation work.
        if (width === lastAppliedWidth) return;
        lastAppliedWidth = width;
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    }

    if (sidebarResizer && sidebar) {
        // Transparent mousemove-catcher placed on top of webappgroup
        // for the duration of a drag. Without it, the iframe inside
        // webappgroup handles every mousemove in script (plus its own
        // internal hit-testing), which adds latency on top of our
        // already-busy per-frame layout work.
        let dragOverlay = null;
        function showDragOverlay() {
            if (dragOverlay) return dragOverlay;
            dragOverlay = document.createElement('div');
            dragOverlay.id = 'sidebar-drag-overlay';
            // Below the URL/nav bar, covering the rest of the viewport.
            dragOverlay.style.cssText =
                'position:fixed;top:99px;left:0;right:0;bottom:0;' +
                'z-index:9999;background:transparent;cursor:ew-resize;' +
                'user-select:none;-webkit-user-select:none;' +
                'touch-action:none;';
            document.body.appendChild(dragOverlay);
            return dragOverlay;
        }
        function hideDragOverlay() {
            if (dragOverlay && dragOverlay.parentNode) {
                dragOverlay.parentNode.removeChild(dragOverlay);
            }
            dragOverlay = null;
        }

        sidebarResizer.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startWidth = parseInt(getComputedStyle(sidebar).width, 10) || 300;
            lastAppliedWidth = startWidth;
            // 添加 resizing 类，禁止过渡动画
            sidebar.classList.add('resizing');
            sidebarResizer.classList.add('dragging', 'visible');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            // Drop a transparent mousemove-catcher on top of webappgroup
            // so the iframe doesn't get its own mousemove handlers during
            // the drag - that was the visible cost when growing the
            // sidebar.
            showDragOverlay();
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const newWidth = Math.max(200, Math.min(600, startWidth + deltaX));
            // 使用 requestAnimationFrame 合并多次更新，避免每帧都触发重排
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                updateSidebarWidth(newWidth);
                rafId = null;
            });
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                sidebar.classList.remove('resizing'); // 恢复过渡动画
                sidebarResizer.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                hideDragOverlay();
                if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
            }
        });
    }

    // Keyboard navigation for sidebar
    const sidebarKBNav = installKeyboardNav('sidebar', '.sidebar-item', {
        onEnter(item) { item.click(); },
        onEscape() { toggleSidebar(); },
    });
    window.panelKBNav['sidebar'] = sidebarKBNav;

    // Close menus on outside click
    document.addEventListener('click', handleOutsideClick);

    // Wire up the webappgroup <iframe>'s contentDocument so panels close
    // when the user clicks inside the embedded page (clicks inside an iframe
    // never bubble to the top-level document, so the outside-click listener
    // above would otherwise miss them and leave menus stranded).
    // The listen target is `webappgroup._iframe.contentDocument`, refreshed
    // on every `load` because navigating replaces it.
    function wireIframeOutsideClose() {
        const host = document.getElementById('webappgroup');
        const iframe = host && (host._iframe || host.querySelector?.('iframe'));
        if (!iframe) return;
        try {
            const idoc = iframe.contentDocument;
            if (!idoc || idoc.__pwaosOutsideWired) return;
            idoc.addEventListener('click', handleOutsideClick);
            // Suppress native context menu inside iframe, route to our
            // #context-menu panel. Even if the inner page subscribes to
            // contextmenu first, we attached with `capture: true` so we
            // still get to call preventDefault before the user sees the
            // browser's native popup.
            // We do NOT call stopPropagation() here — the iframe must still
            // receive the event so it can post its context params via the
            // onShowContextMenu PWAOS event. Those params include link_url,
            // src_url, selection_text, is_editable, etc. which buildContextMenu
            // uses to show the correct context menu for iframe content.
            idoc.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // Let the event bubble to the iframe so it can fire
                // onShowContextMenu with rich context params.
                showContextMenu(e.clientX, e.clientY, {
                    // Defaults; will be overridden by iframe params when they arrive
                    page_url: e.target?.ownerDocument?.URL || '',
                    frame_url: '',
                });
            }, true);
            idoc.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    // Bare Escape closes every panel/menu opened by the chrome.
                    // We can't rely on each panel's onEscape handler being
                    // installed against the top-level document, so do the
                    // blanket hide here.
                    hideAllPanels();
                    const cm = document.getElementById('context-menu');
                    if (cm) cm.classList.remove('visible');
                }
            });
            idoc.__pwaosOutsideWired = true;
        } catch (_) {
            // Cross-origin: cannot reach contentDocument. Panels are still
            // closeable from outside via the top-level document listener.
        }
    }

    // ============================================================
    // Keyboard Navigation — roving tabindex for all panels
    // Global registry so any code can trigger keyboard focus
    // ============================================================
    if (!window.panelKBNav) window.panelKBNav = {};

    function openPanel(id) {
        // Generic panel open: focus first item
        const panel = $(id);
        if (!panel) return;
        const nav = panel._kbNav;
        if (nav) nav.focusFirst();
    }

    // App Menu
    const appMenuNav = installKeyboardNav('app-menu', '.menu-item', {
        onEnter(item) { item.click(); },
        onEscape() { hideAppMenu(); },
    });
    window.panelKBNav['app-menu'] = appMenuNav;

    // Context Menu
    const ctxMenuNav = installKeyboardNav('context-menu', '.context-item', {
        onEnter(item) { item.click(); },
        onEscape() { hideContextMenu(); },
    });
    window.panelKBNav['context-menu'] = ctxMenuNav;

    // Override showContextMenu to focus first item when opening.
    // Skip the focus for the URL-input context menu: that menu's items
    // operate via document.execCommand on the focused element, and
    // stealing focus to a menu <button> would make Cut/Copy/Paste/
    // Undo/Select-All silently no-op on the input.
    const _origShowContextMenu = showContextMenu;
    window.showContextMenu = function(x, y, params) {
        _origShowContextMenu(x, y, params);
        if (params && params._urlInputContext) return;
        const nav = window.panelKBNav['context-menu'];
        if (nav) { nav.reset(); nav.focusFirst(); }
    };

    // Override toggleAppMenu to focus first item when opening
    const _origToggleAppMenu = toggleAppMenu;
    window.toggleAppMenu = function() {
        _origToggleAppMenu();
        const nav = window.panelKBNav['app-menu'];
        if ($('app-menu').classList.contains('visible') && nav) {
            nav.reset(); nav.focusFirst();
        }
    };
    window.hideAppMenu = function() {
        const am = $('app-menu');
        if (!am) return;
        const wasVisible = am.classList.contains('visible');
        // Force-remove visible. Using _origToggleAppMenu here was a bug:
        // it calls classList.toggle('visible') which OPENS the menu when it's
        // already closed (e.g. when invoked from handleOutsideClick to clean
        // up after a non-hamburger click). That made "click outside the
        // menu" actually open it. Always hide, never toggle.
        am.classList.remove('visible');
        if (wasVisible) {
            const nav = window.panelKBNav['app-menu'];
            if (nav) nav.reset();
        }
    };


    // Override showSidebarContent to refresh keyboard items when content changes
    const _origShowSidebarContent = showSidebarContent;
    window.showSidebarContent = async function(view, query) {
        await _origShowSidebarContent(view, query);
        const nav = window.panelKBNav['sidebar'];
        if (nav) nav.refreshItems();
    };

    // Global Tab/Esc handler when no panel is open — route to active panel
    document.addEventListener('keydown', (e) => {
        // Escape — close all panels / menus / palette / info
        if (e.key === 'Escape') {
            hideAllPanels();
            $('url-suggestions')?.classList.remove('visible');
            $('context-menu')?.classList.remove('visible');
            $('command-palette')?.classList.remove('visible');
            $('page-info-panel')?.setAttribute('hidden', '');
            Settings.close();
            return;
        }

        // Tab — route into visible panel if none has focus yet
        if (e.key !== 'Tab') return;
        // If no panel has focus, check if any panel is visible and route Tab into it
        const visiblePanels = ['app-menu', 'context-menu',
            'sidebar', 'url-suggestions', 'tab-switcher', 'settings-panel'];
        for (const id of visiblePanels) {
            const panel = $(id);
            if (panel && panel.classList.contains('visible')) {
                e.preventDefault();
                // panel's own keydown will handle it
                return;
            }
        }
    });

    // Window resize - throttled
    window.addEventListener('resize', throttle(updateTabWidths, 100));

    window._appStartTime = Date.now();

    // Create initial tab (will be updated by restoreSession if session exists)
    // Standalone (non-PwaOS) mode: iframe load events are the only signal
    // we get for title/url changes. Bridge them into updateTabFromInfo so the
    // tab title, address bar, identity box, and history all update without
    // the PwaOS C SDK. Without this bridge the tab title stays "新标签页"
    // forever in standalone mode.
    const wg = $('webappgroup');
    if (wg && wg._iframe) {
        wg._iframe.addEventListener('load', () => {
            if (!currentTab) return;
            let title = '';
            let url = wg._currentUrl || '';
            try {
                const doc = wg._iframe.contentDocument;
                if (doc) {
                    title = doc.title || '';
                    // Prefer the iframe's actual location over _currentUrl,
                    // which may lag behind after redirects.
                    if (wg._iframe.contentWindow?.location?.href) {
                        url = wg._iframe.contentWindow.location.href;
                    }
                } else {
                    url = wg._iframe.src;
                }
            } catch (e) {
                // Cross-origin: cannot read contentDocument. Fall back to
                // the URL we set; the title will just be empty/host name.
            }
            if (!title) {
                // Derive a readable title from the URL host when content is
                // cross-origin or page has no <title>.
                try { title = new URL(url).hostname; } catch (_) { title = url || i18n.t('loading'); }
            }
            // Synthesize an info object compatible with updateTabFromInfo
            // but skip the progress>0.3 gate by setting progress to 1.
            updateTabFromInfoStandalone(currentTab, { title, url, progress: 1, faviconUrl: null });
        });

        wg._iframe.addEventListener('error', () => {
            // Network / DNS / file-not-found error. Load network_error.html
            if (!currentTab) return;
            const url = wg._currentUrl || '';
            let host = '';
            try { host = new URL(url).hostname; } catch (_) { host = url; }
            const errMsg = _detectErrorMessage(wg._iframe) || '';
            const errorUrl = `network_error.html?host=${encodeURIComponent(host)}&message=${encodeURIComponent(errMsg)}`;
            wg._iframe.src = errorUrl;
            updateTabFromInfoStandalone(currentTab, {
                title: `无法加载: ${host}`,
                url,
                progress: 1,
                faviconUrl: null,
            });
        });
    }
}

// Attempt to derive a human-readable error message from the iframe's
// contentWindow.location (cross-origin reads return 'about:blank').
function _detectErrorMessage(iframe) {
    try {
        const href = iframe.contentWindow?.location?.href || '';
        if (href === 'about:blank') return null;
        // file:// URLs that fail load: URL is still set but content is blank
        if (href.startsWith('file://')) return '文件未找到或无法读取。';
        // All other errors fall through to generic message
    } catch (_) { /* cross-origin — suppress */ }
    return null;
}

// ============================================
// Tab Drag-and-Drop Reorder
// ============================================
let _dragTab = null;

function initTabDragDrop() {
    const strip = $('tab-strip');
    strip.addEventListener('dragstart', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        _dragTab = tab;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tabs.indexOf(tab).toString());
    });
    strip.addEventListener('dragend', e => {
        if (_dragTab) { _dragTab.classList.remove('dragging'); _dragTab = null; }
    });
    strip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const afterTab = getDragTargetTab(e);
        if (afterTab && afterTab !== _dragTab) {
            const fromIdx = tabs.indexOf(_dragTab);
            const toIdx = tabs.indexOf(afterTab);
            if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                tabs.splice(fromIdx, 1);
                const insertAt = tabs.indexOf(afterTab);
                tabs.splice(insertAt, 0, _dragTab);
                strip.insertBefore(_dragTab, afterTab);
                updateTabWidths();
            }
        }
    });
    strip.addEventListener('dragover', e => e.preventDefault());
}

function getDragTargetTab(e) {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    return els.find(el => el.classList.contains('tab') && el !== _dragTab) || null;
}

// ============================================
// Event Delegation Handlers
// ============================================
function handleTabStripClick(e) {
    const tab = e.target.closest('.tab');
    if (tab && !e.target.closest('.tab-close')) {
        switchToTab(tab);
    }
}

function handleCloseTab(e) {
    const tab = e.detail?.tab;
    if (tab) closeTab(tab);
}

function handlePageContextMenu(e) {
    // Suppress native browser context menu and route through our overlay.
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
}

// URL bar right-click handler. Suppresses the browser's native text-field
// context menu and routes through our #context-menu panel with URL-bar
// specific items (cut/copy/paste/select-all/paste-and-go/clear).
//
// Focusing the input before showing the menu is important: the standard
// edit actions (undo/cut/copy/paste/select-all) reach document.execCommand
// which operates on the currently focused element. Without an explicit
// focus call, the browser's default "right-click focuses the input"
// behavior would be suppressed by our preventDefault() and the actions
// would silently no-op.
function handleUrlInputContextMenu(e) {
    e.preventDefault();
    const input = e.target && (e.target.id === 'url-input' ? e.target : e.target.closest?.('#url-input'));
    if (input && typeof input.focus === 'function') {
        try { input.focus(); } catch (_) {}
    }
    showContextMenu(e.clientX, e.clientY, {
        _urlInputContext: true,
        _inputEl: input,
    });
}

function handleUrlInputSearchEngine() {
    // Update placeholder in url-input
    const storedEngine = localStorage.getItem('ffSearchEngine') || 'google';
    const engine = SEARCH_ENGINES[storedEngine] || SEARCH_ENGINES.google;
    const urlInput = $('url-input');
    if (urlInput) {
        urlInput.placeholder = i18n.t('searchOrUrl').replace('{engine}', engine.name);
    }

    // Set favicon on the search engine button from localStorage
    (function updateSearchEngineBtn() {
        const btn = $('search-engine-btn');
        if (btn) {
            const icon = btn.querySelector('.se-btn-icon');
            if (icon) icon.style.backgroundImage = `url(${engine.favicon})`;
        }
    })();
}

function handleTabGridClick(e) {
    const closeBtn = e.target.closest('.tab-card-close');
    if (closeBtn) {
        e.stopPropagation();
        const index = parseInt(closeBtn.dataset.index);
        if (tabs[index]) closeTab(tabs[index]);
        return;
    }
    const card = e.target.closest('.tab-card');
    if (card) {
        const index = parseInt(card.dataset.index);
        if (tabs[index]) {
            switchToTab(tabs[index]);
        }
    }
}

function openNewWindow() {
    if (is_pwaos) {
        pwaos_.appManager.getCurrentAppID().then(function(value) {
            pwaos_.windowManager.getWindowBounds(value.appId).then(function(value) {
                let rect = value.rect;
                pwaos_.appManager.launchApp(pwaos.AppType.kBrowser, window.location.toString(), rect, null, null)
                    .then(function(value) {
                        if (value.app != null) {
                            pwaos_.windowManager.maximize(value.app.id);
                        }
                        else
                            console.log("launchApp failed!");
                    }).catch(function(err) {
                        console.error(err);
                    });
            }).catch(function(err) {
                console.error(err);
            });
        }).catch(function(err) {
            console.error(err);
        });
    } else {
        // Standalone browser mode can't spawn a real window — surface a friendly hint.
        showToast(i18n.t('openInNewWindowTip'), 'info', 3500);
    }
}

function handleAppMenuClick(e) {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const action = item.dataset.action;
    hideAppMenu();
    switch (action) {
        case 'new-tab':
            addTab();
            break;
        case 'new-window':
            openNewWindow();
            break;
        case 'bookmarks':
            openInternalPage('library.html?bookmarks=1');
            break;
        case 'history':
            openInternalPage('library.html?history=1');
            break;
        case 'downloads':
            openInternalPage('library.html?downloads=1');
            break;
        case 'settings':
            openSettingsPage();
            break;
        case 'about':
            openAboutDialog();
            break;
        case 'developer':
            openDeveloperTools();
            break;
        case 'quit':
            try {
                pwaos_.appManager.getCurrentAppID().then(function(value) {
                    saveSession();
                    pwaos_.appManager.closeApp(value.appId);
                });
            } catch(_) { window.close(); }
            
            break;
        default:
            // Unknown action — surface so we know about it during dev.
            console.warn('[menu] unhandled action:', action);
    }
}

function openSettingsPage() {
    const dirPath = window.location.protocol + "//" + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
    // Pass the resolved theme as a query param — same as loadSpecialPage
    // does for newtab.html — so settings.html paints with the right theme
    // immediately on load without waiting for the postMessage race.
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const settings_url = dirPath + 'settings.html?theme=' + theme;

    // Open advanced settings in a new tab
    if (currentTab?.app_id)
        addTab(settings_url);
    else
        $('webappgroup').loadInternalPage(settings_url);
}

function openInternalPage(url) {
    // Resolve relative to the current page so 'library.html' works from
    // any subdirectory the browser shell might be hosted from.
    const base = window.location.protocol + "//" +
        window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
    const target = url.startsWith('http') ? url : (base + url);
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const target_url = target + '&theme=' + theme;

    // PWA apps live inside their own iframe — open as a real tab there.
    if (currentTab?.app_id)
        addTab(target_url);
    else
        $('webappgroup').loadInternalPage(target_url);
}

function openDeveloperTools() {
    if (is_pwaos && currentTab?.app_id && $('webappgroup').debugApp) {
        $('webappgroup').debugApp(currentTab.app_id);
        return;
    }
    // Fallback: surface a hint — F12 / right-click → Inspect work natively in the PWA.
    showToast(i18n.t('devToolsNote'), 'info', 4000);
}

function openAboutDialog() {
    const version = '1.0.0'; // Could be read from manifest.json
    window.alert(`${i18n.t('appName')} v${version}\n\n${i18n.t('aboutDescription')}`);
}

function handleSidebarToolbarClick(e) {
    const tab = e.target.closest('.sidebar-tab');
    if (tab) switchSidebarView(tab.dataset.view);
}

// Right-click context menu for sidebar items (bookmarks, history, downloads)
async function handleSidebarContextMenu(e) {
    const item = e.target.closest('.sidebar-item');
    if (!item) return;
    e.preventDefault();
    const url = item.dataset.url;
    const title = item.querySelector('.sidebar-item-title')?.textContent || url;
    const isBookmarks = currentSidebarView === 'bookmarks';
    const isHistory = currentSidebarView === 'history';
    const isDownloads = currentSidebarView === 'downloads';

    // Build params for buildContextMenu to create sidebar context menu
    const params = {
        _sidebarContext: true,
        _sidebarView: currentSidebarView,
        _bookmarkItem: item,
        _bookmarkUrl: url,
        _bookmarkTitle: title
    };

    // Show the context menu at the click position
    showContextMenu(e.clientX, e.clientY, params);
}

// Render sidebar content (bookmarks/history/downloads)
function switchSidebarView(view) {
    currentSidebarView = view;
    $('sidebar').querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
    });
    const titles = { bookmarks: '书签', history: '历史记录', downloads: '下载' };
    $('sidebar').querySelector('#sidebar-title').textContent = titles[view] || '书签';
    // Clear search when switching views
    const searchInput = $('sidebar-search-input');
    if (searchInput) searchInput.value = '';
    showSidebarContent(view, '');
}

async function showSidebarContent(view, query = '') {
    loadBookmarks();
    const content = $('sidebar-content');
    let html = '';
    const q = (query || '').toLowerCase().trim();

    if (view === 'bookmarks') {
        // Apply search filter
        let filtered = bookmarks;
        if (q) {
            filtered = bookmarks.filter(b =>
                b.title.toLowerCase().includes(q) ||
                b.url.toLowerCase().includes(q)
            );
        }
        if (filtered.length === 0) {
            html = q
                ? `<div style="padding:40px;text-align:center;color:var(--text-tertiary)">未找到匹配「${query}」的书签</div>`
                : '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">暂无书签</div>';
        } else {
            // Render as a collapsible tree: root bookmarks stay direct
            // .sidebar-item rows; folders build a nested tree via
            // getBookmarkFolderTree() — same "/"-hierarchy as the bar
            // dropdowns and the library tree. Search filters apply before
            // rendering: a branch renders only when it or a descendant
            // holds a matching bookmark.
            const tree = getBookmarkFolderTree();
            const rootBookmarks = filtered.filter(b => !b.folder);
            const getFavicon = (url) => {
                try {
                    const u = new URL(url);
                    return faviconUrl(u.hostname);
                } catch { return ''; }
            };
            const renderItem = (b) => `
                <div class="sidebar-item" data-url="${b.url}">
                    <img class="sidebar-item-icon" src="${getFavicon(b.url)}" alt="" onerror="this.style.display='none'">
                    <span class="sidebar-item-title">${b.title}</span>
                    <button class="sidebar-item-action icon-btn" data-action="edit" data-url="${b.url}" title="编辑">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="sidebar-item-action icon-btn" data-action="delete" data-url="${b.url}" title="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>`;
            if (rootBookmarks.length > 0) {
                html += rootBookmarks.map(renderItem).join('');
            }
            const renderFolder = (path, depth) => {
                const node = tree.get(path);
                if (!node) return { html: '', count: 0 };
                const direct = node.items.filter(b => filtered.includes(b));
                let count = direct.length;
                let inner = direct.map(renderItem).join('');
                for (const p of node.children) {
                    const sub = renderFolder(p, depth + 1);
                    if (!sub.html) continue;
                    inner += sub.html;
                    count += sub.count;
                }
                if (count === 0) return { html: '', count: 0 };
                return {
                    html: `
                <div class="sidebar-tree-node" data-folder="${bookmarksEscapeAttr(path)}">
                    <div class="sidebar-tree-toggle" tabindex="0" role="button" aria-expanded="true">
                        <svg class="sidebar-tree-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></svg>
                        <svg class="sidebar-tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></svg>
                        <span class="sidebar-tree-name">${bookmarksEscapeAttr(node.name)}</span>
                        <span class="sidebar-tree-count">${count}</span>
                    </div>
                    <div class="sidebar-tree-children">${inner}</div>
                </div>
                    `,
                    count
                };
            };
            for (const p of tree.get('').children) {
                html += renderFolder(p, 0).html;
            }
        }
    } else if (view === 'history') {
        let entries = await getHistoryEntries();
        if (q) {
            entries = entries.filter(e =>
                (e.title || '').toLowerCase().includes(q) ||
                e.url.toLowerCase().includes(q)
            );
        }
        if (entries.length === 0) {
            html = q
                ? `<div style="padding:40px;text-align:center;color:var(--text-tertiary)">未找到匹配「${query}」的历史记录</div>`
                : '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">暂无历史记录</div>';
        } else {
            const groups = groupHistoryByDate(entries);
            const getFavicon = (url) => {
                try {
                    const u = new URL(url);
                    return faviconUrl(u.hostname);
                } catch { return ''; }
            };
            const renderItem = (e) => `
                <div class="sidebar-item" data-url="${e.url}">
                    <img class="sidebar-item-icon" src="${getFavicon(e.url)}" alt="" onerror="this.style.display='none'">
                    <span class="sidebar-item-title">${e.title || e.url}</span>
                </div>`;
            for (const [label, items] of Object.entries(groups)) {
                html += `<div class="sidebar-folder-header">🕐 ${label}</div>`;
                html += items.map(renderItem).join('');
            }
        }
    } else if (view === 'downloads') {
        if (!downloads.length) {
            html = '<div style="padding:40px;text-align:center;color:var(--text-tertiary)">暂无下载</div>';
        } else {
            const getFavicon = (url) => {
                try {
                    const u = new URL(url);
                    return faviconUrl(u.hostname);
                } catch { return ''; }
            };
            const renderDL = (d) => `
                <div class="sidebar-item" data-download-id="${d.id}" data-url="${d.url}" data-action="download-item">
                    <img class="sidebar-item-icon" src="${getFavicon(d.url)}" alt="" onerror="this.style.display='none'">
                    <div class="sidebar-item-text">
                        <div class="sidebar-item-title">${d.filename}</div>
                        <div class="sidebar-item-meta">${d.completed ? '✓ 完成' : '下载中…'} · ${new Date(d.timestamp).toLocaleString('zh-CN')}</div>
                    </div>
                    <button class="icon-btn dl-remove" data-download-remove="${d.id}" title="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                    </button>
                </div>`;
            html = '<div class="sidebar-list">' + downloads.map(renderDL).join('') + '</div>';
        }
    }

    content.innerHTML = html;
}

function toggleSidebar() {
    const sb = $('sidebar');
    const resizer = $('sidebar-resizer');
    if (sb.classList.contains('visible')) {
        sb.classList.remove('visible');
        sb.hidden = true;
        if (resizer) { resizer.classList.remove('visible'); resizer.hidden = true; }
    } else {
        switchSidebarView('bookmarks');
        sb.classList.add('visible');
        sb.hidden = false;
        if (resizer) { resizer.classList.add('visible'); resizer.hidden = false; }
    }
}

function handleSidebarClick(e) {
    // Sidebar close button (data-action="close-sidebar")
    if (e.target.closest('[data-action="close-sidebar"]')) {
        $('sidebar').classList.remove('visible');
        return;
    }
    // Inline action buttons on sidebar items (the ✏ edit and ✕ delete
    // buttons rendered inside each .sidebar-item). Dispatch by the
    // button's data-action and data-url, matching the per-view context.
    const actionBtn = e.target.closest('.sidebar-item-action');
    if (actionBtn) {
        const action = actionBtn.dataset.action;
        const url = actionBtn.dataset.url;
        if (action === 'delete') {
            // Destructive — confirm before removing. Use the same
            // confirm flow as the right-click context menu so the two
            // entry points behave identically.
            e.stopPropagation();
            e.preventDefault();
            if (currentSidebarView === 'bookmarks' && url) deleteBookmark(url);
            else if (currentSidebarView === 'history' && url) deleteHistoryEntry(url);
            else if (currentSidebarView === 'downloads' && url) removeDownload(url);
            return;
        }
        if (action === 'edit' && url && currentSidebarView === 'bookmarks') {
            e.stopPropagation();
            e.preventDefault();
            editBookmark(url);
            return;
        }
        // Unknown action on a sidebar item — let the existing early-return
        // fall through and ignore.
        return;
    }
    // Collapsible tree folder rows (bookmarks view) — toggle the branch
    // BEFORE the .sidebar-item closest-check so a click on a folder row
    // can't fall through into a nested bookmark item.
    const treeToggle = e.target.closest('.sidebar-tree-toggle');
    if (treeToggle && toggleSidebarTreeFolder(treeToggle)) return;

    // Handle sidebar-item clicks (bookmarks, history, downloads)
    const item = e.target.closest('.sidebar-item');
    if (item) {
        const url = item.dataset.url;
        if (url) {
            if (!currentTab.app_id)
                navigateToUrl(url);
            else
                addTab(url);
        }
        return;
    }
}

// Toggle a sidebar tree folder branch open/closed. aria-expanded stays
// the source of truth; the children display is only ever toggled via JS
// so the inline style (padding-left per level) stays authoritative.
// Returns true when a branch was actually toggled.
function toggleSidebarTreeFolder(toggle) {
    const node = toggle.closest('.sidebar-tree-node');
    if (!node) return false;
    const children = node.querySelector(':scope > .sidebar-tree-children');
    if (!children) return false;
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    children.style.display = expanded ? 'none' : '';
    return true;
}

// Dispatch a context-menu action. Reads the data-* attributes that
// buildContextMenu wrote onto the .context-item and dispatches to the
// right helper. Keeps the action surface thin: anything we don't know
// about logs once and bails (so a typo'd action key can't silently
// swallow a click).
function handleContextMenuClick(e) {
    const item = e.target.closest('.context-item');
    if (!item || item.disabled || item.classList.contains('disabled')) return;
    const action = item.dataset.action;
    if (!action) return;

    const p = window._contextParams || {};
    const url = item.dataset.url || p.link_url || p.src_url || p.page_url || currentTab?._url || '';
    const selection = item.dataset.selection || p.selection_text || '';
    const title = item.dataset.title || currentTab?._title || url;

    // The context menu is rendered via menu.innerHTML = ..., which
    // serializes tab references down to a data-tab-id attribute only.
    // Re-resolve the live tab element here so action handlers (which
    // read item.tab) get a real object instead of undefined. Without
    // this, every tab-* action (tab-pin, tab-unpin, tab-close,
    // tab-duplicate, tab-mute, tab-close-others, tab-ungroup,
    // tab-add-to-group, tab-create-group) silently no-ops because
    // item.tab is never set on the button DOM element.
    if (item.dataset.tabId && !item.tab) {
        const id = parseInt(item.dataset.tabId, 10);
        if (!Number.isNaN(id)) {
            item.tab = tabs.find(t => t._id === id) || null;
        }
    }

    // Run the action, then hide. Errors are toasted but never block hide.
    Promise.resolve(runContextAction(action, { url, selection, title, p, item }))
        .catch(err => {
            console.warn('[context-menu]', action, err);
            showToast(i18n.t('operationFailed') || '操作失败', 'error', 2200);
        })
        .finally(() => hideContextMenu());
}

function runContextAction(action, { url, selection, title, p, item }) {
    switch (action) {
        // Navigation
        case 'back':                goBack(); return;
        case 'forward':             goForward(); return;
        case 'reload':              toggleReload(); return;

        // Link actions
        case 'open-link-new-tab':   if (url) addTab(url); return;
        case 'open-link-new-window':
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
            else showToast(i18n.t('openInNewWindowTip'), 'info', 3500);
            return;
        case 'open-link-incognito':
            if (is_pwaos) {
                addTab();
                showToast(i18n.t('privateTabOpened'), 'success', 2500);
            } else {
                showToast(i18n.t('privateBrowsingNote'), 'info', 3000);
            }
            return;
        case 'copy-link':           copyToClipboard(url); showToast(i18n.t('linkCopied'), 'success', 1500); return;
        case 'copy-link-text':      copyToClipboard(selection); showToast(i18n.t('copied'), 'success', 1500); return;
        case 'save-link-as':        downloadUrl(url, filenameFromUrl(url, '.html')); return;
        case 'bookmark-link':       addBookmark(url, title); return;

        // Image actions
        case 'open-image-new-tab':  if (url) addTab(url); return;
        case 'copy-image':          copyImageToClipboard(url).then(
                                       ok => showToast(ok ? i18n.t('copied') : i18n.t('operationFailed'),
                                                       ok ? 'success' : 'error', 1800)
                                   ); return;
        case 'copy-image-url':      copyToClipboard(url); showToast(i18n.t('copyImageAddress'), 'success', 1500); return;
        case 'save-image':          downloadUrl(url, filenameFromUrl(url)); return;

        // Media actions
        case 'toggle-media-play':   toggleMediaInActiveWebview('play'); return;
        case 'toggle-media-mute':   toggleMediaInActiveWebview('mute'); return;
        case 'pip-media':           toggleMediaInActiveWebview('pip'); return;
        case 'copy-media-url':      copyToClipboard(url); showToast(i18n.t('copied'), 'success', 1500); return;
        case 'save-media':          downloadUrl(url, filenameFromUrl(url)); return;

        // Selection actions
        case 'search-selection':    navigateToUrl(buildSearchUrl(selection)); return;
        case 'translate-selection': navigateToUrl('https://translate.google.com/?text=' + encodeURIComponent(selection)); return;
        case 'copy-selection':      copyToClipboard(selection); showToast(i18n.t('copied'), 'success', 1500); return;

        // Editable field actions — exec on the active element via the iframe.
        case 'undo':                execInActiveWebview('undo'); return;
        case 'redo':                execInActiveWebview('redo'); return;
        case 'cut':                 execInActiveWebview('cut'); return;
        case 'copy':                execInActiveWebview('copy'); return;
        case 'paste':               execInActiveWebview('paste'); return;
        case 'paste-plain':         execInActiveWebview('paste'); pastePlainInActiveWebview(); return;
        case 'select-all':          execInActiveWebview('selectAll'); return;
        case 'spell-check':         toggleSpellCheckInActiveWebview(); return;

        // Page actions
        case 'copy-page-url':       copyToClipboard(currentTab?._url || url); showToast(i18n.t('linkCopied'), 'success', 1500); return;
        case 'bookmark-page':       toggleBookmark(); return;
        case 'view-source':         openPageSource(); return;
        case 'inspect':
            if (is_pwaos && currentTab?.app_id && $('webappgroup').debugApp) {
                $('webappgroup').debugApp(currentTab.app_id);
            } else {
                showToast(i18n.t('devToolsNote'), 'info', 4000);
            }
            return;
        case 'clear-history':       clearAllHistory(); return;

        // URL bar context menu actions — operate on the chrome's
        // #url-input. The standard edit cases (undo/cut/copy/paste/
        // select-all) are handled above via execInActiveWebview and
        // will work because right-clicking the input focuses it; the
        // two below need explicit handling because they're URL-bar
        // specific.
        case 'url-paste-and-go':    urlPasteAndGo(); return;
        case 'url-clear-url':       { const i = $('url-input'); if (i) { i.value = ''; i.focus(); } return; }

        // Tab strip context menu actions
        case 'tab-close':         closeTab(item.tab); return;
        case 'tab-close-others':  tabs.filter(t => t !== item.tab).forEach(t => closeTab(t)); return;
        case 'tab-duplicate':     if (item.tab._url) addTab(item.tab._url); return;
        case 'tab-mute':          toggleMute(item.tab); return;

        // Fullscreen toggle — accessible from the tab-strip context menu
        // alongside the tab-specific actions. Delegates to the shared
        // Fullscreen module so state, immersive mode, and toast all
        // stay in sync with F11 / the menu-bar 全屏模式 entry.
        case 'toggle-fullscreen':  window.Fullscreen?.toggle?.(); return;

        // Sidebar bookmark context menu actions
        // Note: we deliberately do NOT auto-close the sidebar after any of
        // these. The user explicitly chose an action from the sidebar —
        // they may want to use it again to navigate to another bookmark
        // without re-opening. The sidebar only closes via the explicit
        // close button (data-action="close-sidebar") or via Ctrl+B toggle.
        case 'sidebar-open-current':  navigateToUrl(item.dataset.url); return;
        case 'sidebar-open-new':      addTab(item.dataset.url); return;
        case 'sidebar-edit':          editBookmark(item.dataset.url); return;
        case 'sidebar-delete':        deleteBookmark(item.dataset.url); return;
        case 'sidebar-copy-url':      copyToClipboard(item.dataset.url); showToast(i18n.t('linkCopied') || '链接已复制', 'success', 1500); return;
        case 'sidebar-delete-history': deleteHistoryEntry(item.dataset.url); if (currentSidebarView === 'history') showSidebarContent('history'); return;
        case 'sidebar-open-download':  return; // no-op for now
        case 'sidebar-remove-download': return; // no-op for now

        // Bookmarks bar — hide the bar and persist the state so it
        // stays hidden across reloads (restored by initBookmarksBar).
        case 'hide-bookmarks-bar':
            const bar = document.getElementById('bookmarks-bar');
            if (bar) bar.style.display = 'none';
            try { localStorage.setItem('ffBookmarksBar', 'hidden'); } catch(_) {}
            return;
        case 'show-bookmarks-bar':
            const sb = document.getElementById('bookmarks-bar');
            if (sb) sb.style.display = '';
            try { localStorage.setItem('ffBookmarksBar', 'visible'); } catch(_) {}
            return;

        default:
            console.warn('[context-menu] unhandled action:', action);
    }
}

// --- helpers used by runContextAction ---

function copyToClipboard(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch { return false; }
}

// Fetch an image as a Blob and write it to the clipboard via ClipboardItem.
// Falls back to copying the URL if the browser doesn't support image clipboard.
async function copyImageToClipboard(url) {
    if (!url) return false;
    if (!navigator.clipboard?.write || !window.ClipboardItem) {
        copyToClipboard(url);
        return true;
    }
    try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        const blob = await res.blob();
        if (!blob.type.startsWith('image/')) throw new Error('not image');
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return true;
    } catch {
        copyToClipboard(url);
        return true;
    }
}

function downloadUrl(url, filename) {
    if (!url) return;
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || '';
        a.rel = 'noopener';
        // Same-origin / data: can be set directly. Cross-origin needs
        // target=_blank fallback (browsers ignore `download` attribute).
        a.target = url.startsWith('data:') || url.startsWith('blob:') ? '_self' : '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        console.warn('[context-menu] download failed', err);
    }
}

function filenameFromUrl(url, fallbackExt = '') {
    try {
        const u = new URL(url, location.href);
        const last = u.pathname.split('/').filter(Boolean).pop() || '';
        if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
        if (last) return last + fallbackExt;
        return (u.hostname || 'download') + fallbackExt;
    } catch {
        return 'download' + fallbackExt;
    }
}

// Run a media command inside the currently-focused webview. We try to
// reach into the webapp's iframe contentDocument; if it's cross-origin
// or unavailable, we fall back to dispatching a custom event the
// webview can listen to.
function toggleMediaInActiveWebview(cmd) {
    const target = resolveActiveMediaTarget();
    if (!target) {
        showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
        return;
    }
    const el = target.video || target.audio;
    if (!el) {
        showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
        return;
    }
    if (cmd === 'play') {
        if (el.paused) el.play().catch(() => {});
        else el.pause();
    } else if (cmd === 'mute') {
        el.muted = !el.muted;
    } else if (cmd === 'pip') {
        if (document.pictureInPictureElement === el) {
            document.exitPictureInPicture().catch(() => {});
        } else if (el.requestPictureInPicture) {
            el.requestPictureInPicture().catch(() => {});
        }
    }
}

function resolveActiveMediaTarget() {
    // 1) cached right-clicked element (from buildContextMenu stash)
    const stashed = window._contextStash;
    if (stashed && (stashed.video || stashed.audio)) return stashed;
    // 2) attempt to find first <video>/<audio> in same-origin webview
    const webview = document.querySelector('webappgroup') || document.querySelector('iframe');
    if (webview && webview.contentDocument) {
        const v = webview.contentDocument.querySelector('video, audio');
        if (v) return { video: v.tagName === 'VIDEO' ? v : null, audio: v.tagName === 'AUDIO' ? v : null };
    }
    return null;
}

function execInActiveWebview(cmd, opts = {}) {
    // execCommand was removed from the spec but still works in Blink/WebKit
    // for editable surfaces; we use it for the legacy shortcut set and
    // log a hint for anything that doesn't take effect.
    try {
        const ok = document.execCommand(cmd, false, opts.value || null);
        if (!ok) showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
    } catch {
        showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
    }
}

// Paste the clipboard into the URL bar and navigate to the resulting
// value. Used by the "粘贴并前往" context-menu item on #url-input.
function urlPasteAndGo() {
    const input = $('url-input');
    if (!input) return;
    input.focus();
    // Place caret at end so paste replaces selection cleanly.
    try {
        const end = input.value.length;
        input.setSelectionRange(end, end);
    } catch (_) {}
    let pasted = false;
    try {
        pasted = document.execCommand('paste');
    } catch (_) {
        pasted = false;
    }
    // execCommand('paste') requires user-activation in some browsers
    // and is a no-op when triggered programmatically. Fall back to a
    // direct clipboard read so the action still does something useful.
    if (!pasted && navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(text => {
            if (typeof text === 'string' && text.length) {
                input.value = text;
                const value = input.value.trim();
                if (value) navigateToUrl(value);
            } else {
                showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
            }
        }).catch(() => {
            showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
        });
        return;
    }
    // Defer the navigation so the paste completes before we read .value.
    setTimeout(() => {
        const value = (input.value || '').trim();
        if (value) navigateToUrl(value);
    }, 0);
}

function toggleSpellCheckInActiveWebview() {
    const webview = document.querySelector('webappgroup') || document.querySelector('iframe');
    if (webview && webview.contentDocument) {
        const editable = webview.contentDocument.querySelector(
            'input, textarea, [contenteditable="true"]'
        );
        if (editable) {
            editable.spellcheck = !editable.spellcheck;
            showToast(editable.spellcheck ? '拼写检查：开' : '拼写检查：关', 'info', 1500);
            return;
        }
    }
    showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
}

// After pasting, defensively strip formatting from the inserted text.
// execCommand('paste') already inserts unstyled text in modern browsers
// when the clipboard carries plain text, but some pages still receive
// rich fragments — this strips inline styles / font / span wrappers.
function pastePlainInActiveWebview() {
    setTimeout(() => {
        const webview = document.querySelector('webappgroup') || document.querySelector('iframe');
        const doc = webview && webview.contentDocument;
        const ae = doc && doc.activeElement;
        if (!ae) return;
        ae.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
        ae.querySelectorAll('font, b, i, u, span, strong, em').forEach(n => {
            if (!n.attributes.length) {
                while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
                n.remove();
            }
        });
    }, 0);
}

function openPageSource() {
    const target = currentTab?._url || '';
    if (!target) {
        showToast(i18n.t('operationFailed') || '操作失败', 'error', 1800);
        return;
    }
    if (is_pwaos && currentTab?.app_id && $('webappgroup').viewSource) {
        $('webappgroup').viewSource(currentTab.app_id);
        return;
    }
    // Fallback: open source in a new tab using view-source: scheme.
    if (/^https?:\/\//i.test(target)) {
        addTab('view-source:' + target);
        return;
    }
    showToast(i18n.t('pageSourceUnavailable') || '页面源代码不可用', 'info', 2200);
}

// Insert a bookmark without going through the page dialog flow — used by
// the context menu so right-click → "add link to bookmarks" is one click.
// Add a bookmark. Optionally pass a target folder; if not, prompt
// the user (mirroring toggleBookmark's UX). Empty folder = root.
async function addBookmark(url, title, folder = '') {
    if (!url) return;
    const norm = (typeof normalizeBookmarkUrl === 'function')
        ? normalizeBookmarkUrl(url)
        : url;
    const existing = (bookmarks || []).findIndex(b =>
        (typeof normalizeBookmarkUrl === 'function')
            ? normalizeBookmarkUrl(b.url) === norm
            : b.url === norm
    );
    if (existing >= 0) {
        showToast(i18n.t('bookmarkAlreadyExists') || '书签已存在', 'info', 1500);
        return;
    }
    // Folder resolution. When the caller explicitly passed a folder
    // argument, use it directly (context-menu one-click path); the
    // default '' also skips the dialog — no prompt for a plain add.
    // Programmatic callers get a silent, deterministic store.
    (bookmarks || (bookmarks = [])).push({
        url,
        title: title || url,
        folder,
        addedAt: Date.now(),
    });
    localStorage.setItem('ffBookmarks', JSON.stringify(bookmarks));
    if (typeof BrowserSearchSuggest !== 'undefined' && BrowserSearchSuggest?.invalidate) {
        BrowserSearchSuggest.invalidate();
    }
    if ($('sidebar').classList.contains('visible') && currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
    window.dispatchEvent(new CustomEvent('bookmarks-changed'));
    showToast(i18n.t('bookmarkAdded') || '已添加书签', 'success', 1800);
}

function handleMenuOrPanelFocusOut(menu, event) {
    const next = event.relatedTarget;
    setTimeout(() => {
        if (!menu || menu.hidden) return;
        if (menu.contains(document.activeElement)) return;
        if (next && menu.contains(next)) return;
        if (menu == $('app-menu'))
            hideAppMenu();
        else if (menu == $('context-menu'))
            hideContextMenu();
        else if (menu == $('settings-panel'))
            Settings.close();
        else {
            console.log("unhandled menu is " + menu);
        }

    }, 0);
}

function handleOutsideClick(e) {
    const t = e.target;
    // Guard: document.dispatchEvent synthetic clicks have no Element target
    if (!t || typeof t.closest !== 'function') return;
    // App menu: hide if click is outside menu and its trigger
    // Includes #webappgroup (page content area) so clicking the page also closes it
    const appMenuTriggers = ['#app-menu', '#hamburger-btn', '#webappgroup'];
    if (!appMenuTriggers.some(sel => t.closest(sel))) hideAppMenu();

    // Context menu: hide if click is outside menu
    if (!t.closest('#context-menu')) hideContextMenu();

    // Bookmarks folder dropdown: hide if click is outside the dropdown,
    // its submenus, and the bar-folder trigger. Menu-item clicks are
    // handled by the dropdown's own document listener first (registered
    // in initBookmarksBar, which runs before this); by the time we get
    // here the panel state is already settled — we just close it.
    if (!t.closest('#bookmarks-dropdown') && !t.closest('.bm-submenu') && !t.closest('.bar-folder')) {
        closeBookmarksDropdown();
    }

    // Settings panel: hide if click outside panel + trigger
    if (!t.closest('#settings-panel') && !t.closest('#settings-btn')) {
        const sp = $('settings-panel');
        if (sp && !sp.hidden) sp.hidden = true;
    }

    // Command palette and page-info-panel close on blur — see
    // CommandPalette.open/close and PageInfo.open/close. Click-outside
    // was tried (commit 0c42f0f) but the selectors never matched the
    // actual IDs (`#command-palette` vs `#cmd-palette`) so the behavior
    // was silently dead. Blur is the correct semantic anyway since
    // these panels are focus traps.
}

// ============================================
// Tab Management
// ============================================
async function launchApp(url, sessionId) {
    const value = await $('webappgroup').createApp(url, sessionId);
    if (!value?.app?.id || !value?.app?.guestInstanceId){
        return null;
    }

    return value.app.id;
}
async function addTab(url = null) {
    // Default URL: settings.homepage (configurable in settings.html)
    // or 'newtab.html' as a hard fallback. Only applied when the
    // caller passes no explicit URL.
    if (!url) {
        if (!url) url = 'newtab.html';
    }
    const tabStrip = $('tab-strip');
    const tabAddBtn = $('tab-add-btn');
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.draggable = true;
    tab.innerHTML = `
        <svg class="tab-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 2l3 6 6 1-4 4 1 6-5-3-5 3 1-6-4-4 6-1z"/>
        </svg>
        <div class="tab-group-badge" aria-hidden="true"></div>
        <div class="tab-icon"></div>
        <span class="tab-title" data-i18n-title="newTabLabel" data-i18n="newTabLabel">新标签页</span>
        <button class="tab-close" data-i18n-aria="closeTab" aria-label="关闭标签页">×</button>
        <button class="tab-audio" data-i18n-aria="playingAudio" data-i18n-title="playingAudio" aria-label="正在播放音频" title="正在播放音频" style="display:none">🔊</button>
        <button class="tab-mute" data-i18n-aria="muteUnmute" data-i18n-title="mute" aria-label="静音/取消静音" title="静音" style="display:none">🔊</button>
    `;

    tab._title = url == "newtab.html" ? i18n.t('newTabLabel') : null;
    tab._url = url || '';
    tab._zoom = 1;
    tab._textZoom = 1;  // text-only zoom factor (Zoom Text Only)
    tab._muted = false;  // audio mute state
    tab._hasAudio = false;  // playing audio indicator
    tab._groupId = null;  // null = no group
    tab._id = nextTabId++;  // stable id for context-menu round-trip
    tab.app_id = null;

    tab.querySelector('.tab-close').addEventListener('click', e => {
        e.stopPropagation();
        closeTab(tab);
    }, { once: true });

    // Double-click on tab body → close
    tab.addEventListener('dblclick', e => {
        if (!e.target.closest('.tab-close')) {
            e.stopPropagation();
            closeTab(tab);
        }
    });

    // Middle mouse button → close
    tab.addEventListener('auxclick', e => {
        if (e.button === 1) { // Middle mouse
            e.preventDefault();
            e.stopPropagation();
            closeTab(tab);
        }
    });

    tab.querySelector('.tab-mute').addEventListener('click', e => {
        e.stopPropagation();
        toggleMute(tab);
    });
    updateMuteButton(tab);

    tabStrip.insertBefore(tab, tabAddBtn);
    tabs.push(tab);
    updateTabWidths();
    switchToTab(tab);

    if (_isSpecialPage(url)) {
        loadSpecialPage(url);
    } else {
        await navigateToUrl(url, tab);
    }

    return tab;
}

function closeTab(tab) {
    const index = tabs.indexOf(tab);
    if (index === -1) return;

    if (is_pwaos && tab.app_id) {
        $('webappgroup').closeApp(tab.app_id);
    }

    // Save closed tab state for Ctrl+Shift+T restore
    const closedTab = {
        _title: tab._title,
        _url: tab._url,
        _zoom: tab._zoom,
        _textZoom: tab._textZoom || 1,
        app_id: tab.app_id,
    };

    if (tab._title !== '新标签页' || tab._url) {
        recentlyClosedTabs.unshift(closedTab);
        if (recentlyClosedTabs.length > 20) recentlyClosedTabs.pop();
    }

    // Animate tab close: shrink + fade before DOM removal
    tab.classList.add('closing');
    tab.addEventListener('transitionend', () => tab.remove(), { once: true });
    setTimeout(() => { if (tab.parentNode) tab.remove(); }, 300);

    tabs.splice(index, 1);

    if (tabs.length === 0) {
        addTab();
    } else if (tab === currentTab) {
        const newIndex = Math.min(index, tabs.length - 1);
        switchToTab(tabs[newIndex]);
    }

    updateTabWidths();

    saveSession();
}

function switchToTab(tab) {
    if (tab == currentTab) return;
    if (currentTab) currentTab.classList.remove('active');
    tab.classList.add('active');
    currentTab = tab;

    // Scroll the newly-active tab into view (horizontal scroll)
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    syncTabStripScrollState();

    const webAppView = $('webappgroup');

    if (is_pwaos) {
        if (tab.app_id) {
            webAppView.curr_app_id = tab.app_id;
            pwaos_.appManager.getLoadingInfo(tab.app_id).then(v => updateTabFromInfo(tab.app_id, v.info));
        } else if (tab._url) {
            loadSpecialPage(tab._url);
        }

        updateUrlbarFromTab();
    } else {
        if (tab._url) webAppView.src = tab._url;
        const urlbar = $('url-input');
        if (urlbar) urlbar.value = tab._url || '';
    }

    updateNavigationButtons();
    updateBookmarkButton();
    applyZoom();
    applyTextZoom();
    syncZoomCluster();

    startTitleUpdateInterval();

    webAppView.focus();
}

// Sync scroll-edge shadow classes on tab-strip based on scroll position.
function syncTabStripScrollState() {
    const strip = $('tab-strip');
    if (!strip) return;
    strip.classList.toggle('scrolled-left', strip.scrollLeft > 0);
    strip.classList.toggle('scrolled-right', strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1);
}

// Also watch scroll events to update shadows in real time
document.addEventListener('DOMContentLoaded', () => {
    const strip = $('tab-strip');
    if (strip) strip.addEventListener('scroll', syncTabStripScrollState, { passive: true });
});

function updateTabWidths() {
    // No longer force equal widths — tab-strip now scrolls horizontally.
    // Just ensure min/max constraints are respected.
    const minW = 80;
    const maxW = 200;
    tabs.forEach(tab => {
        tab.style.minWidth = minW + 'px';
        tab.style.maxWidth = maxW + 'px';
        // Remove fixed width so natural size applies
        tab.style.width = '';
    });
    syncTabStripScrollState();
}

// ============================================
// Navigation
// ============================================
async function navigateToUrl(input, tab=currentTab) {
    if (!tab) return;
    const url = formatUrl(input);
    tab._url = url;

    const webAppView = $('webappgroup');
    if (is_pwaos) {
        const result = await webAppView.loadUrl(url, tab.app_id);
        if (result?.app?.id) {
            tab.app_id = result.app.id;
            if (tab == currentTab)
                webAppView.curr_app_id = tab.app_id;
        }

        startTitleUpdateInterval();
        updateReloadSpinner(true);
    } else {
        // Standalone: setting src triggers iframe load which hides the
        // placeholder automatically via the load listener in connectedCallback.
        webAppView.src = url;
    }

    // Update both URL bars
    $('url-input').value = getVisibleUrl(url);
    saveToHistory(url);

    if (tab == currentTab) {
        webAppView.focus();
        webAppView.curr_app_id = currentTab.app_id;
    }
}

function getVisibleUrl(url) {
    if (_isSpecialPage(url))
        return '';
    return url;
}

function formatUrl(input) {
    if (!input) return '';
    input = input.trim();
    if (/^https?:\/\//i.test(input)) return input;
    if (/^file:\/\//i.test(input)) return input;
    if (/^[^ ]+\.[^ ]+/.test(input)) return 'https://' + input;
    return getSearchEngine()?.baseUrl + encodeURIComponent(input);
}

function goBack() {
    if (!currentTab?.app_id) return;
    const webAppView = $('webappgroup');
    webAppView.goBack(currentTab.app_id).then(() => {
        startTitleUpdateInterval();

        if (!webAppView.curr_app_id)
            webAppView.curr_app_id = currentTab.app_id;
    });
}

function goForward() {
    if (!currentTab?.app_id) return;
    const webAppView = $('webappgroup');
    webAppView.goForward(currentTab.app_id).then(() => {
        startTitleUpdateInterval();

        if (!webAppView.curr_app_id)
            webAppView.curr_app_id = currentTab.app_id;
    });
}

function toggleReload() {
    const btn = $('reload-btn');
    if (btn && btn.classList.contains('reloading')) {
        // Currently loading — stop it
        stopCurrentLoad();
        return;
    }
    const wg = $('webappgroup');
    if (currentTab?.app_id) {
        wg.reload(currentTab.app_id).then(() => {
            if (!wg.curr_app_id)
                wg.curr_app_id = currentTab.app_id;
        });
    } else if (wg && typeof wg.reload === 'function') {
        try { wg.reload(); } catch (_) { /* no-op fallback */ }
    }
}

function stopCurrentLoad() {
    const wg = $('webappgroup');
    if (currentTab?.app_id && wg?.stop) {
        try { wg.stop(currentTab.app_id); } catch (_) {}
    } else if (wg?.stop) {
        try { wg.stop(); } catch (_) {}
    }
    // Immediately revert UI to refresh state
    updateReloadSpinner(false);
    wg.hideLoadingPlaceholder();
}

function goHome() {
    Settings.get('homepage').then(function(val) {
        navigateToUrl(val);
    }).catch(function(e) {navigateToUrl('http://www.pwaos.net');});
}

function loadSpecialPage(url) {
    const urlObj = new URL(url, document.baseURI);
    const path = urlObj.pathname;
    const fileName = path.split('/').pop();

    // Pass the resolved theme as a query param so newtab.html can apply it
    // immediately on load without waiting for the postMessage race.
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    // webappgroup expects a plain path; standalone uses src= so we need a
    // tiny shim.  webappgroup.loadNewTabPage() is the canonical entry point
    // and it sets _iframe.src / this.src — both handle query params fine.
    const wg = $('webappgroup');
    wg.loadInternalPage(fileName + '?theme=' + theme);

    // Auto-focus address bar on startup (browser standard behavior)
    requestAnimationFrame(() => $('url-input')?.focus());
}

// Move keyboard focus to the webapp/webview so page shortcuts (Esc, arrows, etc.)
// go to the rendered page instead of the URL bar after navigation.
function focusWebappGroup() {
    $('webappgroup').focus();
}

// ============================================
// URL Bar Handlers
// ============================================
function handleUrlbarKeydown(e) {
    const panel = $('suggestions-url-panel');

    // Delegate ArrowUp/Down/Enter to suggestions-url-panel when it's open
    if (!panel?.hidden && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
        SuggestionsUrlPanel.handleKeydown(e);
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        const input = e.target.value.trim();

        // 处理 ENS 域名/地址
        if (typeof ENSResolver !== 'undefined') {
            ENSResolver.processInput(input).then(result => {
                if (result.type === 'ens') {
                    // ENS 域名解析成功 -> 访问解析后的地址
                    showToast(`${result.ens} → ${ENSResolver.formatAddress(result.address)}`, 'info', 3000);
                    navigateToUrl('https://etherscan.io/address/' + result.address);
                } else if (result.type === 'address' && result.ens) {
                    // 地址有 ENS 名称 -> 显示
                    showToast(`${result.ens}`, 'info', 2000);
                    navigateToUrl('https://etherscan.io/address/' + result.address);
                } else {
                    // 普通 URL/搜索
                    navigateToUrl(result.value);
                }
                focusWebappGroup();
            }).catch(() => {
                navigateToUrl(input);
                focusWebappGroup();
            });
        } else {
            navigateToUrl(input);
            focusWebappGroup();
        }

        SuggestionsUrlPanel.close();
        clearTimeout(handleUrlbarInput._timer);
    } else if (e.key === 'Escape') {
        SuggestionsUrlPanel.close();
        hideContextMenu();
        e.target.blur();
    }
}

function handleUrlbarInput(e) {
    const val = e.target.value.trim();
    clearTimeout(handleUrlbarInput._timer);

    // Show search-engine-select only when input is non-empty and not a valid URL
    const wrapper = $('search-engine-select')?.parentElement;
    if (wrapper) {
        const isUrl = val.length > 0 && (/^https?:\/\//i.test(val) || /^file:\/\//i.test(val) || /^[^ ]+\.[^ ]+/.test(val));
        wrapper.classList.toggle('visible', !isUrl);
    }

    if (val.length > 0) {
        handleUrlbarInput._timer = setTimeout(function() {
            if (document.activeElement === document.getElementById('url-input'))
                SuggestionsUrlPanel.open(val);
        }, 120);
    } else {
        SuggestionsUrlPanel.open('');
    }
}

function _isSpecialPage(url) {
    return $('webappgroup').isSpecialPage(url);
}

function updateUrlbarFromTab() {
    const url = currentTab?._url || '';
    const isSpecial = _isSpecialPage(url);
    const display = getVisibleUrl(url);
    $('url-input').value = display;
    updateNavigationButtons();
    updateIdentityBox(isSpecial ? '' : url);
    updateBookmarkButton();
}

function updateNavigationButtons() {
    const update = (canGoBack, canGoForward, canReload) => {
        $('back-btn').disabled = !canGoBack;
        $('forward-btn').disabled = !canGoForward;
        $('reload-btn').disabled = !canReload;
    };

    if (is_pwaos && currentTab?.app_id) {
        pwaos_.appManager.getLoadingInfo(currentTab.app_id).then(v => update(v.info.canGoBack, v.info.canGoForward, true));
    } else {
        update(false, false, false);
    }
}

function updateIdentityBox(url) {
    const icons = { https: '🔒', http: '⚠️', default: '🌐' };
    const icon = url?.startsWith('https://') ? icons.https :
                 url?.startsWith('http://') ? icons.http : icons.default;

    // url-icon is now a <button> with two stacked slots: a glyph (lock/warn/globe)
    // and a favicon layer. Tabs without a known favicon show only the glyph.
    $('url-icon-glyph').textContent = icon;

    const favEl = $('url-icon-favicon');
    if (!favEl) return;

    favEl.style.backgroundImage = '';
    favEl.style.display = 'none';
}

// ============================================
// Title Updates
// ============================================
function startTitleUpdateInterval() {
    if (titleUpdateInterval) {
        clearInterval(titleUpdateInterval);
        titleUpdateInterval = null;
    }

    if (currentTab)
        currentTab.loadingInfo = null;

    titleUpdateInterval = setInterval(() => {
        let bNeedUpdateTitle = false;
        for (const tab of tabs) {
            if (!tab?.app_id) continue;

            if(!tab.loadingInfo || !tab.loadingInfo.title ||
                (currentTab?.app_id == tab.app_id && tab.loadingInfo && tab.loadingInfo.progress != 1)) {
                pwaos_.appManager.getLoadingInfo(tab.app_id).then(v => updateTabFromInfo(tab.app_id, v.info));
                bNeedUpdateTitle = true;
            }
        }

        if (!bNeedUpdateTitle) {
            clearInterval(titleUpdateInterval);
            titleUpdateInterval = null;
        }
    }, 1000);
}

function updateTabFromInfo(appId, info) {
    const tab = tabs.find(t => t.app_id === appId);
    if (!tab) return;

    if (info.progress > 0.3) {
        tab._title = info.title;
        tab._url = info.url;
        tab.querySelector('.tab-title').textContent = info.title || i18n.t('loading');
        tab.querySelector('.tab-title').title = info.title || i18n.t('loading');

        if (currentTab === tab) {
            if (document.activeElement != document.getElementById('url-input'))
                $('url-input').value = getVisibleUrl(info.url);
            updateReloadSpinner(false);
            updateNavigationButtons();
            updateIdentityBox(info.url);
        }

        if (info.faviconUrl) {
            const icon = tab.querySelector('.tab-icon');
            icon.style.backgroundImage = `url(${info.faviconUrl})`;
            icon.style.backgroundSize = 'cover';
        }

        if (info.progress === 1) {
            saveToHistory(info.url);
        }
    } else {
        if (currentTab === tab)
            updateReloadSpinner(true);
    }

    if (appId == currentTab.app_id && info.firstLoad) {
        $('webappgroup').hideLoadingPlaceholder();
        if (!$('webappgroup').curr_app_id) {
            pwaos_.appManager.getAppInfo(appId).then(value => {
                if (value.info.status == pwaos.AppStatus.kSynchronized) {
                    $('webappgroup').curr_app_id = appId;
                    saveSession();
                }
            });
        }
    }

    tab.loadingInfo = info;
    tab.sessionId = info.sessionId;
}

// Standalone-mode title/url updater — called from the iframe 'load' bridge
// in initBrowser(). Mirrors updateTabFromInfo but without the progress>0.3
// gate (standalone mode always reports progress=1 on load) and with a
// fixed-tab target rather than appId lookup (standalone has no app IDs).
function updateTabFromInfoStandalone(tab, info) {
    if (!tab || !info) return;
    tab._title = info.title;
    tab._url = info.url || tab._url;
    const titleEl = tab.querySelector('.tab-title');
    if (titleEl) {
        titleEl.textContent = tab._title || i18n.t('loading');
        titleEl.title = tab._title || i18n.t('loading');
    }

    if (currentTab === tab) {
        $('url-input').value = getVisibleUrl(tab._url);
        updateNavigationButtons();
        updateIdentityBox(tab._url);
    }

    if (info.faviconUrl) {
        const icon = tab.querySelector('.tab-icon');
        if (icon) {
            icon.style.backgroundImage = `url(${info.faviconUrl})`;
            icon.style.backgroundSize = 'cover';
        }
    }

    // Loaded → record history. (Spinner stop is handled separately by the
    // 'loadingchange' event the standalone element dispatches on iframe load,
    // which setupReloadAnimation already listens for.)
    saveToHistory(tab._url);
}

// ============================================
// Bookmarks
// ============================================
async function toggleBookmark() {
    const url = currentTab?._url || 'newtab:' + (currentTab?._title || 'new-tab');
    const norm = normalizeBookmarkUrl(url);

    const idx = bookmarks.findIndex(b => normalizeBookmarkUrl(b.url) === norm);
    const setStar = (btn, active) => {
        if (btn) {
            btn.classList.toggle('active', active);
            btn.querySelector('svg').style.fill = active ? 'var(--accent-primary)' : 'none';
        }
    };

    if (idx === -1) {
        // --- Add: ONE merged dialog — name input (pre-filled with the
        // page title) + folder tree. Name is required; empty name keeps
        // the dialog open. Cancel/Escape on the dialog adds nothing. ---
        const title = currentTab._title || url;
        const folder = await promptForFolder('', title);
        if (folder === null) return; // user cancelled the merged dialog
        const name = _bfpName;

        bookmarks.push({ url, title: name || title, folder, addedAt: Date.now() });
        setStar($('star-btn'), true);
        if ($('sidebar').classList.contains('visible') && currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
        showToast(i18n.t('bookmarkAdded2'), 'success', 2000);
    } else {
        // --- Remove: confirm (native window.confirm) ---
        if (!window.confirm(i18n.t('deleteBookmarkConfirm').replace('{title}', bookmarks[idx].title))) return;
        bookmarks.splice(idx, 1);
        setStar($('star-btn'), false);
        showToast(i18n.t('bookmarkDeleted'), 'info', 2000);
    }

    localStorage.setItem('ffBookmarks', JSON.stringify(bookmarks));
    BrowserSearchSuggest.invalidate();
    // Refresh open sidebar if showing bookmarks
    if (currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
    window.dispatchEvent(new CustomEvent('bookmarks-changed'));
}

// Get sorted unique list of bookmark folder names
function getBookmarkFolders() {
    const set = new Set();
    for (const b of bookmarks) {
        if (b.folder) set.add(b.folder);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
}

// Edit existing bookmark (name + folder) via native prompt
async function editBookmark(url) {
    const norm = normalizeBookmarkUrl(url);
    const idx = bookmarks.findIndex(b => normalizeBookmarkUrl(b.url) === norm);
    if (idx === -1) return;
    const b = bookmarks[idx];

    // ONE merged dialog — name input (pre-filled with the current name)
    // + folder tree (current folder preselected).
    const folder = await promptForFolder(b.folder || '', b.title);
    if (folder === null) return;          // user cancelled the merged dialog
    const name = _bfpName;

    bookmarks[idx] = { ...b, title: name || b.title, folder };
    localStorage.setItem('ffBookmarks', JSON.stringify(bookmarks));
    BrowserSearchSuggest.invalidate();
    if (currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
    window.dispatchEvent(new CustomEvent('bookmarks-changed'));
    showToast(i18n.t('bookmarkUpdated'), 'success', 2000);
}

// Delete bookmark with confirmation (native window.confirm)
async function deleteBookmark(url) {
    const norm = normalizeBookmarkUrl(url);
    const idx = bookmarks.findIndex(b => normalizeBookmarkUrl(b.url) === norm);
    if (idx === -1) return;
    if (!window.confirm(`删除书签「${bookmarks[idx].title}」？`)) return;
    bookmarks.splice(idx, 1);
    localStorage.setItem('ffBookmarks', JSON.stringify(bookmarks));
    BrowserSearchSuggest.invalidate();
    if (currentSidebarView === 'bookmarks') showSidebarContent('bookmarks');
    window.dispatchEvent(new CustomEvent('bookmarks-changed'));
    showToast(i18n.t('bookmarkDeleted'), 'info', 2000);
}

// Canonicalize URLs we compare for duplicate detection. We collapse
// trailing slashes, lower-case the host, and remove the default port
// (80/443) so that https://Example.com/path/ is treated as the same
// bookmark as https://example.com/path. Schemes we don't understand
// (about:, file:, newtab:, etc.) fall back to a direct string compare.
function normalizeBookmarkUrl(href) {
    if (!href) return '';
    try {
        if (href.startsWith('newtab:')) return href; // virtual space
        const u = new URL(href);
        let host = u.hostname.toLowerCase();
        // Drop default ports — they don't change identity.
        if ((u.protocol === 'https:' && u.port === '443') ||
            (u.protocol === 'http:'  && u.port === '80')) {
            u.port = '';
        }
        // Round-trip without trailing slash for non-root paths so that
        // /path and /path/ collapse to one normalized form.
        u.hostname = host;
        let out = u.toString();
        if (out.endsWith('/') && u.pathname !== '/' && !u.search && !u.hash) {
            out = out.slice(0, -1);
        }
        return out;
    } catch (_e) {
        // Not a parseable URL — fall back to a case-trimmed literal so
        // ABOUT:foo and About:foo still collide.
        return href.trim().toLowerCase();
    }
}

// One-shot migration: legacy bookmarks may be missing {addedAt} or
// normalized-key duplicates. Run before any UI render. Idempotent.
async function normalizeBookmarkStore() {
    let store = JSON.parse(await BrowserStorage.getItem('ffBookmarks') || '[]');
    if (!Array.isArray(store)) store = [];
    const seen = new Map();
    const migrated = [];
    for (const entry of store) {
        if (!entry || typeof entry.url !== 'string') continue;
        const key = normalizeBookmarkUrl(entry.url);
        if (!key) continue;
        if (seen.has(key)) continue; // drop duplicates during migration
        seen.set(key, true);
        migrated.push({
            url: entry.url,
            title: typeof entry.title === 'string' ? entry.title : entry.url,
            folder: typeof entry.folder === 'string' ? entry.folder : '',
            addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
        });
    }
    if (migrated.length !== store.length || migrated.some((m, i) =>
        store[i] && (store[i].addedAt === undefined ||
            typeof store[i].folder !== 'string' ||
            store[i].url !== m.url))) {
        await BrowserStorage.setItem('ffBookmarks', JSON.stringify(migrated));
    }
    return migrated;
}

function updateBookmarkButton() {
    const url = currentTab?._url;
    const norm = url ? normalizeBookmarkUrl(url) : '';
    const isMarked = Array.isArray(bookmarks) && bookmarks.some(b => normalizeBookmarkUrl(b.url) === norm);
    const setStar = (btn) => {
        if (btn) btn.classList.toggle('active', isMarked);
    };
    setStar($('star-btn'));
}

// ============================================
// History
// ============================================
// Pending history entry awaiting debounced localStorage flush.
// Memory state (`history` array) updates immediately so address-bar
// autocomplete stays responsive; the two JSON.stringify + localStorage
// writes (200-entry cap × 2) are coalesced via debounce to avoid
// blocking the main thread on every page navigation.
let _pendingHistoryEntries = null;
const _flushHistory = debounce(async () => {
    if (_pendingHistoryEntries) {
        await BrowserStorage.setItem('ffHistory', JSON.stringify(_pendingHistoryEntries.entries));
        await BrowserStorage.setItem('ffHistoryFlat', JSON.stringify(_pendingHistoryEntries.flat));
        _pendingHistoryEntries = null;
    }
}, 300);

async function saveToHistory(url) {
    if (!url || url.startsWith('about:')) return;
    if (_isSpecialPage(url)) return;
    const now = Date.now();
    const title = currentTab?._title || url;

    // New rich history model: array of {url, title, visitedAt}
    let entries = await getHistoryEntries();
    // Dedupe: remove existing entry with same URL, then prepend
    entries = entries.filter(e => e.url !== url);
    entries.unshift({ url, title, visitedAt: now });
    // Cap at 200 entries
    entries = entries.slice(0, 200);

    // Update in-memory flat array immediately so address-bar autocomplete
    // picks up the new entry without waiting for the debounced flush.
    const flat = entries.map(e => e.url);
    history = flat;
    BrowserSearchSuggest.invalidate();

    // Stage the localStorage write; debounce coalesces rapid successive
    // navigations (e.g. redirects, fast page transitions) into one flush.
    _pendingHistoryEntries = { entries, flat };
    _flushHistory();

    saveSession();
}

// Get rich history entries (with title + time)
async function getHistoryEntries() {
    const stored = await BrowserStorage.getItem('ffHistory');
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    // Migrate: if old format (array of strings), convert
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        const migrated = parsed.map((url, i) => ({
            url, title: url, visitedAt: Date.now() - i * 1000,
        }));
        await BrowserStorage.setItem('ffHistory', JSON.stringify(migrated));
        return migrated;
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(e => e && typeof e.url === 'string');
}

// Delete a single history entry
// Delete a single history entry with confirmation dialog
async function deleteHistoryEntry(url) {
    const entries = await getHistoryEntries();
    const entry = entries.find(e => e.url === url);
    const displayTitle = entry?.title || url;
    if (!window.confirm(i18n.t('deleteHistoryConfirm').replace('{title}', displayTitle))) return;
    const filtered = entries.filter(e => e.url !== url);
    await BrowserStorage.setItem('ffHistory', JSON.stringify(filtered));
    await BrowserStorage.setItem('ffHistoryFlat', JSON.stringify(filtered.map(e => e.url)));
    history = filtered.map(e => e.url);
    BrowserSearchSuggest.invalidate();
    if (currentSidebarView === 'history') showSidebarContent('history');
    showToast(i18n.t('historyDeleted'), 'info', 2000);
}

// Clear all history with confirmation (native window.confirm)
async function clearAllHistory() {
    if (!window.confirm(i18n.t('clearAllHistoryConfirm'))) return;
    await BrowserStorage.removeItem('ffHistory');
    await BrowserStorage.removeItem('ffHistoryFlat');
    await BrowserStorage.removeItem('ffRecent');
    history = [];
    BrowserSearchSuggest.invalidate();
    if (currentSidebarView === 'history') showSidebarContent('history');
    showToast(i18n.t('historyCleared2'), 'success', 2000);
}

// Format timestamp to relative time (e.g., "刚刚", "5分钟前", "2小时前", "3天前")
function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return Math.floor(diff / min) + '分钟前';
    if (diff < day) return Math.floor(diff / hour) + '小时前';
    if (diff < 7 * day) return Math.floor(diff / day) + '天前';
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// Group history entries by date label
function groupHistoryByDate(entries) {
    if (!Array.isArray(entries)) {
        console.warn('groupHistoryByDate: entries is not an array', entries);
        return {};
    }
    const groups = {};
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    for (const e of entries) {
        let label;
        if (e.visitedAt >= today) label = '今天';
        else if (e.visitedAt >= yesterday) label = '昨天';
        else {
            const d = new Date(e.visitedAt);
            label = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        }
        if (!groups[label]) groups[label] = [];
        groups[label].push(e);
    }
    return groups;
}

// ============================================
// Search Engines — configurable default search provider
// ============================================
const SEARCH_ENGINES = {
    google:    { name: 'Google',     baseUrl: 'https://www.google.com/search?q=',    favicon: faviconUrl('google.com'),    icon: '🔍' },
    bing:      { name: 'Bing',       baseUrl: 'https://www.bing.com/search?q=',    favicon: faviconUrl('bing.com'),    icon: '🔍' },
    duckduckgo:{ name: 'DuckDuckGo', baseUrl: 'https://duckduckgo.com/?q=',         favicon: faviconUrl('duckduckgo.com'), icon: '🦆' },
    baidu:     { name: 'Baidu',     baseUrl: 'https://www.baidu.com/s?wd=',        favicon: faviconUrl('baidu.com'),          icon: '🌐' },
    yandex:    { name: 'Yandex',    baseUrl: 'https://yandex.com/search/?text=',  favicon: faviconUrl('yandex.com'),  icon: '💠' },
};

function getSearchEngine() {
    const key = localStorage.getItem('ffSearchEngine') || 'google';
    return SEARCH_ENGINES[key] || SEARCH_ENGINES.google;
}

// ============================================
// Unified Search Suggest Engine
// Firefox Awesome Bar (Urlbar) specification:
//   - Frecency = baseScore × visitBonus × recencyFactor
//   - Token matching: query split on spaces, each token must match title or URL
//   - Visit count from history frequency
//   - Non-URL input: show search suggestion at bottom (FF default behavior)
// ============================================
const BrowserSearchSuggest = (() => {
    let cache = null;
    const CACHE_TTL = 5000;

    function rebuild() {
        const now = Date.now();
        if (cache && now - cache.ts < CACHE_TTL) return cache.entries;

        const bookmarks = JSON.parse(localStorage.getItem('ffBookmarks') || '[]');
        const rawHist    = JSON.parse(localStorage.getItem('ffHistory') || '[]');

        // Count visits per URL from history
        const visitCount = {};
        const seen = new Set();
        for (let i = rawHist.length - 1; i >= 0; i--) {
            const h = rawHist[i];
            const url = typeof h === 'string' ? h : h?.url;
            if (!url || seen.has(url)) continue;
            seen.add(url);
            visitCount[url] = (visitCount[url] || 0) + 1;
        }

        const entries = [];
        const addedUrls = new Set();

        // Add bookmarks first (FF: bookmark is always visible, even if no query match)
        for (const b of (Array.isArray(bookmarks) ? bookmarks : [])) {
            if (!b || typeof b.url !== 'string') continue;
            entries.push({
                url: b.url,
                title: b.title || b.url,
                type: 'bookmark',
                visits: visitCount[b.url] || 0,
                time: b.addedAt || 0,
                isBookmark: true,
            });
            addedUrls.add(b.url);
        }

        // Add history (no duplicate with bookmarks)
        for (const h of (Array.isArray(rawHist) ? rawHist : [])) {
            const url = typeof h === 'string' ? h : h?.url;
            if (!url || addedUrls.has(url)) continue;
            entries.push({
                url,
                title: typeof h === 'string' ? url : (h.title || url),
                type: 'history',
                visits: visitCount[url] || 0,
                time: typeof h === 'object' ? (h.visitedAt || 0) : 0,
                isBookmark: false,
            });
            addedUrls.add(url);
        }

        cache = { entries, ts: now };
        return entries;
    }

    // Firefox frecency: visitBonus derived from visit count, recencyFactor from days-since-visit
    function frecencyBonus(visits, daysOld) {
        // visitBonus: more visits → higher multiplier
        //   0-1 visits: base (no bonus)
        //   2-5  visits: +50
        //   6-10 visits: +100
        //   10+  visits: +200
        let vb = 0;
        if      (visits >= 10) vb = 200;
        else if (visits >= 6)  vb = 100;
        else if (visits >= 2)  vb = 50;

        // recencyFactor: exponential decay by days
        //   0-9  days: 100
        //   10-30 days: 50
        //   31-60 days: 10
        //   60+  days: 0  (not shown unless bookmark)
        let rf;
        if      (daysOld <= 9)  rf = 100;
        else if (daysOld <= 30) rf = 50;
        else if (daysOld <= 60) rf = 10;
        else                    rf = 0;

        return vb + rf;
    }

    // Check if all query tokens match the entry (token set matching — FF behavior)
    function tokensMatch(entry, q) {
        const ql = q.toLowerCase();
        const tokens = ql.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return true;

        const titleLower = (entry.title || '').toLowerCase();
        const urlLower   = entry.url.toLowerCase();

        // All tokens must match title or URL (AND semantics — FF default)
        return tokens.every(tok =>
            titleLower.includes(tok) || urlLower.includes(tok)
        );
    }

    // Compute one entry's match score against the query
    function scoreOne(entry, q) {
        const ql = q.toLowerCase();

        // Token pre-filter: must match at least one token (OR semantics in pre-filter)
        // Then score on full query
        const titleLower = (entry.title || '').toLowerCase();
        const urlLower   = entry.url.toLowerCase();

        if (!titleLower.includes(ql) && !urlLower.includes(ql)) return 0;

        let score = 0;

        // --- Match position scoring (FF: first match type wins) ---
        // Exact match: title === q or url === q → 10000
        if (titleLower === ql || urlLower === ql) score += 10000;
        else {
            // Title: prefix > contains
            if (titleLower.startsWith(ql))        score += 1000;
            else if (titleLower.includes(ql))     score += 100;
            // URL: prefix > contains
            if (urlLower.startsWith(ql))          score += 500;
            else if (urlLower.includes(ql))       score += 50;
        }

        if (score === 0) return 0;

        // --- Type bonus (FF: bookmark > history) ---
        score += entry.isBookmark ? 1000 : 0;

        // --- Frecency bonus: visitBonus × recencyFactor ---
        const daysOld = entry.time ? (Date.now() - entry.time) / 86400000 : 999;
        const fb = frecencyBonus(entry.visits, Math.floor(daysOld));
        score += entry.isBookmark ? fb + 100 : fb; // bookmarks always get some score

        return score;
    }

    function search(query, limit = 6) {
            const q = (query || '').trim();
            if (!q) return [];

            // Firefox Awesome Bar special prefixes:
            //   ^  — exact URL match (strict equality, no scoring needed)
            //   ~  — history only (no bookmarks)
            //   *  — title only (no URL matching)
            let mode = 'default';
            let actual = q;
            if (q.startsWith('^')) { mode = 'exact-url'; actual = q.slice(1); }
            else if (q.startsWith('~')) { mode = 'history-only'; actual = q.slice(1); }
            else if (q.startsWith('*')) { mode = 'title-only'; actual = q.slice(1); }

            if (!actual) return [];

            const entries = rebuild();

            // Exact URL mode: strict string equality on the raw URL
            if (mode === 'exact-url') {
                const ql = actual.toLowerCase();
                const match = entries.find(e => e.url.toLowerCase() === ql);
                return match ? [{ ...match, score: 99999 }] : [];
            }

            // Score all entries
            let scored = entries
                .map(e => ({ ...e, score: scoreOne(e, actual, mode) }))
                .filter(e => e.score > 0);

            // History-only: exclude bookmarks
            if (mode === 'history-only') {
                scored = scored.filter(e => !e.isBookmark);
            }

            scored.sort((a, b) => b.score - a.score);

            // Non-URL query: append search suggestion
            const isUrlLike = /^[^ ]+\.[^ ]+|https?:|www\./i.test(actual);
            let results = scored.slice(0, limit);
            if (!isUrlLike && actual.length > 0) {
                const engine = getSearchEngine();
                const searchUrl = engine.baseUrl + encodeURIComponent(actual);
                const topIsSearch = results[0]?.url === searchUrl;
                if (!topIsSearch) {
                    results.push({
                        url: searchUrl,
                        title: engine.icon + ' 用' + engine.name + '搜索 "' + actual + '"',
                        type: 'search',
                        score: 0,
                        isSearch: true,
                        visits: 0,
                        time: 0,
                    });
                }
            }

            return results.slice(0, limit);
        }

    function invalidate() { cache = null; }

    return { search, invalidate };
})();

// Expose for newtab iframe and external use
window.BrowserSearchSuggest = BrowserSearchSuggest;

// ============================================
// Top Sites — background suggestions shown when address bar is empty
// One entry per origin (hostname), showing most frequent URL per site.
// ============================================

// Get top N sites (one entry per origin), sorted by frecency
function getTopSites(n = 8) {
    const bookmarks = JSON.parse(localStorage.getItem('ffBookmarks') || '[]');
    const rawHist    = JSON.parse(localStorage.getItem('ffHistory') || '[]');

    // Count visits per URL from history
    const visitCount = {};
    const seen = new Set();
    for (let i = rawHist.length - 1; i >= 0; i--) {
        const h = rawHist[i];
        const url = typeof h === 'string' ? h : h?.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        visitCount[url] = (visitCount[url] || 0) + 1;
    }

    // Merge bookmarks + history
    const entries = [];
    const addedUrls = new Set();

    for (const b of (Array.isArray(bookmarks) ? bookmarks : [])) {
        if (!b || typeof b.url !== 'string') continue;
        entries.push({
            url: b.url,
            title: b.title || b.url,
            type: 'bookmark',
            visits: visitCount[b.url] || 0,
            time: b.addedAt || 0,
            isBookmark: true,
        });
        addedUrls.add(b.url);
    }

    for (const h of (Array.isArray(rawHist) ? rawHist : [])) {
        const url = typeof h === 'string' ? h : h?.url;
        if (!url || addedUrls.has(url)) continue;
        entries.push({
            url,
            title: typeof h === 'string' ? url : (h.title || url),
            type: 'history',
            visits: visitCount[url] || 0,
            time: typeof h === 'object' ? (h.visitedAt || 0) : 0,
            isBookmark: false,
        });
        addedUrls.add(url);
    }

    // Pick most frequent URL per origin
    const byOrigin = {};
    for (const e of entries) {
        let host;
        try { host = new URL(e.url).hostname; } catch { continue; }
        if (!byOrigin[host] || e.visits > byOrigin[host].visits) {
            byOrigin[host] = e;
        }
    }

    // Sort by frecency and return top N
    const sites = Object.values(byOrigin).filter(Boolean);
    sites.sort((a, b) => {
        const fa = BrowserSearchSuggest._frecencyRaw(a.visits, a.time);
        const fb = BrowserSearchSuggest._frecencyRaw(b.visits, b.time);
        return fb - fa;
    });

    return sites.slice(0, n);
}

// Internal frecency without cache (exposed for getTopSites)
function _frecencyRaw(visits, time) {
    let vb = 0;
    if      (visits >= 10) vb = 200;
    else if (visits >= 6)  vb = 100;
    else if (visits >= 2)  vb = 50;
    const daysOld = time ? (Date.now() - time) / 86400000 : 999;
    let rf;
    if      (daysOld <= 9)  rf = 100;
    else if (daysOld <= 30) rf = 50;
    else if (daysOld <= 60) rf = 10;
    else                    rf = 0;
    return vb + rf;
}

// Expose for internal use
BrowserSearchSuggest._frecencyRaw = _frecencyRaw;
BrowserSearchSuggest._getTopSites = getTopSites;

// ============================================
// Menus
// ============================================
function toggleAppMenu() {
    const menu = $('app-menu');
    menu.classList.toggle('visible');
}

function hideAppMenu() {
    $('app-menu').classList.remove('visible');
}

function hideAllPanels() {
    ['app-menu', 'sidebar', 'context-menu'].forEach(id => {
        $(id).classList.remove('visible');
    });
}

// ============================================
// Tab Mute (🔊/🔇 toggle)
// ============================================
function toggleMute(tab) {
    const webAppView = $('webappgroup');
    const remote_app = webAppView.getActiveElement().remote_app;
    remote_app.setAudioMuted(!tab.loadingInfo.muted);

    pwaos_.appManager.getLoadingInfo(tab.app_id).then(function(v) {
        tab.loadingInfo = v.info;
        updateMuteButton(tab);
    });
}

function updateMuteButton(tab) {
    const btn = tab?.querySelector('.tab-mute');
    if (!btn) return;
    // Only show the mute button when the page actually has audio content
    tab._hasAudio = tab.loadingInfo?.audible;
    tab._muted = tab.loadingInfo?.muted;
    btn.style.display = tab._hasAudio ? '' : 'none';
    if (!tab._hasAudio) return;
    btn.textContent = tab._muted ? '🔇' : '🔊';
    btn.style.opacity = tab._muted ? '1' : '0.3';
}

// ============================================
// Tab Auto-Refresh (right-click → set interval)
// ============================================
const _tabRefreshTimers = new Map();

function startTabAutoRefresh(tab, intervalMs) {
    stopTabAutoRefresh(tab);
    const timer = setInterval(() => {
        if (!tab.parentNode) { stopTabAutoRefresh(tab); return; }
        reloadTab(tab);
    }, intervalMs);
    _tabRefreshTimers.set(tab, timer);
}

function stopTabAutoRefresh(tab) {
    const timer = _tabRefreshTimers.get(tab);
    if (timer) { clearInterval(timer); _tabRefreshTimers.delete(tab); }
}

function reloadTab(tab) {
    if (!tab._url || tab._url === 'about:blank') return;
    // Trigger reload via postMessage if in webapp
    if (tab.app_id) {
        $('webappgroup').sendToApp(tab.app_id, { type: 'reload' });
    }
    // Fallback: re-navigate
    navigateToUrl(tab._url, tab);
}

// ============================================
// Tab Strip Context Menu (right-click tab)
// ============================================
function handleTabStripContextMenu(e) {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    e.preventDefault();

    // Build params for buildContextMenu to create tab-strip specific menu
    const params = {
        _tabStripContext: true,
        _tab: tab
    };

    // Show the context menu at the click position
    showContextMenu(e.clientX, e.clientY, params);
}

// Right-click on the bookmarks bar (#bookmarks-bar) opens a small
// context menu with the "Hide bookmarks bar" action. Mirrors the
// pattern used by handleTabStripContextMenu / handleSidebarContextMenu.
function handleBookmarksBarContextMenu(e) {
    e.preventDefault();
    const params = { _bookmarksBarContext: true };
    showContextMenu(e.clientX, e.clientY, params);
}

// Right-click on the desktop nav-bar (#desktop-nav) opens a small
// context menu with the bookmarks-bar toggle. The bar lives just
// below the nav-bar (see updateBookmarksBar placement); right-clicking
// the nav-bar is the natural way to reach for the toggle when the
// bar is hidden.
function handleNavBarContextMenu(e) {
    // The URL input (#url-input) lives inside #desktop-nav and has
    // its own dedicated context menu (handleUrlInputContextMenu).
    // That handler calls e.preventDefault() but doesn't stop
    // propagation, so right-clicking the URL input would otherwise
    // bubble up here and we'd overwrite the input's menu with the
    // bookmarks-bar toggle. Bail out when the event target is the
    // input or any of its descendants.
    const target = e.target;
    if (target && (target.id === 'url-input' || target.closest?.('#url-input'))) {
        return;
    }
    e.preventDefault();
    const params = { _navBarContext: true };
    showContextMenu(e.clientX, e.clientY, params);
}

// ============================================
// Context Menu
// ============================================
// ============================================
// Context Menu — Dynamic SVG icon library
// ============================================
// Lightweight SVG icons (Lucide-style outline) keyed by context-menu action.
// All <14px so the menu stays compact; SVG stroke uses currentColor to
// inherit text-secondary.
const CTX_ICONS = {
    back:           '<polyline points="15 18 9 12 15 6"/>',
    forward:        '<polyline points="9 18 15 12 9 6"/>',
    reload:         '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    'open-link-new-tab':    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    'open-link-new-window': '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
    'open-link-incognito':  '<path d="M12 2a4 4 0 0 0-4 4v1a4 4 0 0 0 0 6v1a4 4 0 0 0 4 4 4 4 0 0 0 4-4v-1a4 4 0 0 0 0-6V6a4 4 0 0 0-4-4z"/><path d="M5 22h14"/>',
    'copy-link':            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'copy-link-text':       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'save-link-as':         '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    'bookmark-link':        '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    'open-image-new-tab':   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    'copy-image':           '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    'copy-image-url':       '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'save-image':           '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><rect x="6" y="3" width="12" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.3"/>',
    'toggle-media-play':    '<polygon points="6 4 20 12 6 20 6 4"/>',
    'toggle-media-mute':    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    'pip-media':            '<rect x="3" y="3" width="18" height="14" rx="2"/><rect x="13" y="10" width="7" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.4"/>',
    'copy-media-url':       '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    'save-media':           '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/><circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none" opacity="0.4"/>',
    'search-selection':     '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    'translate-selection':  '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'copy-selection':       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    copy:                   '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cut:                    '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
    paste:                  '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
    // Fullscreen — outer rectangle with corner arrows pointing out
    // (Lucide "maximize" style). Pairs with the "minimize" variant
    // used to show the exit state.
    fullscreen:             '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    'exit-fullscreen':      '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    'paste-plain':          '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="3" y1="22" x2="21" y2="22"/>',
    undo:                   '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    redo:                   '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
    'select-all':           '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/>',
    'spell-check':          '<path d="M11 4l-7 16h2l1.5-4h7l1.5 4h2L11 4zm-2.5 10L11 8l2.5 6h-5z" fill="currentColor" stroke="none" opacity="0.85"/>',
    'copy-page-url':        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'bookmark-page':        '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    // Show / hide the persistent bookmarks bar that lives under
    // #desktop-nav. Lucide-style eye (visible) / eye-off (hidden).
    'show-bookmarks-bar':    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'hide-bookmarks-bar':    '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.62 19.62 0 0 1 5.06-5.94"/><path d="M9.9 4.9A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.7 19.7 0 0 1-3.17 4.19"/><path d="M1 1l22 22"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/>',
    'view-source':          '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    inspect:                '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/>',
    'clear-history':        '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

function showContextMenu(x, y, params) {
    const menu = $('context-menu');
    // Build dynamic menu based on what was right-clicked. The third
    // argument is an opaque params bag from the iframe (link_url,
    // selection_text, is_editable, ...); if absent, we fall back to
    // inspecting the DOM target captured by the document contextmenu
    // handler.
    const p = params || window._contextParams;
    buildContextMenu(p || window._contextTarget || document);
    menu.classList.add('visible');
    // Position menu...
    requestAnimationFrame(() => {
        if (!menu.classList.contains('visible')) return;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        requestAnimationFrame(() => {
            if (!menu.classList.contains('visible')) return;
            const rect = menu.getBoundingClientRect();
            const pad = 8;
            let finalX = x;
            let finalY = y;
            if (rect.right > window.innerWidth - pad) {
                finalX = Math.max(pad, window.innerWidth - rect.width - pad);
            }
            if (rect.bottom > window.innerHeight - pad) {
                const overshoot = rect.bottom - (window.innerHeight - pad);
                finalY = Math.max(pad, y - overshoot);
            }
            menu.style.left = finalX + 'px';
            menu.style.top = finalY + 'px';
        });
    });
}

function buildContextMenu(target) {
    const menu = $('context-menu');
    // Clear existing items
    menu.innerHTML = '';

    // Normalize the input. Either we got an opaque params object from
    // the iframe (link_url, selection_text, is_editable, src_url, ...)
    // or we got a DOM target to introspect. Detect the params form by
    // the presence of any of the recognized keys.
    let p;
    if (target && typeof target === 'object' && (
        'link_url' in target || 'src_url' in target || 'selection_text' in target ||
        'is_editable' in target || 'page_url' in target || 'has_image_contents' in target
    )) {
        p = {
            link_url: target.link_url || '',
            link_text: target.link_text || '',
            src_url: target.src_url || '',
            alt_text: target.alt_text || '',
            title_text: target.title_text || '',
            has_image_contents: !!target.has_image_contents,
            is_editable: !!target.is_editable,
            selection_text: target.selection_text || '',
            page_url: target.page_url || '',
            frame_url: target.frame_url || '',
        };
    } else if (target._tabStripContext && target._tab) {
        // Handle tab strip context menu (right-click on tab)
        const tab = target._tab;
        const items = [];
        items.push({ label: '关闭标签页', action: 'tab-close', icon: 'tab-close', tab: tab });
        items.push({ label: '关闭其他标签页', action: 'tab-close-others', icon: 'tab-close-others', tab: tab });
        if (tab._url) items.push({ label: '复制标签页', action: 'tab-duplicate', icon: 'tab-duplicate', tab: tab });
        items.push({ label: tab._muted ? '🔊 取消静音' : '🔇 静音', action: 'tab-mute', icon: tab._muted ? 'tab-unmute' : 'tab-mute', tab: tab });

        // Fullscreen toggle. Label and icon reflect the current
        // state so the user sees what clicking will do. Hidden entirely
        // when the Fullscreen API isn't available (older browsers,
        // sandboxed iframes).
        const fsAvailable = window.Fullscreen?.isAvailable?.();
        if (fsAvailable !== false) {
            const fsActive = !!window.Fullscreen?.isActive?.();
            items.push({
                label: fsActive ? '退出全屏' : '进入全屏',
                action: 'toggle-fullscreen',
                icon: fsActive ? 'exit-fullscreen' : 'fullscreen',
            });
        }

        // Bookmarks-bar toggle. Same dynamic pattern as fullscreen
        // above: the label and icon reflect the current state, so
        // the user sees what clicking will do. The bar lives
        // under #desktop-nav (the row below the tab strip), and
        // right-clicking a tab is the natural way to surface the
        // toggle when the bar is hidden.
        const bmVisible = isBookmarksBarVisible();
        items.push({
            label: bmVisible ? '隐藏书签栏' : '显示书签栏',
            action: bmVisible ? 'hide-bookmarks-bar' : 'show-bookmarks-bar',
            icon: bmVisible ? 'hide-bookmarks-bar' : 'show-bookmarks-bar',
        });

        // Group options
        const groupId = tab._groupId;
        if (groupId) {
            items.push({ label: '📂 取消分组', action: 'tab-ungroup', icon: 'tab-ungroup', tab: tab });
        } else {
            const existingGroups = Object.values(tabGroups).filter(g => !g.collapsed);
            if (existingGroups.length > 0) {
                existingGroups.forEach(g => {
                    items.push({ label: `📂 加入「${g.name}」`, action: 'tab-add-to-group', icon: 'tab-group', tab: tab, groupId: g.id });
                });
            }
        }

        // Render the menu directly
        const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
            { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" }[c]
        ));
        menu.innerHTML = items.map(item => {
            const safeLabel = escAttr(item.label);
            const iconKey = item.icon || '';
            const iconSvg = CTX_ICONS[iconKey]
                ? `<span class="context-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICONS[iconKey]}</svg></span>`
                : '<span class="context-icon"></span>';
            const cls = ['context-item'].filter(Boolean).join(' ');
            return `<button type="button" class="${cls}" data-action="${escAttr(item.action)}"${item.tab ? ` data-tab-id="${escAttr(item.tab._id)}"` : ''}${item.groupId ? ` data-group-id="${escAttr(item.groupId)}"` : ''}>${iconSvg}<span class="context-label">${safeLabel}</span></button>`;
        }).join('');

        return;
    } else if (target._bookmarksBarContext || target._navBarContext) {
        // Right-click on the bookmarks bar itself OR on the nav-bar
        // (the row above). Both surfaces expose the same single
        // dynamic toggle item so the user can hide or show the bar
        // without hunting for it. The label/icon flip based on the
        // current state so the user always sees what clicking will
        // do. (Nav-bar context is the discoverable path when the
        // bar is hidden — the bar element itself is unclickable.)
        const bmVisible = isBookmarksBarVisible();
        const items = [{
            label: bmVisible ? '隐藏书签栏' : '显示书签栏',
            action: bmVisible ? 'hide-bookmarks-bar' : 'show-bookmarks-bar',
            icon: bmVisible ? 'hide-bookmarks-bar' : 'show-bookmarks-bar',
        }];
        const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
            { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" }[c]
        ));
        menu.innerHTML = items.map(item => {
            const safeLabel = escAttr(item.label);
            const iconKey = item.icon || '';
            const iconSvg = CTX_ICONS[iconKey]
                ? `<span class="context-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICONS[iconKey]}</svg></span>`
                : '<span class="context-icon"></span>';
            return `<button type="button" class="context-item" data-action="${escAttr(item.action)}">${iconSvg}<span class="context-label">${safeLabel}</span></button>`;
        }).join('');
        return;
    } else if (target._urlInputContext) {
                // URL bar context menu — text-field actions that target the
                // chrome's #url-input rather than the iframe. Per-item
                // disabled state is computed from the live input element:
                // Cut/Copy need a non-empty value (we don't gate on the
                // current selection because the right-click mousedown
                // collapses any prior selection by the time the contextmenu
                // event reaches us; "Select All" is the escape hatch for
                // copying the whole value); Clear needs a non-empty value.
                const input = target._inputEl || document.getElementById('url-input');
                const value = input ? (input.value || '') : '';
                const hasText = !!value;
                const items = [
                    { label: '撤销', action: 'undo',     icon: 'undo',      disabled: !input || !value },
                    { type: 'separator' },
                    { label: '剪切', action: 'cut',      icon: 'cut',       disabled: !hasText },
                    { label: '复制', action: 'copy',     icon: 'copy',      disabled: !hasText },
                    { label: '粘贴', action: 'paste',    icon: 'paste' },
                    { label: '粘贴并前往', action: 'url-paste-and-go', icon: 'paste' },
                    { type: 'separator' },
                    { label: '全选',     action: 'select-all', icon: 'select-all' },
                    { label: '清除地址栏', action: 'url-clear-url', icon: 'clear-url', disabled: !value },
                ];
                const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
                    { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" }[c]
                ));
                menu.innerHTML = items.map(item => {
                    if (item.type === 'separator') {
                        return '<div class="context-divider"></div>';
                    }
                    const safeLabel = escAttr(item.label);
                    const iconKey = item.icon || '';
                    const iconSvg = CTX_ICONS[iconKey]
                        ? `<span class="context-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICONS[iconKey]}</svg></span>`
                        : '<span class="context-icon"></span>';
                    const cls = ['context-item', item.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
                    const disabledAttr = item.disabled ? ' disabled aria-disabled="true"' : '';
                    return `<button type="button" class="${cls}" data-action="${escAttr(item.action)}"${disabledAttr}>${iconSvg}<span class="context-label">${safeLabel}</span></button>`;
                }).join('');

                window._contextParams = target;
                return;
            } else if (target._sidebarContext && target._bookmarkItem) {
                // Handle sidebar context menu (right-click on bookmark/history/download)
                const view = target._sidebarView || 'bookmarks';
                const url = target._bookmarkUrl;
                const title = target._bookmarkTitle;
                const isBookmarks = view === 'bookmarks';
                const isHistory = view === 'history';
                const isDownloads = view === 'downloads';

                const items = [];

                if (isBookmarks) {
                    items.push(
                        { label: '🔗 在当前标签页打开', action: 'sidebar-open-current', icon: 'sidebar-open-current', url: url, title: title },
                        { label: '📑 在新标签页打开', action: 'sidebar-open-new', icon: 'sidebar-open-new', url: url, title: title },
                        { label: '✏️ 编辑书签', action: 'sidebar-edit', icon: 'sidebar-edit', url: url, title: title },
                        { type: 'separator' },
                        { label: i18n.t('deleteBookmarkLabel') || '删除书签', action: 'sidebar-delete', icon: 'sidebar-delete', url: url, title: title }
                    );
                } else if (isHistory) {
                    items.push(
                        { label: '🔗 在新标签页打开', action: 'sidebar-open-new', icon: 'sidebar-open-new', url: url, title: title },
                        { label: '📋 复制链接', action: 'sidebar-copy-url', icon: 'sidebar-copy-url', url: url, title: title },
                        { type: 'separator' },
                        { label: '🗑 删除记录', action: 'sidebar-delete-history', icon: 'sidebar-delete-history', url: url, title: title }
                    );
                } else if (isDownloads) {
                    items.push(
                        { label: '📂 打开文件', action: 'sidebar-open-download', icon: 'sidebar-open-download', url: url, title: title },
                        { label: '📋 复制链接', action: 'sidebar-copy-url', icon: 'sidebar-copy-url', url: url, title: title },
                        { type: 'separator' },
                        { label: '🗑 从列表移除', action: 'sidebar-remove-download', icon: 'sidebar-remove-download', url: url, title: title }
                    );
                }

                // Render the menu directly
                const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
                    { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" }[c]
                ));
                menu.innerHTML = items.map(item => {
                    if (item.type === 'separator') {
                        return '<div class="context-divider"></div>';
                    }
                    const safeLabel = escAttr(item.label);
                    const iconKey = item.icon || '';
                    const iconSvg = CTX_ICONS[iconKey]
                        ? `<span class="context-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICONS[iconKey]}</svg></span>`
                        : '<span class="context-icon"></span>';
                    const cls = ['context-item'].filter(Boolean).join(' ');
                    return `<button type="button" class="${cls}" data-action="${escAttr(item.action)}"${item.url ? ` data-url="${escAttr(item.url)}"` : ''}${item.title ? ` data-title="${escAttr(item.title)}"` : ''}>${iconSvg}<span class="context-label">${safeLabel}</span></button>`;
                }).join('');

                window._contextParams = target;
                return;
            } else {
        // Fall back to DOM inspection on the local target. Guard every
        // DOM access — `target` may be the webappgroup app object
        // (returned by getActiveElement) rather than a real Element.
        const isElement = target && typeof target.closest === 'function';
        const link = isElement ? target.closest('a[href]') : null;
        const img = isElement ? target.closest('img') : null;
        const video = isElement ? target.closest('video') : null;
        const audio = isElement ? target.closest('audio') : null;
        const selection = (window.getSelection?.() || '').toString().trim();
        const isEditable = isElement && (
            target.isContentEditable || target.matches('input, textarea, [contenteditable="true"]')
        );
        const hasLink = !!(link && link.href);
        const hasImage = !!(img && (img.src || img.currentSrc));
        const hasVideo = !!(video && (video.src || video.currentSrc || video.querySelector?.('source')));
        const hasAudio = !!(audio && (audio.src || audio.currentSrc || audio.querySelector?.('source')));
        p = {
            link_url: hasLink ? link.href : '',
            link_text: hasLink ? link.textContent?.trim().slice(0, 80) : '',
            src_url: hasImage ? (img.src || img.currentSrc) :
                     hasVideo ? (video.src || video.currentSrc || video.querySelector?.('source')?.src || '') :
                     hasAudio ? (audio.src || audio.currentSrc || audio.querySelector?.('source')?.src || '') : '',
            alt_text: hasImage ? img.alt : '',
            title_text: '',
            has_image_contents: hasImage,
            is_editable: !!isEditable,
            selection_text: selection,
            page_url: location.href,
            frame_url: '',
        };
        // Stash a few extra fields so action handlers can dispatch by element
        if (hasVideo) p._video_paused = video.paused, p._video_muted = video.muted;
        if (hasAudio) p._audio_paused = audio.paused, p._audio_muted = audio.muted;
    }

    const hasLink = !!p.link_url;
    const hasImage = !!p.src_url && p.has_image_contents;
    // If has_image_contents is false we treat src_url as a media src instead.
    const hasMedia = !!p.src_url;
    const isEditable = p.is_editable;
    const selection = p.selection_text;

    const items = [];
    if (!hasLink && !hasImage && !hasMedia && !isEditable ) {
        // Navigation actions (always available on page)
        items.push({
            label: i18n.t('back'),
            action: 'back',
            icon: 'back',
            disabled: !currentTab.loadingInfo?.canGoBack,
        });
        items.push({
            label: i18n.t('forward'),
            action: 'forward',
            icon: 'forward',
            disabled: !currentTab.loadingInfo?.canGoForward,
        });
        items.push({
            label: i18n.t('refresh'),
            action: 'reload',
            icon: 'reload'
        });
        items.push({ type: 'separator' });
    }

    // Link context
    if (hasLink) {
        items.push({
            label: i18n.t('openLinkInNewTab'),
            action: 'open-link-new-tab',
            icon: 'open-link-new-tab',
            url: p.link_url
        });
        items.push({
            label: i18n.t('openLinkInNewWindow'),
            action: 'open-link-new-window',
            icon: 'open-link-new-window',
            url: p.link_url
        });
        items.push({
            label: i18n.t('openLinkInIncognito'),
            action: 'open-link-incognito',
            icon: 'open-link-incognito',
            url: p.link_url
        });
        items.push({ type: 'separator' });
        items.push({
            label: i18n.t('copyLink'),
            action: 'copy-link',
            icon: 'copy-link',
            url: p.link_url
        });
        if (p.link_text) {
            items.push({
                label: i18n.t('copyLinkText'),
                action: 'copy-link-text',
                icon: 'copy-link-text',
                selection: p.link_text
            });
        }
        items.push({
            label: i18n.t('saveLinkAs'),
            action: 'save-link-as',
            icon: 'save-link-as',
            url: p.link_url
        });
        items.push({
            label: i18n.t('addBookmark'),
            action: 'bookmark-link',
            icon: 'bookmark-link',
            url: p.link_url,
            title: p.link_text || p.link_url
        });
    }

    // Image context (when has_image_contents is true)
    if (hasImage) {
        if (items.length > 0 && items[items.length - 1].type !== 'separator') {
            items.push({ type: 'separator' });
        }
        items.push({
            label: i18n.t('openImageNewTab'),
            action: 'open-image-new-tab',
            icon: 'open-image-new-tab',
            url: p.src_url
        });
        items.push({
            label: i18n.t('copyImage'),
            action: 'copy-image',
            icon: 'copy-image',
            url: p.src_url,
            alt: p.alt_text
        });
        items.push({
            label: i18n.t('copyImageAddress'),
            action: 'copy-image-url',
            icon: 'copy-image-url',
            url: p.src_url
        });
        items.push({
            label: i18n.t('saveImageAs'),
            action: 'save-image',
            icon: 'save-image',
            url: p.src_url,
            alt: p.alt_text
        });
    }

    // Video / audio context — when we have src_url but no image-content
    // marker, treat it as media.
    if (hasMedia && !hasImage && !hasLink) {
        if (items.length > 0 && items[items.length - 1].type !== 'separator') {
            items.push({ type: 'separator' });
        }
        items.push({
            label: i18n.t('playPause'),
            action: 'toggle-media-play',
            icon: 'toggle-media-play'
        });
        items.push({
            label: i18n.t('muteUnmute'),
            action: 'toggle-media-mute',
            icon: 'toggle-media-mute'
        });
        items.push({
            label: i18n.t('pictureInPicture'),
            action: 'pip-media',
            icon: 'pip-media'
        });
        items.push({
            label: i18n.t('copyMediaUrl'),
            action: 'copy-media-url',
            icon: 'copy-media-url',
            url: p.src_url
        });
        items.push({
            label: i18n.t('saveMediaAs'),
            action: 'save-media',
            icon: 'save-media',
            url: p.src_url
        });
    }

    // Text selection context
    if (selection) {
        if (items.length > 0 && items[items.length - 1].type !== 'separator') {
            items.push({ type: 'separator' });
        }
        const trimmed = selection.length > 30 ? selection.slice(0, 30) + '...' : selection;
        items.push({
            label: `${i18n.t('search')} "${trimmed}"`,
            action: 'search-selection',
            icon: 'search-selection',
            selection: selection
        });
        items.push({
            label: i18n.t('translate') + ` "${trimmed}"`,
            action: 'translate-selection',
            icon: 'translate-selection',
            selection: selection
        });
        items.push({
            label: i18n.t('copy'),
            action: 'copy-selection',
            icon: 'copy-selection',
            selection: selection
        });
    }

    // Editable field context
    if (isEditable) {
        if (items.length > 0 && items[items.length - 1].type !== 'separator') {
            items.push({ type: 'separator' });
        }
        items.push({
            label: i18n.t('undo'),
            action: 'undo',
            icon: 'undo'
        });
        items.push({
            label: i18n.t('redo'),
            action: 'redo',
            icon: 'redo'
        });
        items.push({ type: 'separator' });
        items.push({
            label: i18n.t('cut'),
            action: 'cut',
            icon: 'cut'
        });
        items.push({
            label: i18n.t('copy'),
            action: 'copy',
            icon: 'copy'
        });
        items.push({
            label: i18n.t('paste'),
            action: 'paste',
            icon: 'paste'
        });
        items.push({
            label: i18n.t('pasteAndMatchStyle'),
            action: 'paste-plain',
            icon: 'paste-plain'
        });
        items.push({
            label: i18n.t('selectAll'),
            action: 'select-all',
            icon: 'select-all'
        });
        items.push({
            label: i18n.t('spellCheck'),
            action: 'spell-check',
            icon: 'spell-check'
        });
    }

    if (!hasLink && !hasImage && !hasMedia && !isEditable ) {
        // Page-level actions
        if (items.length > 0 && items[items.length - 1].type !== 'separator') {
            items.push({ type: 'separator' });
        }
        if (p.page_url) {
            items.push({
                label: i18n.t('copyPageUrl'),
                action: 'copy-page-url',
                icon: 'copy-page-url',
                url: p.page_url
            });
            // bookmark-page should use the *current tab's* title, not p.title_text
            // (the params object from iframe doesn't carry a title).
            items.push({
                label: i18n.t('addBookmark'),
                action: 'bookmark-page',
                icon: 'bookmark-page',
                url: p.page_url,
                title: currentTab?._title || p.page_url
            });
        }
        items.push({
            label: i18n.t('viewPageSource'),
            action: 'view-source',
            icon: 'view-source'
        });
        items.push({
            label: i18n.t('inspectElement'),
            action: 'inspect',
            icon: 'inspect',
            desktopOnly: true
        });
    }

    // Build menu HTML — render icons from CTX_ICONS by key
    const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" }[c]
    ));
    menu.innerHTML = items.map(item => {
        if (item.type === 'separator') {
            return '<div class="context-divider"></div>';
        }
        const safeLabel = escAttr(item.label);
        const safeUrl = escAttr(item.url || '');
        const safeSelection = escAttr(item.selection || '');
        const iconKey = item.icon || '';
        const iconSvg = CTX_ICONS[iconKey]
            ? `<span class="context-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICONS[iconKey]}</svg></span>`
            : '<span class="context-icon"></span>';
        const cls = [
            'context-item',
            item.disabled ? 'disabled' : '',
            item.desktopOnly ? 'desktop-only' : '',
        ].filter(Boolean).join(' ');
        const disAttr = item.disabled ? ' disabled aria-disabled="true"' : '';
        return `<button type="button" class="${cls}" data-action="${escAttr(item.action)}"${disAttr}`
             + (item.url ? ` data-url="${safeUrl}"` : '')
             + (item.selection ? ` data-selection="${safeSelection}"` : '')
             + (item.title ? ` data-title="${escAttr(item.title)}"` : '')
             + `>${iconSvg}<span class="context-label">${safeLabel}</span></button>`;
    }).join('');
}

// ============================================
// Keyboard Navigation (roving tabindex)
// ============================================

/**
 * Install keyboard navigation on a panel with roving tabindex.
 * @param {string} panelId - Panel element id
 * @param {string} itemsSelector - CSS selector for navigable items
 * @param {object} opts
 * @param {Function} opts.onEnter - (itemElement) => void  called on Enter
 * @param {Function} opts.onEscape - () => void  called on Escape (default: blur panel)
 * @param {Function} opts.onHome  - () => void  called on Home
 * @param {Function} opts.onEnd   - () => void  called on End
 * @param {boolean} opts.loop     - wrap around at ends (default true)
 */
function installKeyboardNav(panelId, itemsSelector, {
    onEnter,
    onEscape,
    onHome,
    onEnd,
    onLeft,
    onRight,
    loop = true,
} = {}) {
    const panel = $(panelId);
    if (!panel) return null;

    let current = -1;
    let items = [];

    function refresh() {
        items = Array.from(panel.querySelectorAll(itemsSelector));
        // All start non-focusable
        items.forEach(el => { el.tabIndex = -1; });
    }

    function getItems() {
        refresh();
        return items;
    }

    function focusItem(idx) {
        const all = getItems();
        if (!all.length) return;
        // Un-highlight old
        if (current >= 0 && all[current]) {
            all[current].tabIndex = -1;
            all[current].classList.remove('kb-active');
        }
        // Clamp
        if (idx < 0) idx = loop ? all.length - 1 : 0;
        if (idx >= all.length) idx = loop ? 0 : all.length - 1;
        // Skip disabled items
        let attempts = 0;
        while (attempts < all.length && (all[idx].disabled || all[idx].classList.contains('disabled'))) {
            idx = (idx + (idx >= current ? 1 : -1) + all.length) % all.length;
            attempts++;
        }
        if (attempts >= all.length) return; // all items disabled
        current = idx;
        all[current].tabIndex = 0;
        all[current].classList.add('kb-active');
        // Set actual browser focus for keyboard navigation
        all[current].focus({ preventScroll: true });
        // Scroll into view
        all[current].scrollIntoView({ block: 'nearest' });
    }

    function reset() {
        if (current >= 0 && items[current]) {
            items[current].tabIndex = -1;
            items[current].classList.remove('kb-active');
        }
        current = -1;
    }

    function focusFirst() {
        reset();
        focusItem(0);
    }

    function handleKeydown(e) {
        // Only handle when panel is visible
        if (!panel.classList.contains('visible')) return;

        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                e.preventDefault();
                if (onRight && e.key === 'ArrowRight') { onRight(); return; }
                if (onRight && e.key === 'ArrowDown') { onRight(); return; }
                // Find next enabled item
                const allDown = getItems();
                let nextIdx = (current === -1 ? -1 : current) + 1;
                let attemptsDown = 0;
                while (attemptsDown < allDown.length && (allDown[nextIdx].disabled || allDown[nextIdx].classList.contains('disabled'))) {
                    nextIdx = (nextIdx + 1) % allDown.length;
                    attemptsDown++;
                }
                if (attemptsDown < allDown.length) {
                    focusItem(nextIdx);
                }
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                e.preventDefault();
                if (onLeft && e.key === 'ArrowLeft') { onLeft(); return; }
                if (onLeft && e.key === 'ArrowUp') { onLeft(); return; }
                // Find previous enabled item
                const allUp = getItems();
                let prevIdx = (current === -1 ? allUp.length - 1 : current) - 1;
                let attemptsUp = 0;
                while (attemptsUp < allUp.length && (allUp[prevIdx].disabled || allUp[prevIdx].classList.contains('disabled'))) {
                    prevIdx = (prevIdx - 1 + allUp.length) % allUp.length;
                    attemptsUp++;
                }
                if (attemptsUp < allUp.length) {
                    focusItem(prevIdx);
                }
                break;
            case 'Home':
                e.preventDefault();
                if (onHome) { onHome(); return; }
                // Find first enabled item
                const allHome = getItems();
                let firstIdx = 0;
                let attemptsHome = 0;
                while (attemptsHome < allHome.length && (allHome[firstIdx].disabled || allHome[firstIdx].classList.contains('disabled'))) {
                    firstIdx = (firstIdx + 1) % allHome.length;
                    attemptsHome++;
                }
                if (attemptsHome < allHome.length) {
                    focusItem(firstIdx);
                }
                break;
            case 'End':
                e.preventDefault();
                if (onEnd) { onEnd(); return; }
                // Find last enabled item
                const allEnd = getItems();
                let lastIdx = allEnd.length - 1;
                let attemptsEnd = 0;
                while (attemptsEnd < allEnd.length && (allEnd[lastIdx].disabled || allEnd[lastIdx].classList.contains('disabled'))) {
                    lastIdx = (lastIdx - 1 + allEnd.length) % allEnd.length;
                    attemptsEnd++;
                }
                if (attemptsEnd < allEnd.length) {
                    focusItem(lastIdx);
                }
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (current >= 0 && items[current]) {
                    if (onEnter) onEnter(items[current]);
                    else items[current].click();
                }
                break;
            case 'Escape':
                e.preventDefault();
                if (onEscape) onEscape();
                else panel.classList.remove('visible');
                current = -1;
                break;
        }
    }

    // Register on the document so arrow keys work even when focus is
    // on a trigger button (e.g. hamburger-btn) outside the panel.
    document.addEventListener('keydown', handleKeydown);

    // Return API for programmatic control
    return {
        handleKeydown,
        focusFirst,
        focusLast() { getItems(); focusItem(items.length - 1); },
        reset,
        refreshItems: refresh,
    };
}

function hideContextMenu() {
    $('context-menu').classList.remove('visible');
    window._contextTarget = null;
}

// ============================================
// Zoom (Ctrl++ / Ctrl+- / Ctrl+0)
// ============================================
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 0.25;

function setZoom(level) {
    if (!currentTab) return;
    level = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level));
    currentTab._zoom = level;
    applyZoom();
}

function adjustZoom(delta) {
    if (!currentTab) return;
    setZoom(currentTab._zoom + delta);
}

function resetZoom() {
    setZoom(1);
}

// Sync the URL-bar zoom cluster: hidden at 100%, shows − percent +
// only while the tab is zoomed (modern-browser behavior).
function syncZoomCluster() {
    const cluster = $('zoom-cluster');
    if (!cluster) return;
    const pct = Math.round((currentTab?._zoom || 1) * 100);
    const pctBtn = $('zoom-pct');
    if (pctBtn) pctBtn.textContent = pct + '%';
    if (pct === 100) cluster.setAttribute('hidden', '');
    else cluster.removeAttribute('hidden');
}

function applyZoom() {
    const z = currentTab ? currentTab._zoom : 1;
    const webAppView = $('webappgroup');
    const remote_app = webAppView.getActiveElement().remote_app;
    if (remote_app) {
        remote_app.setPageScale(z);
    }
    syncZoomCluster();
}

// ============================================
// Text-only zoom (Ctrl+Shift+= / Ctrl+Shift+-)
// Scales font sizes inside the framed document without
// changing layout scale. Same-origin documents only —
// cross-origin frames are unreachable, so this degrades
// to a no-op there (same pattern as the panel close handler).
// ============================================
const MIN_TEXT_ZOOM = 0.5;
const MAX_TEXT_ZOOM = 3.0;
const TEXT_ZOOM_STEP = 0.1;

function setTextZoom(level) {
    if (!currentTab) return;
    level = Math.max(MIN_TEXT_ZOOM, Math.min(MAX_TEXT_ZOOM, level));
    // Snap to 1 when within epsilon so repeated nudges land exactly
    // on 100% instead of drifting (0.9999999...).
    if (Math.abs(level - 1) < 0.01) level = 1;
    currentTab._textZoom = level;
    applyTextZoom();
}

function adjustTextZoom(delta) {
    if (!currentTab) return;
    setTextZoom(currentTab._textZoom + delta);
}

function resetTextZoom() {
    setTextZoom(1);
}

// Palette/menu toggle: turn text-only zoom ON (110%) or back OFF.
// Remembers the last non-default level so OFF->ON restores it, like
// Fullscreen.toggle() remembers nothing but flips state.
function toggleTextZoomOnly() {
    if (!currentTab) return;
    const z = currentTab._textZoom || 1;
    setTextZoom(z === 1 ? 1.1 : 1);
}

function framedDocument() {
    const wg = $('webappgroup');
    if (!wg) return null;
    try { return wg._iframe && wg._iframe.contentDocument; } catch (_) { return null; }
}

function applyTextZoom() {
    const z = (currentTab && currentTab._textZoom) ? currentTab._textZoom : 1;
    const doc = framedDocument();
    if (!doc || !doc.documentElement) return;

    if (z === 1) {
        // Restore every element we scaled: elements that had their own
        // inline font-size get the pre-zoom computed value back; the
        // rest drop the inline override entirely.
        doc.querySelectorAll('[data-bz-orig]').forEach(el => {
            if (el.hasAttribute('data-bz-inline')) {
                el.style.setProperty('font-size', el.getAttribute('data-bz-orig') + 'px');
            } else {
                el.style.removeProperty('font-size');
            }
            el.removeAttribute('data-bz-orig');
            el.removeAttribute('data-bz-inline');
        });
        return;
    }

    // Two passes: snapshot ALL computed font sizes first (so em-based
    // sizes can't compound while we mutate), then write inline
    // overrides. The pre-zoom computed size is stashed per element so
    // repeated nudges scale from the original, not the already-scaled
    // value (110% -> 120% must yield 120%, not 132%).
    const all = doc.querySelectorAll('*');
    const snapshot = [];
    for (const el of all) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (!isFinite(fs) || fs <= 0) continue;
        snapshot.push([el, fs, el.style.getPropertyValue('font-size') !== '']);
    }
    for (const [el, fs, hadInline] of snapshot) {
        if (!el.hasAttribute('data-bz-orig')) {
            el.setAttribute('data-bz-orig', String(fs));
        }
        if (hadInline) el.setAttribute('data-bz-inline', '1');
        el.style.setProperty('font-size', (parseFloat(el.getAttribute('data-bz-orig')) * z) + 'px');
    }
}

// The inline overrides belong to the document they were written on.
// After a real navigation the new document has none — re-apply. Both
// runtimes signal load: PwaOS dispatches a 'load' CustomEvent on the
// host, standalone relies on the iframe's native load event. Debounce
// so PwaOS mode (both fire) walks the document once.
let _tzReapplyTimer = 0;
function scheduleTextZoomReapply() {
    if (_tzReapplyTimer) return;
    _tzReapplyTimer = setTimeout(() => { _tzReapplyTimer = 0; applyTextZoom(); }, 60);
}
{
    const wg = $('webappgroup');
    if (wg) {
        wg.addEventListener('load', scheduleTextZoomReapply);
        if (wg._iframe) wg._iframe.addEventListener('load', scheduleTextZoomReapply);
    }
}

// ============================================
// Restore Closed Tab (Ctrl+Shift+T)
// ============================================
function restoreClosedTab() {
    if (!recentlyClosedTabs.length) return;
    const saved = recentlyClosedTabs.shift();
    // Don't restore pinned tabs — just open a new tab with saved URL if any
    if (saved._url) {
        addTab(saved._url);
    } else {
        addTab();
    }
}

// ============================================
// Tab Cycling (Ctrl+Tab / Ctrl+Shift+Tab)
// ============================================
function doTabCycle(direction) {
    if (tabs.length < 2) return;
    const idx = tabs.indexOf(currentTab);
    const next = (idx + direction + tabs.length) % tabs.length;
    switchToTab(tabs[next]);
}

// ============================================
// Tab Bar Auto-Hide (fullscreen focus mode)
// ============================================
let tabBarHideTimer = null;
const TABBAR_HIDE_DELAY = 3000; // 3s idle → hide

function showTabBar() {
    $('tab-bar').classList.remove('auto-hidden');
    resetTabBarHideTimer();
}

function hideTabBar() {
    $('tab-bar').classList.add('auto-hidden');
}

function resetTabBarHideTimer() {
    clearTimeout(tabBarHideTimer);
    if (!tabBarAutoHideEnabled) return;
    tabBarHideTimer = setTimeout(hideTabBar, TABBAR_HIDE_DELAY);
}

let tabBarAutoHideEnabled = false;
function toggleTabBarAutoHide() {
    tabBarAutoHideEnabled = !tabBarAutoHideEnabled;
    if (tabBarAutoHideEnabled) {
        showTabBar();
        document.addEventListener('mousemove', showTabBarOnActivity);
        document.addEventListener('keydown', showTabBarOnActivity);
    } else {
        clearTimeout(tabBarHideTimer);
        document.removeEventListener('mousemove', showTabBarOnActivity);
        document.removeEventListener('keydown', showTabBarOnActivity);
        $('tab-bar').classList.remove('auto-hidden');
    }
}

function showTabBarOnActivity() {
    if (!$('tab-bar').classList.contains('auto-hidden')) {
        resetTabBarHideTimer();
    }
}

// Auto-show when mouse enters tab bar region (top 60px)
// rAF-throttled to one check per frame to avoid per-pixel mousemove spam
let _hoverCheckFrame = 0;
document.addEventListener('mousemove', e => {
    if (_hoverCheckFrame) return;
    _hoverCheckFrame = requestAnimationFrame(() => {
        _hoverCheckFrame = 0;
        if (e.clientY < 60) showTabBar();
    });
});

// ============================================
// Page Info Panel (Ctrl+I)
// ============================================
const PageInfo = (() => {
    function getSecurityBadge(url) {
        if (!url) return '<span class="pi-badge info">空白页</span>';
        if (url.startsWith('https://')) return '<span class="pi-badge secure">🔒 安全</span>';
        if (url.startsWith('http://')) return '<span class="pi-badge insecure">⚠ 不安全</span>';
        return '<span class="pi-badge info">🌐 本地</span>';
    }

    function getPageType(url) {
        if (!url) return '新标签页';
        if (url.startsWith('chrome://') || url.startsWith('about:')) return '浏览器页';
        if (url.startsWith('file://')) return '本地文件';
        return '网页';
    }

    function open() {
        const panel = $('page-info-panel');
        if (!panel.hidden) { close(); return; }
        const tab = currentTab;
        const url = tab?._url || '';
        const title = tab?._title || '新标签页';
        const security = getSecurityBadge(url);
        const pageType = getPageType(url);
        const zoom = Math.round((tab?._zoom || 1) * 100);
        const tabCount = tabs.length;
        const session = Math.round((Date.now() - (window._appStartTime || Date.now())) / 1000 / 60);

        // Anchor the popover just under the identity button, mirroring Firefox's
        // left-side popover. Coordinates come from #url-icon's bounding rect;
        // fall back to a safe offset when the button isn't in the DOM yet
        // (e.g. mobile-only first paint).
        const anchor = $('url-icon')?.getBoundingClientRect();
        if (anchor) {
            panel.style.setProperty('--pi-anchor-l', `${Math.max(4, Math.round(anchor.left))}px`);
            panel.style.setProperty('--pi-anchor-t', `${Math.round(anchor.bottom + 6)}px`);
        } else {
            panel.style.removeProperty('--pi-anchor-l');
            panel.style.removeProperty('--pi-anchor-t');
        }

        const content = $('page-info-content');
        content.innerHTML = `
            <div class="pi-row"><span class="pi-label">标题</span><span class="pi-value">${title}</span></div>
            <div class="pi-row"><span class="pi-label">地址</span><span class="pi-value url">${url || '(空白)'}</span></div>
            <div class="pi-row"><span class="pi-label">状态</span><span class="pi-value">${security} · ${pageType}</span></div>
            <div class="pi-row"><span class="pi-label">缩放</span><span class="pi-value">${zoom}%</span></div>
            <div class="pi-row"><span class="pi-label">标签页</span><span class="pi-value">${tabCount} 个标签页</span></div>
            ${session > 0 ? `<div class="pi-row"><span class="pi-label">运行时长</span><span class="pi-value">约 ${session} 分钟</span></div>` : ''}
        `;
        $('page-info-panel').hidden = false;
        $('url-icon')?.setAttribute('aria-expanded', 'true');
        // Make the panel focusable so a `blur` event can fire when the
        // user clicks outside. tabindex=-1 keeps it out of the tab order
        // but still focusable via .focus().
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        panel.focus();
        // Set a single-tick guard so the focusout fired by the keydown
        // that opened us (which restores focus to <body> on default
        // action) doesn't immediately re-close. Clears on the next
        // microtask, which is past any synchronous keydown side-effect.
        openGuard = 1;
        setTimeout(() => { openGuard = 0; }, 0);
    }

    // Tracks when open() was called so focusout from the keydown that
    // opened it doesn't immediately re-close. `panel.focus()` runs
    // synchronously, but the keydown's default focus restore to <body>
    // fires afterward → focusout → would close. We swallow that single
    // tick.
    let openGuard = 0;
    function close() {
        const panel = $('page-info-panel');
        if (panel) panel.hidden = true;
        $('url-icon')?.setAttribute('aria-expanded', 'false');
    }

    // Close the panel when focus moves outside it. As with CommandPalette,
    // `focusout` (not click-outside) is preferred: information panels are
    // focus sinks — once you're done reading, leaving the panel should
    // dismiss it. `focusout` bubbles (unlike `blur`), so we can listen
    // once on the panel and catch focus changes from any descendant.
    // The microtask lets synchronous focus shifts (e.g. URL bar gets
    // focused right after a click) settle before we close.
    function handleFocusOut(e) {
        if (openGuard) return;
        const next = e.relatedTarget;
        setTimeout(() => {
            if (openGuard) return;
            const panel = $('page-info-panel');
            if (!panel || panel.hidden) return;
            if (panel.contains(document.activeElement)) return;
            if (!next || !panel.contains(next)) close();
        }, 0);
    }

    function toggle() {
        const panel = $('page-info-panel');
        if (panel.hidden) open();
        else close();
    }

    // Recompute the popover anchor on resize/scroll so it stays glued to
    // the identity button when the user zooms or the window resizes.
    function reflow() {
        const panel = $('page-info-panel');
        if (!panel || panel.hidden) return;
        const anchor = $('url-icon')?.getBoundingClientRect();
        if (!anchor) return;
        panel.style.setProperty('--pi-anchor-l', `${Math.max(4, Math.round(anchor.left))}px`);
        panel.style.setProperty('--pi-anchor-t', `${Math.round(anchor.bottom + 6)}px`);
    }
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });

    // Listen on the panel itself (not individual children) so newly-added
    // rows don't need separate wiring. `focusout` bubbles up from any
    // descendant, so attaching once is enough.
    $('page-info-panel')?.addEventListener('focusout', handleFocusOut);

    return { open, close, toggle };
})();

// ============================================
// Search Engine Panel (Ctrl+Shift+S)
// ============================================
const SearchEnginePanel = (() => {
    let openGuard = 0;

    function open() {
        const panel = $('search-engine-panel');
        if (!panel) return;
        const storedEngine = localStorage.getItem('ffSearchEngine') || 'google';
        const body = panel.querySelector('.sep-body');
        if (!body) return;
        const frag = document.createDocumentFragment();
        Object.entries(SEARCH_ENGINES).forEach(([key, eng]) => {
            const row = document.createElement('div');
            row.className = `sep-row${key === storedEngine ? ' kb-active' : ''}`;
            row.dataset.key = key;
            row.innerHTML = `<span class="sep-icon" style="background-image:url(${eng.favicon})"></span><span class="sep-name">${eng.name}</span>`;
            row.addEventListener('click', () => selectEngine(key));
            frag.appendChild(row);
        });
        body.innerHTML = '';
        body.appendChild(frag);
        panel.hidden = false;
        reflow();
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        panel.focus();
        openGuard = 1;
        setTimeout(() => { openGuard = 0; }, 0);
    }

    function selectEngine(key) {
        const eng = SEARCH_ENGINES[key] || SEARCH_ENGINES.google;
        localStorage.setItem('ffSearchEngine', key);
        const urlInput = $('url-input');
        if (urlInput) urlInput.placeholder = i18n.t('searchOrUrl').replace('{engine}', eng.name);
        const btn = $('search-engine-btn');
        if (btn) {
            const icon = btn.querySelector('.se-btn-icon');
            if (icon) icon.style.backgroundImage = `url(${eng.favicon})`;
        }
        showToast(eng.name, 1200);
        close();
    }

    function close() {
        const panel = $('search-engine-panel');
        if (panel) panel.hidden = true;
    }

    function toggle() {
        const panel = $('search-engine-panel');
        if (!panel) return;
        if (panel.hidden) open();
        else close();
    }

    function handleKeydown(e) {
        const panel = $('search-engine-panel');
        if (!panel || panel.hidden) return;
        const items = panel.querySelectorAll('.sep-row');
        if (!items.length) return;
        let activeIndex = [...items].findIndex(i => i.classList.contains('kb-active'));
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[activeIndex]?.classList.remove('kb-active');
            activeIndex = (activeIndex + 1) % items.length;
            items[activeIndex]?.classList.add('kb-active');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            items[activeIndex]?.classList.remove('kb-active');
            activeIndex = (activeIndex - 1 + items.length) % items.length;
            items[activeIndex]?.classList.add('kb-active');
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            selectEngine(items[activeIndex].dataset.key);
        }
    }

    function handleFocusOut(e) {
        if (openGuard) return;
        setTimeout(() => {
            if (openGuard) return;
            const panel = $('search-engine-panel');
            if (!panel || panel.hidden) return;
            if (!panel.contains(document.activeElement)) close();
        }, 0);
    }

    function reflow() {
        const panel = $('search-engine-panel');
        if (!panel || panel.hidden) return;
        const anchor = $('search-engine-btn')?.getBoundingClientRect();
        // Anchor the popover just under the identity button, mirroring Firefox's
        // left-side popover. Coordinates come from #url-icon's bounding rect;
        // fall back to a safe offset when the button isn't in the DOM yet
        // (e.g. mobile-only first paint).
        if (anchor) {
            panel.style.setProperty('--pi-anchor-l', `${Math.max(4, Math.round(anchor.left))}px`);
            panel.style.setProperty('--pi-anchor-t', `${Math.round(anchor.bottom + 6)}px`);
        } else {
            panel.style.removeProperty('--pi-anchor-l');
            panel.style.removeProperty('--pi-anchor-t');
        }
    }

    $('search-engine-panel')?.addEventListener('focusout', handleFocusOut);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });

    return { open, close, toggle, handleKeydown };
})();

// ============================================
// Suggestions URL Panel (opens while typing in URL bar)
// ============================================
const SuggestionsUrlPanel = (() => {
    let openGuard = 0;
    let activeIndex = -1;
    let _blurTimer = null;
    let last_user_input_value = null;
    let last_query = null;    // most recent trimmed query passed to open()

    function escape(s) {
        return String(s ?? '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    }

    function getItemIcon(r) {
        if (r.isSearch) {
            // Search-engine row: use the engine's favicon so it visually
            // anchors to which provider will run the query.
            if (r.favicon) return `<img class="suggestions-url-icon" src="${escape(r.favicon)}" alt="" onerror="this.outerHTML='🔍'">`;
            return '🔍';
        }
        if (r.isTopSite) return '⭐';
        try {
            const host = new URL(r.url).hostname;
            return `<img class="suggestions-url-icon" src="${faviconUrl(host)}" alt="" onerror="this.outerHTML='🌐'">`;
        } catch {
            return '↺';
        }
    }

    // Render one row. type is one of 'search' (search-engine prompt) or
    // 'topsite' (bookmark/history-derived entry).
    function rowHtml(r) {
        const cls = r.isSearch ? 'suggestions-url-icon search'
                  : r.isTopSite ? 'suggestions-url-icon topsite'
                  : 'suggestions-url-icon';
        return `
            <div class="suggestions-url-item" data-url="${escape(r.url)}">
                <div class="${cls}">${getItemIcon(r)}</div>
                <div class="suggestions-url-text">
                    <span class="suggestions-url-title">${escape(r.title || r.url)}</span>
                    <span class="suggestions-url-url">${escape(r.url)}</span>
                </div>
            </div>`;
    }

    // Renders two sections, in the order required: Search first, Top Sites
    // second. The search section is empty (no header, no rows) when the
    // query is blank — only Top Sites is shown then.
    //
    // A trailing "all engines" row is always appended at the bottom (after
    // the Top Sites section) so users can pick any registered engine without
    // having to open the dedicated SearchEnginePanel. The row is identified
    // by .suggestions-url-engines (no data-url), so the row-level click
    // handler in open() correctly ignores it.
    // Trailing "this-time search with" row. Hosts the engine strip inline
    // so the user can pick any registered engine for the current URL-bar
    // query without leaving the panel.
    function buildEnginesRowHtml() {
        const engines = Object.entries(SEARCH_ENGINES).map(([key, eng]) => `
            <button type="button" class="suggestions-url-engine"
                    data-engine-key="${escape(key)}"
                    data-engine-base="${escape(eng.baseUrl)}"
                    title="${escape(eng.name)}"
                    aria-label="用 ${escape(eng.name)} 搜索">
                <img src="${escape(eng.favicon)}" alt="" onerror="this.outerHTML='${escape(eng.icon)}'">
            </button>`).join('');

        return `
            <div class="suggestions-url-item suggestions-url-engines-row" data-engines-row>
                <div class="suggestions-url-icon search">🔍</div>
                <div class="suggestions-url-text">
                    <span class="suggestions-url-title">This time, search with:</span>
                    <span class="suggestions-url-engines">${engines}</span>
                </div>
            </div>`;
    }

    function buildHTML({ search, topSites, query }) {
        let html = '';

        const searchItems = Array.isArray(search) ? search.filter(Boolean) : [];
        if (searchItems.length) {
            html += `<div class="suggestions-url-group-header">🔍 搜索${query ? ` "${escape(query)}"` : ''}</div>`;
            html += searchItems.map(rowHtml).join('');
        }

        const topSitesItems = Array.isArray(topSites) ? topSites.filter(Boolean) : [];
        if (topSitesItems.length) {
            html += `<div class="suggestions-url-group-header">⚡ 常用网站</div>`;
            // Mark the rows so the icon helper picks the right glyph.
            topSitesItems.forEach(r => { r.isTopSite = true; });
            html += topSitesItems.map(rowHtml).join('');
        }

        // Trailing "all engines" row — always present.
        html += buildEnginesRowHtml();

        return html;
    }

    // Build the single search-engine row for the typed query, if any. When
    // the user has typed something that LOOKS like a URL, the suggestion
    // engine in BrowserSearchSuggest.search already promotes matching
    // bookmarks/history above this row, so we don't need to special-case
    // it here.
    function buildSearchSection(query) {
        const q = (query || '').trim();
        if (!q) return [];
        // Don't surface the search-engine row if the query itself is a URL
        // — pressing Enter will just navigate there directly.
        if (/^https?:\/\//i.test(q) || /^file:\/\//i.test(q) || /^[^ ]+\.[^ ]+/.test(q)) return [];

        const engine = getSearchEngine();
        const url = engine.baseUrl + encodeURIComponent(q);
        return [{
            url,
            title: `${engine.icon} 用 ${engine.name} 搜索 "${q}"`,
            favicon: engine.favicon,
            isSearch: true,
        }];
    }

    // Compute the maximum number of top-site rows the panel can show
    // without overflowing the available viewport height. Iterates from the
    // configured cap downward so we degrade only when needed.
    function fitTopSitesCount(panel, topSites, search) {
        const MAX = 8;
        const safety = 8;          // small gap below the panel
        const urlBarBottom = $('url-bar')?.getBoundingClientRect().bottom || 0;
        const panelStyle = getComputedStyle(panel);
        const maxH = parseFloat(panelStyle.maxHeight) || Infinity;
        // Anchor's bottom margin (6px) is implicit in --sup-anchor-t.
        const available = Math.min(maxH, window.innerHeight - urlBarBottom - safety);

        const content = $('suggestions-url-content');
        const cap = Math.min(MAX, topSites.length);
        for (let n = cap; n >= 1; n--) {
            const slice = topSites.slice(0, n);
            content.innerHTML = buildHTML({ search, topSites: slice, query: last_query });
            if (content.scrollHeight <= available) return slice;
        }
        // Even one topsite row would overflow (extreme-shrunk viewport).
        // Return one row anyway so the panel still has user-curated
        // shortcuts visible; CSS max-height keeps it from spilling out
        // of the viewport.
        return topSites.slice(0, 1);
    }

    function open(filter = '') {
        const panel = $('suggestions-url-panel');
        if (!panel) return;

        if (typeof BrowserSearchSuggest === 'undefined') return;
        const query = (filter || '').trim();
        last_query = query;

        // Two data sources, computed independently:
        //   - topSites: bookmarks + history fused by hostname & frecency
        //   - search:   search-engine prompt for the current query
        // The panel renders both as two distinct sections.
        const allTopSites = BrowserSearchSuggest._getTopSites(8) || [];
        const search = buildSearchSection(query);

        const content = $('suggestions-url-content');
        activeIndex = -1;

        if ((search.length === 0) && allTopSites.length === 0) {
            content.innerHTML = '';
            panel.hidden = true;
            return;
        }

        // Pick a top-sites count that fits the available viewport, instead
        // of rendering with a fixed cap and then scrolling. fitTopSitesCount
        // renders the panel with progressively fewer top-site rows until
        // content.scrollHeight fits within `available`. We unhide the panel
        // first so the browser computes real heights — display:none makes
        // scrollHeight read 0 in some engines.
        panel.hidden = false;
        const fittedTopSites = fitTopSitesCount(panel, allTopSites, search);
        content.innerHTML = buildHTML({ search, topSites: fittedTopSites, query });

        // Anchor the panel under the URL bar (match url-bar width)
        const urlBar = $('url-bar')?.getBoundingClientRect();
        if (urlBar) {
            panel.style.setProperty('--sup-anchor-l', `${Math.max(4, Math.round(urlBar.left))}px`);
            panel.style.setProperty('--sup-anchor-t', `${Math.round(urlBar.bottom + 6)}px`);
            panel.style.setProperty('--sup-width', `${Math.round(urlBar.width)}px`);
            last_user_input_value = $('url-input').value;
        }

        panel.hidden = false;

        // Wire click events
        content.querySelectorAll('.suggestions-url-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // Engine buttons inside the trailing engines row have their
                // own click handlers and stopPropagation. The engines row
                // itself has no data-url, so an unguarded click would call
                // navigateToUrl('') which is bad. Bail when there's no
                // destination.
                if (e.target.closest('.suggestions-url-engine')) return;
                const url = item.dataset.url;
                if (!url) return;
                navigateToUrl(url);
                close();
            });
        });

        // Engine buttons: search the current url-input value with the
        // chosen engine. Clicked engine overrides the default for this
        // single query only - the stored default is left untouched.
        content.querySelectorAll('.suggestions-url-engine').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const base = btn.dataset.engineBase;
                if (!base) return;
                const q = ($('url-input')?.value || '').trim();
                if (!q) {
                    // Nothing typed - just persist the engine as default so
                    // the next search goes through it.
                    const key = btn.dataset.engineKey;
                    if (key) localStorage.setItem('ffSearchEngine', key);
                    close();
                    return;
                }
                navigateToUrl(base + encodeURIComponent(q));
                close();
            });
        });

        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        openGuard = 1;
        setTimeout(() => { openGuard = 0; }, 0);
        panel.addEventListener('keydown', handleKeydown);
    }

    function close() {
        const panel = $('suggestions-url-panel');
        if (panel) panel.hidden = true;
        activeIndex = -1;
        if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
    }

    function toggle(filter = '') {
        const panel = $('suggestions-url-panel');
        if (!panel) return;
        if (panel.hidden) open(filter);
        else close();
    }

    function handleFocusOut(e) {
        if (openGuard) return;
        const next = e.relatedTarget;
        setTimeout(() => {
            if (openGuard) return;
            const panel = $('suggestions-url-panel');
            if (!panel || panel.hidden) return;
            if (panel.contains(document.activeElement)) return;
            if (!next || !panel.contains(next)) close();
        }, 0);
    }

    function handleKeydown(e) {
        const panel = $('suggestions-url-panel');
        if (!panel || panel.hidden) return;
        const items = panel.querySelectorAll('.suggestions-url-item');
        if (!items.length) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const urlInput = $('url-input');
                if (activeIndex == items.length -1 ) {
                    if (urlInput) {
                        urlInput.focus();
                        urlInput.value = last_user_input_value;
                        activeIndex = -1;
                    }
                } else {
                    activeIndex = Math.min(activeIndex + 1, items.length - 1);
                    if (urlInput) urlInput.value = items[activeIndex].dataset.url;
                }
                items.forEach((item, i) => item.classList.toggle('kb-active', i === activeIndex));
            } else {
                e.preventDefault();
                const urlInput = $('url-input');
                if (activeIndex == 0) {
                    if (urlInput) {
                        urlInput.focus();
                        urlInput.value = last_user_input_value;
                        activeIndex = -1;
                    }
                }
                else {
                    activeIndex = Math.max(activeIndex - 1, 0);
                    if (urlInput) urlInput.value = items[activeIndex].dataset.url;
                }
                items.forEach((item, i) => item.classList.toggle('kb-active', i === activeIndex));
            }
        } else if (e.key === 'Enter' && activeIndex >= 0) {
            e.preventDefault();
            const url = items[activeIndex].dataset.url;
            navigateToUrl(url);
            close();
        }
    }

    // Close on resize/scroll to keep anchored correctly
    function reflow() {
        const panel = $('suggestions-url-panel');
        if (!panel || panel.hidden) return;
        const urlBar = $('url-bar')?.getBoundingClientRect();
        if (!urlBar) return;
        panel.style.setProperty('--sup-anchor-l', `${Math.max(4, Math.round(urlBar.left))}px`);
        panel.style.setProperty('--sup-anchor-t', `${Math.round(urlBar.bottom + 6)}px`);
    }
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { passive: true });

    $('suggestions-url-panel')?.addEventListener('focusout', handleFocusOut);

    return { open, close, toggle, handleKeydown };
})();

// ============================================
// Fullscreen Toggle (F11)
// ============================================
//
// Tracks fullscreen state via the `fullscreenchange` event so the
// module stays in sync when the user exits fullscreen via Esc,
// the browser UI, or any other means. Also enables the immersive
// auto-hide of the browser chrome (URL bar, sidebar) while fullscreen
// is active. Restores the prior UI state on exit.
const Fullscreen = (() => {
    const root = $('webappgroup');
    const doc = document;

    const requestFs = root.requestFullscreen
        || root.webkitRequestFullscreen;          // Safari/iOS WebKit
    const exitFs = doc.exitFullscreen
        || doc.webkitExitFullscreen;
    // Computed once at module init. Cheap enough — `document` and
    // `document.documentElement` don't lose/gain the Fullscreen API
    // during a session.
    const apiAvailable = !!(requestFs && (exitFs || doc.webkitExitFullscreen));

    function isAvailable() {
        return apiAvailable;
    }

    // The current fullscreen element, or null. Read fresh on every
    // state check — don't cache it.
    const currentElement = () => doc.fullscreenElement
        || doc.webkitFullscreenElement
        || null;

    function enter() {
        if (!requestFs) return false;
        const p = requestFs.call(root);
        // The promise may reject if the user denies the request, or
        // if it was triggered outside a user gesture. Both are
        // expected and don't need to be reported.
        if (p && typeof p.catch === 'function') {
            p.catch(err => console.warn('[Fullscreen] enter denied:', err && err.message));
        }
        return true;
    }

    function exit() {
        if (!exitFs) return false;
        const p = exitFs.call(doc);
        if (p && typeof p.catch === 'function') {
            p.catch(err => console.warn('[Fullscreen] exit failed:', err && err.message));
        }
        return true;
    }

    function isActive() {
        return currentElement() !== null;
    }

    function toggle() {
        if (isActive()) exit();
        else enter();
    }

    // Sync the UI with the browser's fullscreen state every time it
    // changes — including when the user presses Esc, clicks the
    // browser's own fullscreen exit, or any other code path enters
    // or exits fullscreen. This is the only reliable way to track
    // state across all browsers.
    function syncState() {
        const active = isActive();
        document.body.classList.toggle('is-fullscreen', active);
        if (active) {
            // Enter immersive mode: enable tab-bar auto-hide and
            // its listeners. The body.is-fullscreen class hides
            // the URL/nav bar via CSS.
            if (!tabBarAutoHideEnabled) {
                tabBarAutoHideEnabled = true;
                showTabBar();
                document.addEventListener('mousemove', showTabBarOnActivity);
                document.addEventListener('keydown', showTabBarOnActivity);
            }
            if (typeof showToast === 'function') {
                showToast('进入全屏模式', 'info', 1500);
            }
        } else {
            // Exit immersive mode: disable tab-bar auto-hide and
            // restore the tab bar to its normal visible state.
            tabBarAutoHideEnabled = false;
            clearTimeout(tabBarHideTimer);
            const tabBar = document.getElementById('tab-bar');
            if (tabBar) tabBar.classList.remove('auto-hidden');
            document.removeEventListener('mousemove', showTabBarOnActivity);
            document.removeEventListener('keydown', showTabBarOnActivity);
            if (typeof showToast === 'function') {
                showToast('退出全屏模式', 'info', 1500);
            }
        }
    }

    // Listen on both standard and webkit-prefixed events. The same
    // function handles both — syncState only reads the current
    // element, which is normalized above.
    document.addEventListener('fullscreenchange', syncState);
    document.addEventListener('webkitfullscreenchange', syncState);

    return { toggle, enter, exit, isActive, isAvailable };
})();

// Expose Fullscreen on window for testability and for any host-page
// scripts that want to wire their own UI to it. The module is a
// pure IIFE so this is the only way to share the reference.
window.Fullscreen = Fullscreen;

// ============================================
// Theme Switcher (Dark / Light / System)
// ============================================
const Theme = (() => {
    const STORAGE_KEY = 'ffTheme';
    const LIGHT_BTN = '🌙'; const DARK_BTN = '☀️'; const SYS_BTN = '🖥️';

    function getStored() { return localStorage.getItem(STORAGE_KEY); }
    function store(v) { localStorage.setItem(STORAGE_KEY, v); }

    function getInitialTheme() {
        const stored = getStored();
        if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
        if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
    }

    function apply(theme) {
        const html = document.documentElement;
        if (theme === 'system') {
            const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
            html.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
        } else {
            html.setAttribute('data-theme', theme);
        }
        // Broadcast the resolved theme to same-origin iframes (newtab.html,
        // bookmarks bar, settings panel previews) so they re-paint instead
        // of staying stuck on whatever they loaded with. The message shape
        // is additive — older iframes that don't handle {type:'theme'} just
        // ignore the post, so this stays a no-op for unrelated postMessage
        // listeners.
        const resolved = html.getAttribute('data-theme');
        // Collect all same-origin iframes: top-level and those inside
        // closed shadow roots (my-webappgroup). document.querySelectorAll
        // stops at shadow boundaries, so we also probe known host elements.
        const frames = [...document.querySelectorAll('iframe')];
        for (const host of [document.querySelector('my-webappgroup')]) {
            if (!host) continue;
            try {
                const sr = host.shadowRoot;
                if (sr) frames.push(...sr.querySelectorAll('iframe'));
            } catch (_) { /* closed shadow root — ignore */ }
        }
        frames.forEach((frame) => {
            try {
                frame.contentWindow?.postMessage(
                    { type: 'theme', theme: resolved },
                    location.origin == "file://" ? "*" : location.origin
                );
            } catch (_) { /* cross-origin / detached — ignore */ }
        });
        updateButton();
    }

    function updateButton() {
        const btn = $('theme-btn');
        if (!btn) return;
        const t = getStored() || 'system';
        btn.textContent = t === 'dark' ? DARK_BTN : t === 'light' ? LIGHT_BTN : SYS_BTN;
        btn.title = t === 'dark' ? '深色主题' : t === 'light' ? '浅色主题' : '跟随系统';
    }

    function set(theme) {
        store(theme);
        apply(theme);
        showToast(`主题：${theme === 'dark' ? '🌙 深色' : theme === 'light' ? '☀️ 浅色' : '🖥️ 跟随系统'}`, 'info', 1500);

        $('webappgroup').loadPrefs();
    }

    function toggle() {
        const current = document.documentElement.getAttribute('data-theme');
        set(current === 'dark' ? 'light' : 'dark');
    }

    // Init
    function init() {
        apply(getInitialTheme());
    };

    // Listen for system theme changes when in "system" mode
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getStored() === 'system' || !getStored()) apply('system');
    });

    return { init, set, toggle, updateButton, apply, getInitialTheme };
})();

// ============================================
// Settings Panel
// ============================================
// User-facing settings UI (gear icon in nav-bar opens it). The rows are
// rendered dynamically by JS so a new setting only needs a single schema
// entry, not an HTML edit. Each row declares its build-block (toggle /
// pill / button) and the handler that accepts the new value.
//
// Persistence has three sources of truth, evaluated in priority order:
//   1. URL flags (?vmouse=1, ?tour=1)         — overrides everything
//   2. localStorage entries                   — normal user prefs
//   3. Auto-detection / system default        — fallback
const Settings = (() => {
    const STORAGE_KEY = 'ffSettings';
    const DEFAULTS = {
        theme: 'auto',          // 'auto' | 'dark' | 'light' | 'system'
        language: 'auto',        // 'auto' | ISO 639-1 code
        // Startup
        restoreSession: true,   // reopen tabs from last session
        homepage: 'https://www.pwaos.net', // URL for new tabs / when no session is restored
        // User-Agent settings
        userAgentMode: 'default',  // 'default' | 'preset' | 'custom'
        userAgentPreset: 'desktop-chrome',  // preset identifier
        userAgentCustom: '',       // custom UA string
        // Proxy settings
        proxyEnabled: false,
        proxyType: 'http',         // 'http' | 'https' | 'socks4' | 'socks5'
        proxyHost: '',
        proxyPort: '8080',
        proxyUsername: '',
        proxyPassword: '',
        proxyBypass: 'localhost,127.0.0.1,*.local',
    };

    async function load() {
        try {
            const raw = await BrowserStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULTS };
            const o = JSON.parse(raw);
            return { ...DEFAULTS, ...o };
        } catch (_) { return { ...DEFAULTS }; }
    }
    async function save(v) {
        try { await BrowserStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch (_) {}
    }

    async function get(key) { return (await load())[key]; }
    async function set(key, value) {
        const cur = await load();
        cur[key] = value;
        await save(cur);
        // 'auto' theme = "follow OS / use default" = clear any prior explicit
        // Theme.toggle() choice. Do this here (user-initiated path) and not in
        // applySideEffects, because applySideEffects also runs at boot from
        // Settings.applyAll() — where theme='auto' is the default for new
        // users and clearing there would wipe their stored preference.
        if (key === 'theme' && value === 'auto') {
            localStorage.removeItem('ffTheme');
        }
        applySideEffects(key, value);
    }

    // Apply the persisted values to live subsystems (Theme, …).
    function applySideEffects(key, value) {
        if (key === 'theme') {
            if (value === 'auto') {
                // 'auto' means "follow OS / use default" — apply the default
                // visually. We deliberately do NOT touch ffTheme here: this
                // branch runs on every boot via Settings.applyAll(), and a
                // fresh user (no ffSettings stored) has theme='auto' by
                // default. Clearing ffTheme at boot would wipe a user's
                // explicit Theme.toggle() choice. When the user actively picks
                // 'auto' from the Settings panel, Settings.set('theme', 'auto')
                // handles the storage reset before applySideEffects runs.
                Theme.apply(Theme.getInitialTheme());
            } else {
                Theme.set(value);
            }
        }
        if (key === 'language') {
            if (value === 'auto') {
                // Re-initialise i18n: it already detects browser language,
                // and will re-apply all translations on re-init.
                window.i18n?.setLanguage(window.i18n.detectLanguage());
            } else {
                window.i18n?.setLanguage(value);
            }
        }
        if (key === 'userAgentMode' || key === 'userAgentPreset' || key === 'userAgentCustom') {
            applyUserAgent(key);
        }
        if (key === 'proxyEnabled' || key === 'proxyType' || key === 'proxyHost' || 
            key === 'proxyPort' || key === 'proxyUsername' || key === 'proxyPassword' || 
            key === 'proxyBypass') {
            applyProxySettings();
        }
    }

    // User-Agent presets
    const UA_PRESETS = {
        'desktop-chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'desktop-firefox': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'desktop-safari': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'mobile-chrome': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'mobile-safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    };

    function applyUserAgent(mode) {
        const v = load().then(function(v) {
            let ua = '';
            if (mode === 'userAgentPreset') {
                ua = UA_PRESETS[v.userAgentPreset] || UA_PRESETS['desktop-chrome'];
            } else if (mode === 'userAgentCustom') {
                ua = v.userAgentCustom;
            } else {
                ua = navigator.userAgent;
            }

            // For PwaOS, we can set the UA via postMessage
            if (is_pwaos && currentTab?.app_id) {
                const wg = $('webappgroup');
                const remote_app = wg.getActiveElement().remote_app;
                if (remote_app) {
                    remote_app.setUserAgent(ua);
                }
            }
            
            // For standalone mode, we need to reload the iframe with a custom UA
            // This is limited - browsers don't allow setting UA on iframe directly
            // We can use a workaround with a proxy or accept the limitation
            if (!is_pwaos) {
                console.log('User-Agent override:', ua, '(Note: iframe UA override not fully supported in standalone mode)');
            }
        });
    }

    function applyProxySettings() {
        load().then(function(v) {
            if (v.proxyEnabled && v.proxyHost && v.proxyPort) {
                const proxyConfig = {
                    type: v.proxyType,
                    host: v.proxyHost,
                    port: parseInt(v.proxyPort, 10),
                    username: v.proxyUsername,
                    password: v.proxyPassword,
                    bypass: v.proxyBypass,
                };
                
                if (pwaos_.Settings) {
                    pwaos_.Settings.setProxy(JSON.stringify(proxyConfig)).then(function(result) {
                        console.log(result);
                    }).catch(err => console.log('setProxy failed:\n', err));
                }
            } else {
                showToast('Please setup proxy firstly!', 'info', 1800);
            }
        });
    }

    async function applyAll() {
        const v = await load();
        applySideEffects('theme', v.theme);
        applySideEffects('language', v.language);
        applySideEffects('userAgentMode', v.userAgentMode);
        applySideEffects('proxyEnabled', v.proxyEnabled);

        handleUrlInputSearchEngine();
    }

    // ---------------------------------------------------- UI rendering
    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, val] of Object.entries(attrs)) {
            if (k === 'class') node.className = val;
            else if (k === 'text') node.textContent = val;
            else if (k.startsWith('on') && typeof val === 'function') {
                node.addEventListener(k.slice(2).toLowerCase(), val);
            } else node.setAttribute(k, val);
        }
        for (const c of children) {
            if (c == null) continue;
            if (typeof c === 'string') node.appendChild(document.createTextNode(c));
            else node.appendChild(c);
        }
        return node;
    }

    function row({ id, label, desc, ctl }) {
        return el('div', { class: 'settings-row', 'data-row': id },
            el('div', { class: 'settings-row-info' },
                el('div', { class: 'settings-row-label', text: label }),
                desc ? el('div', { class: 'settings-row-desc', text: desc }) : null,
            ),
            ctl,
        );
    }
    function toggleControl(id, value, onChange) {
        const ctl = el('button', {
            class: 'settings-toggle' + (value ? ' on' : ''),
            role: 'switch',
            'aria-checked': value ? 'true' : 'false',
            'aria-label': id,
            type: 'button',
        });
        ctl.addEventListener('click', () => {
            const next = !ctl.classList.contains('on');
            ctl.classList.toggle('on', next);
            ctl.setAttribute('aria-checked', next ? 'true' : 'false');
            onChange(next);
        });
        return ctl;
    }
    function pillControl(id, value, options, onChange) {
        const wrap = el('div', { class: 'settings-pills' });
        options.forEach(({ value: v, label }) => {
            const p = el('button', {
                class: 'settings-pill' + (v === value ? ' active' : ''),
                type: 'button',
                'data-value': v,
            }, label);
            p.addEventListener('click', () => {
                wrap.querySelectorAll('.settings-pill').forEach(b => b.classList.remove('active'));
                p.classList.add('active');
                onChange(v);
            });
            wrap.appendChild(p);
        });
        return wrap;
    }
    function buttonControl(label, opts) {
        const b = el('button', {
            class: 'settings-button' + (opts?.danger ? ' danger' : ''),
            type: 'button',
        }, label);
        b.addEventListener('click', () => opts.onClick());
        return b;
    }

    function render() {
        handleUrlInputSearchEngine();

        const body = document.querySelector('#settings-panel .settings-body');
        if (!body) return;

        load().then(function(v) {
            body.innerHTML = '';

            const sections = [
                {
                    title: i18n.t('appearance'),
                    rows: [
                        row({
                            id: 'theme',
                            label: i18n.t('theme'),
                            desc: i18n.t('themeDesc'),
                            ctl: pillControl('theme', v.theme, [
                                { value: 'auto',   label: i18n.t('auto') },
                                { value: 'dark',   label: i18n.t('dark') },
                                { value: 'light',  label: i18n.t('light') },
                            ], (next) => set('theme', next)),
                        }),
                    ],
                },
                {
                    title: i18n.t('languageSection'),
                    rows: [
                        row({
                            id: 'language',
                            label: i18n.t('interfaceLanguage'),
                            desc: i18n.t('languageDesc'),
                            ctl: (() => {
                                const sel = el('select', { class: 'settings-select' });
                                const opts = [{ value: 'auto', label: i18n.t('followSystem') }];
                                for (const o of (window.i18n?.getLanguageOptions() || [])) {
                                    opts.push({ value: o.code, label: o.native });
                                }
                                Settings.get('language').then(function(v){
                                    opts.forEach(({ value: val, label }) => {
                                        const opt = el('option', { value: val }, label);
                                        if (val === v) opt.selected = true;
                                        sel.appendChild(opt);
                                    });
                                });
                                sel.addEventListener('change', () => {
                                    Settings.set('language', sel.value);
                                    render();
                                });
                                return sel;
                            })(),
                        }),
                    ],
                },
                {
                    title: i18n.t('userAgent'),
                    rows: [
                        row({
                            id: 'userAgentPreset',
                            label: i18n.t('userAgent'),
                            desc: i18n.t('userAgentDesc'),
                            ctl: (() => {
                                const sel = el('select', { class: 'settings-select' });
                                const presets = [
                                    { value: 'default', label: i18n.t('default') },
                                    { value: 'desktop-chrome', label: 'Desktop Chrome' },
                                    { value: 'desktop-firefox', label: 'Desktop Firefox' },
                                    { value: 'desktop-safari', label: 'Desktop Safari' },
                                    { value: 'mobile-chrome', label: 'Mobile Chrome' },
                                    { value: 'mobile-safari', label: 'Mobile Safari' },
                                ];
                                presets.forEach(p => {
                                    const opt = el('option', { value: p.value }, p.label);
                                    if (p.value === v.userAgentPreset) opt.selected = true;
                                    sel.appendChild(opt);
                                });
                                sel.addEventListener('change', () => {
                                    set('userAgentPreset', sel.value);
                                    render();
                                });
                                return sel;
                            })(),
                        }),
                    ],
                },
                {
                    title: i18n.t('proxy'),
                    rows: [
                        row({
                            id: 'proxyEnabled',
                            label: i18n.t('proxy'),
                            desc: i18n.t('proxyDesc'),
                            ctl: toggleControl('proxy', v.proxyEnabled, (next) => {
                                set('proxyEnabled', next);
                                render();
                            }),
                        }),
                    ],
                },
                {
                    title: i18n.t('data'),
                    rows: [
                        row({
                            id: 'clear-prefs',
                            label: i18n.t('clearPrefs'),
                            desc: i18n.t('clearPrefsDesc'),
                            ctl: buttonControl(i18n.t('clearPrefsBtn'), {
                                danger: true,
                                onClick: () => {
                                    if (v.theme)         localStorage.removeItem('ffTheme');
                                    localStorage.removeItem(STORAGE_KEY);
                                    showToast(i18n.t('prefsCleared'), 'info', 1800);
                                    hideSettings();
                                },
                            }),
                        }),
                    ],
                },
            ];

            for (const sec of sections) {
                const secEl = el('section', { class: 'settings-section' },
                    el('div', { class: 'settings-section-title', text: sec.title }));
                for (const r of sec.rows) secEl.appendChild(r);
                body.appendChild(secEl);
            }
        });
    }

    // ---------------------------------------------------- open/close
    function open() {
        render();
        const panel = document.getElementById('settings-panel');
        if (!panel) return;
        panel.hidden = false;
        // Focus the first interactive row for keyboard users
        const first = panel.querySelector('button, [tabindex]');
        first?.focus?.();
    }
    function close() {
        const panel = document.getElementById('settings-panel');
        if (panel) panel.hidden = true;
    }
    function toggle() {
        const panel = document.getElementById('settings-panel');
        if (!panel) return;
        if (panel.hidden) open(); else close();
    }
    function hideSettings() { close(); }

    function init() {
        // Close on outside click — reusing handleOutsideClick is wired in
        // initBrowser() because Settings opens a panel just like the others.
        document.querySelector('#settings-panel .settings-close')?.addEventListener('click', close);
        document.getElementById('settings-btn')?.addEventListener('click', toggle);
        applyAll();

        // The Settings panel builds its rows via DOM construction in
        // render(), with text pulled from i18n.t(...) at build time.
        // i18n.apply() (called by setLanguage) only updates elements
        // with data-i18n attributes — it can't reach the panel's
        // freshly-built rows. So when the user changes language, we
        // explicitly re-render the panel to pick up the new strings.
        window.addEventListener('languagechange', () => {
            render();
        });
    }

    return {
        init, open, close, toggle, render,
        get, set, applyAll,
        _state: load,
        _DEFAULTS: DEFAULTS,
        _STORAGE_KEY: STORAGE_KEY,
    };
})();

// ============================================
// Command Palette (Ctrl+Shift+P) — fuzzy command search
// ============================================
const CommandPalette = (() => {
    const COMMANDS = [
        { label: i18n.t('newTab'), shortcut: 'Ctrl+T', action: () => addTab() },
        { label: '关闭当前标签页', shortcut: 'Ctrl+W', action: () => currentTab && closeTab(currentTab) },
        { label: '恢复关闭的标签页', shortcut: 'Ctrl+Shift+T', action: () => restoreClosedTab() },
        { label: i18n.t('findInPage'), shortcut: 'Ctrl+F', action: () => FindBar.open() },
        { label: i18n.t('pageInfo'), shortcut: 'Ctrl+I', action: () => PageInfo.toggle() },
        { label: '全屏模式', shortcut: 'F11', action: () => Fullscreen.toggle() },
        { label: '静音/取消静音', shortcut: 'Ctrl+M', action: () => currentTab && toggleMute(currentTab) },
        { label: i18n.t('newWindow'), shortcut: 'Ctrl+N', action: () => window.open(location.href, '_blank') },
        { label: '打开新标签页', shortcut: 'Ctrl+L then Enter', action: () => { $('url-input')?.focus(); $('url-input')?.select(); } },
        { label: i18n.t('bookmarkBar'), shortcut: 'Ctrl+B (toggle)', action: () => toggleSidebar() },
        { label: i18n.t('history'), shortcut: '', action: () => { toggleSidebar(); switchSidebarView('history'); } },
        { label: i18n.t('downloads'), shortcut: '', action: () => { toggleSidebar(); switchSidebarView('downloads'); } },
        { label: i18n.t('bookmarks'), shortcut: 'Ctrl+Shift+O', action: () => { toggleSidebar(); switchSidebarView('bookmarks'); } },
        { label: '缩放放大', shortcut: 'Ctrl++', action: () => adjustZoom(ZOOM_STEP) },
        { label: '缩放缩小', shortcut: 'Ctrl+-', action: () => adjustZoom(-ZOOM_STEP) },
        { label: '重置缩放', shortcut: 'Ctrl+0', action: () => resetZoom() },
        { label: i18n.t('zoomTextOnly'), shortcut: 'Ctrl+Shift+=', action: () => toggleTextZoomOnly() },
        { label: '🌙 ' + i18n.t('dark'), shortcut: '', action: () => Theme.set('dark') },
        { label: '☀️ ' + i18n.t('light'), shortcut: '', action: () => Theme.set('light') },
        { label: '🖥️ ' + i18n.t('followSystem'), shortcut: '', action: () => Theme.set('system') },
        { label: '⚙️ ' + i18n.t('settings'), shortcut: '', action: () => Settings.open() },
    ];

    let current = 0;

    function filter(q) {
        if (!q) return COMMANDS;
        const lower = q.toLowerCase();
        return COMMANDS.filter(c => c.label.toLowerCase().includes(lower));
    }

    function render(results) {
        const container = $('cmd-results');
        container.innerHTML = results.map((c, i) => `
            <div class="cmd-item${i === current ? ' highlighted' : ''}" data-index="${i}">
                <span class="cmd-label">${c.label}</span>
                ${c.shortcut ? `<span class="cmd-shortcut">${c.shortcut}</span>` : ''}
            </div>
        `).join('');

        // Event delegation: one click + one mouseenter listener replaces N pairs.
        if (!container._cmdDelegate) {
            container._cmdDelegate = true;
            container.addEventListener('click', e => {
                const item = e.target.closest('.cmd-item');
                if (item) execute(parseInt(item.dataset.index, 10), results);
            });
            container.addEventListener('mousemove', e => {
                const item = e.target.closest('.cmd-item');
                if (item && parseInt(item.dataset.index, 10) !== current) {
                    current = parseInt(item.dataset.index, 10);
                    render(results);
                }
            });
        }
    }

    function execute(index, results) {
        if (!results[index]) return;
        results[index].action();
        close();
    }

    // Guards against the keydown's default focus restore to <body>
    // firing focusout and immediately closing the palette we just opened.
    let openGuard = 0;
    function open() {
        $('cmd-palette').hidden = false;
        const inp = $('cmd-input');
        inp.value = '';
        inp.focus();
        current = 0;
        render(COMMANDS);
        openGuard = 1;
        setTimeout(() => { openGuard = 0; }, 0);
    }

    function close() {
        $('cmd-palette').hidden = true;
    }

    // Close the palette when the input loses focus to something outside the
    // palette. We use `focusout` instead of click-outside because:
    //   - It's semantically correct: a dialog that asks for input should
    //     dismiss when the user stops interacting with it.
    //   - Click-outside requires hits-testing every clickable ancestor and
    //     breaks for elements added/removed mid-click.
    // `focusout` bubbles (unlike `blur`), so listening on the palette
    // container catches focus changes from any descendant — but the
    // real focusable target is `#cmd-input`, and the cmd-results items
    // aren't focusable, so the listener stays on the input itself.
    // relatedTarget tells us where focus went; if it's null or outside
    // `#cmd-palette`, the user dismissed. The microtask defers the check
    // past synchronous focus moves (e.g. action execution that focuses a
    // different control right after the click).
    function handleFocusOut(e) {
        if (openGuard) return;
        const next = e.relatedTarget;
        setTimeout(() => {
            if (openGuard) return;
            const inp = $('cmd-input');
            // Re-check: input may have been re-focused by another handler
            // (e.g. a command that focuses the URL bar).
            if (document.activeElement === inp) return;
            if (!next || !$('cmd-palette').contains(next)) close();
        }, 0);
    }

    function toggle() {
        if ($('cmd-palette').hidden) open();
        else close();
    }

    function handleKey(e) {
        if (e.key === 'Escape') { close(); return; }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const results = filter($('cmd-input').value);
            current = (current + 1) % results.length;
            render(results);
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const results = filter($('cmd-input').value);
            current = (current - 1 + results.length) % results.length;
            render(results);
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const results = filter($('cmd-input').value);
            execute(current, results);
        }
    }

    $('cmd-input')?.addEventListener('keydown', handleKey);
    $('cmd-input')?.addEventListener('input', () => { current = 0; render(filter($('cmd-input').value)); });
    $('cmd-input')?.addEventListener('focusout', handleFocusOut);

    return { open, close, toggle };
})();

// ============================================
// Keyboard Shortcuts
// ============================================
function handleKeyboardShortcuts(e) {
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && e.key === 't') { e.preventDefault(); addTab(); }
    else if (cmd && e.shiftKey && e.key === 'T') { e.preventDefault(); restoreClosedTab(); }
    else if (cmd && e.key === 'i') { e.preventDefault(); PageInfo.toggle(); }
    else if (cmd && e.key === 'w') { e.preventDefault(); currentTab && closeTab(currentTab); }
    else if (cmd && e.key === 'l') { e.preventDefault(); $('url-input')?.focus(); $('url-input')?.select(); }
    else if (cmd && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (cmd && e.key === 'd') { e.preventDefault(); toggleBookmark(); }
    else if (cmd && e.key === 'm') { e.preventDefault(); currentTab && toggleMute(currentTab); }
    else if (cmd && e.key === 'n') { e.preventDefault(); openNewWindow(); }
    else if (cmd && e.key === 'f') { e.preventDefault(); FindBar.open(); }
    else if (cmd && e.shiftKey && e.key === 'P') { e.preventDefault(); CommandPalette.toggle(); }
    else if (cmd && e.key === '0') { e.preventDefault(); resetZoom(); }
    // Text zoom: Ctrl+Shift+= / Ctrl+Shift+- (Shift variants FIRST —
    // with Shift held, e.key is '+', '_', or still '='/'-' depending on
    // layout, so match e.code which is layout-independent).
    else if (cmd && e.shiftKey && (e.code === 'Equal' || e.key === '+' || e.key === '=')) { e.preventDefault(); adjustTextZoom(TEXT_ZOOM_STEP); }
    else if (cmd && e.shiftKey && (e.code === 'Minus' || e.key === '-' || e.key === '_')) { e.preventDefault(); adjustTextZoom(-TEXT_ZOOM_STEP); }
    // Page zoom: Ctrl+= / Ctrl+- (reached only when Shift wasn't held,
    // since the shift branches above match and return first).
    else if (cmd && (e.code === 'Equal' || e.key === '+' || e.key === '=')) { e.preventDefault(); adjustZoom(ZOOM_STEP); }
    else if (cmd && (e.code === 'Minus' || e.key === '-')) { e.preventDefault(); adjustZoom(-ZOOM_STEP); }
    else if (cmd && e.key === 'Tab') { e.preventDefault(); doTabCycle(e.shiftKey ? -1 : 1); }
    else if (cmd && e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); clearAllHistory(); }
    else if (cmd && e.key === 'p') { e.preventDefault(); window.print?.(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    else if (e.key === 'F11') { e.preventDefault(); Fullscreen.toggle(); }
    else if (e.key === 'F5') { e.preventDefault(); toggleReload(); }
}

// ============================================
// Find Bar (Ctrl+F) — in-page text search
// ============================================
const FindBar = (() => {
    let matches = [];   // Text node + offset pairs
    let cursor = 0;     // current match index
    let dialogOpen = false;

    function rootDocument() {
        // Search inside the active webapp's iframe if present, else top-level document
        const frame = document.querySelector('iframe[name="pwaos-app"], my-webappgroup');
        return frame && frame.contentDocument ? frame.contentDocument : document;
    }

    function clearHighlights(doc) {
        doc.querySelectorAll('mark.find-current, mark.find-other').forEach(m => {
            const t = doc.createTextNode(m.textContent);
            m.parentNode.replaceChild(t, m);
        });
        // Merge adjacent text nodes back
        doc.body?.normalize?.();
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function updateCount() {
        if (!matches.length) return;
        $('find-count').textContent = `${cursor + 1} / ${matches.length}`;
        $('find-count').classList.remove('no-match');
    }

    function highlightCurrent(scrollIntoView = false) {
        matches.forEach((m, i) => {
            m.mark.className = i === cursor ? 'find-current' : 'find-other';
        });
        if (scrollIntoView && matches[cursor]) {
            matches[cursor].mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        updateCount();
    }

    function step(delta) {
        const webAppView = $('webappgroup');
        const remote_app = webAppView.getActiveElement().remote_app;
        const query = $('find-input').value.trim();
        remote_app.findText(query, delta, false, true).then(function(val) {
            console.log('Found ' + val);
        });
        if (!matches.length) return;
        cursor = (cursor + delta + matches.length) % matches.length;
        highlightCurrent(true);
    }

    function open() {
        if (dialogOpen) return;
        dialogOpen = true;
        const bar = $('find-bar');
        bar.hidden = false;
        const inp = $('find-input');
        inp.focus();
        inp.select();
    }

    function close() {
        if (!dialogOpen) return;
        dialogOpen = false;
        const bar = $('find-bar');
        bar.hidden = true;
        $('find-count').textContent = '';
        clearHighlights(rootDocument());
        matches = [];
        cursor = 0;
    }

    return { open, close, step };
})();
window.FindBar = FindBar;

// ============================================
// PWA Functions
// ============================================
async function installPWA() {
    if (!deferredPrompt) {
        console.log('No install prompt available');
        return false;
    }
    
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
        console.log('User accepted PWA install');
    } else {
        console.log('User dismissed PWA install');
    }
    
    deferredPrompt = null;
    return outcome === 'accepted';
}

// ============================================
// Expose API
// ============================================
window.BrowserApp = {
    addTab,
    closeTab,
    navigateToUrl,
    toggleBookmark,
    getBookmarks: () => bookmarks,
    getHistory: () => history,
    isPWAInstalled: () => isPWAInstalled,
    installPWA,
    setZoom,
    adjustZoom,
    resetZoom,
    getZoom: () => currentTab?._zoom ?? 1
};
