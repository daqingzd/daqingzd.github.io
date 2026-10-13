class WebAppGroup extends HTMLElement {

    constructor() {
        super();
    }

    connectedCallback() {
        let root = this;
        this.tabIndex = -1;

        this._iframe = document.createElement('iframe');
        this._iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;';
        this._iframe.tabIndex = 0;
        this._iframe.addEventListener('load', function() {
            root.hideLoadingPlaceholder();
            root.dispatchEvent(new CustomEvent('load'));
        });

        // Loading placeholder shown while PwaOS is rendering a navigation
        this._loadingOverlay = document.createElement('div');
        this._loadingOverlay.className = 'webappgroup-loading-overlay';
        const _sp = document.createElement('div');
        _sp.className = 'webappgroup-loading-spinner';
        const _tx = document.createElement('div');
        _tx.className = 'webappgroup-loading-text';
        _tx.setAttribute('data-i18n', 'loading');
        _tx.textContent = 'Loading…';
        this._loadingOverlay.appendChild(_sp);
        this._loadingOverlay.appendChild(_tx);
        this._loadingOverlay.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:var(--bg-primary);z-index:1;color:var(--text-secondary);font-size:14px;';

        this.appendChild(this._loadingOverlay);
        this.appendChild(this._iframe);
        this.apps = new Map();
        this.pending_apps = new Map();
    }

    disconnectedCallback() {
        if (typeof(pwaos_) != 'undefined') {
            for (const [app_id, app] of this.apps) {
                if (app)
                    pwaos_.appManager.closeApp(app_id);
            }
            for (const [app_id, app] of this.pending_apps) {
                if (app)
                    pwaos_.appManager.closeApp(app_id);
            }
            pwaos_.appManager.closeApp(this.curr_app_id);
        }
    }

    // Public placeholder API — same surface as StandaloneWebAppGroup so
    // script.js can call showLoadingPlaceholder()/hideLoadingPlaceholder()
    // uniformly without caring which runtime is active.
    showLoadingPlaceholder(text) {
        if (!this._loadingOverlay) return;
        if (text) {
            const t = this._loadingOverlay.querySelector('.webappgroup-loading-text');
            if (t) t.textContent = text;
        }
        this._loadingOverlay.style.visibility = 'visible';
    }

    hideLoadingPlaceholder() {
        if (this._loadingOverlay) {
            this._loadingOverlay.style.visibility = 'hidden';
        }

        if (document.activeElement == this)
            pwaos_.windowManager.focus(this.curr_app_id);
    }

    init() {
        let root = this;

        root.LOG_VERBOSE = false;

        if (typeof(pwaos_) != 'undefined') {
            this.browser_app_id = pwaos.INVALID_APP_ID;
            pwaos_.appManager.getCurrentAppID().then(function(value) {
                root.browser_app_id = value.appId;
                if (root.LOG_VERBOSE) console.log("browser_app_id is " + root.browser_app_id);
            });
   		    pwaos_.registerEvent('appManager', 'onAppDestroyed', (e) => {
                let app_id = e;
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is destroyed");
                if (root.browser_app_id == app_id) return;

                let app = root.apps.get(app_id);
                if (app) {
                    root.removeChild(app);
                    root.apps.delete(app_id);
                    app = null;
                }
		    });
            pwaos_.registerEvent('appManager', 'onAppCreated', (e) => {
                let app_id = e;
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is created");

                pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                    if (app_id != value.info.appId) return;
                    if (value.info.type != pwaos.AppType.kEmbedContents) return;

                    root.sendToEvent('onNewWebViewCreated', app_id);
                });
            });
            pwaos_.registerEvent('appManager', 'onAppSynchronized', (e) => {
                let app_id = e;
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is synchronized");
                if (root.browser_app_id == app_id) return;
                if (!root.curr_app_id) {
                    let urlObj = new URL(root._iframe.getAttribute('src'), document.baseURI);
                    let page_app_id = urlObj.searchParams.get('app_id') || '';

                    if (page_app_id == app_id)
                        root.curr_app_id = app_id;
                }
            });
            pwaos_.registerEvent('appManager', 'onAppStopped', (reason, app_id) => {
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is stopped");
                if (reason == "Normal") return;
                if (root.browser_app_id == app_id) return;

                pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                    if (root.curr_app_id == app_id)
                        root.loadSpecialPageByAppStatus(app_id, value.info.status);
                });
            });
            pwaos_.registerEvent('appManager', 'onShowContextMenu', (params, app_id) => {
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is doing ShowContextMenu");
                if (root.browser_app_id == app_id && !params.frame_url) return;

                root.sendToEvent('onShowContextMenu', params);
            });
            pwaos_.registerEvent('appManager', 'onHideContextMenu', (app_id) => {
                if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is doing HideContextMenu");
                root.sendToEvent('onHideContextMenu', app_id);
            });
            pwaos_.registerEvent('windowManager', 'onWindowBoundsChanged', (x,y,w,h) => {
            });
            pwaos_.registerEvent('windowManager', 'onToggleFullscreen', (fullscreen, app_id) => {
                root.sendToEvent('onToggleFullscreen', fullscreen.toLowerCase() === 'true');
            });
            pwaos_.registerEvent('installManager', 'onAppInstalled', (e) => {
              let app_id = e;
              if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is installed");
            });
            pwaos_.registerEvent('installManager', 'onAppUninstalled', (e) => {
              let app_id = e;
              if (root.LOG_VERBOSE) console.log("ID: " + app_id + " is uninstalled");
            });
            this.evt_ = new EventTarget();
        }
        return true;
    }

    /*attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'title') {
        this._render();
      }
    }*/

    invalidate(app_id) {
        for (const key of this.apps.keys()) {
            if (app_id == key) {
                this.current_app = this.apps.get(app_id);
                this.showPage(this.current_app);
            } else {
                this.hidePage(this.apps.get(key));
            }
        }
    }

    get curr_app_id() {
        if (this.current_app)
            return this.current_app.pwa_app_id;

        return "";
    }

    set curr_app_id(app_id) {
        let root = this;
        if (!app_id) {
            if (this.current_app) {
                this.hidePage(this.current_app);
                this.current_app = null;
            } else {
                for (const key of this.apps.keys())
                    this.hidePage(this.apps.get(key));
            }
            this.showPage(this._iframe);
            return;
        }

        if (!this.apps.get(app_id)) {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value.info.type == pwaos.AppType.kEmbedContents) {
                    // Find from pending_apps
                    let webview = root.pending_apps.get(app_id);
                    if (webview)
                        root.pending_apps.delete(app_id);
                    else
                        webview = document.createElement('webappview');

                    webview.tabIndex = 0;
                    root.appendChild(webview);
                    webview.attachGuest(app_id, value.info.guestInstanceId).then(function(result) {
                        if (result) {
                            let prefs = new pwaos.AppPrefs;
                            prefs.preferredColorScheme = document.documentElement.getAttribute('data-theme');
                            webview.remote_app.setPreferences(prefs);
                        }
                    });

                    root.hidePage(root._iframe);
                    root.apps.set(app_id, webview);
                    root.invalidate(app_id);
                }
            });
        } else {
            root.hideLoadingPlaceholder();

            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value.info.status == pwaos.AppStatus.kSynchronized) {
                    pwaos_.appManager.getLoadingInfo(app_id).then(function(v) {
                        if (v.info.firstLoad == false) root.showLoadingPlaceholder();
                    });
                }
                else
                    root.loadSpecialPageByAppStatus(app_id, value.info.status);
            });

            root.invalidate(app_id);
        }
    }

    get src() {
        if (this._iframe)
            return this._iframe.getAttribute('src');
        return "";
    }

    set src(value) {
        if (typeof(pwaos_) != 'undefined') {
            this.hidePage(this._iframe);

            if (this.curr_app_id)
                pwaos_.appManager.loadUrl(this.curr_app_id, value);
        } else if (this._iframe) {
            this._iframe.setAttribute('src', value);
        }
    }

    isSpecialPage(url) {
        const InternalPages = [
            "crash.html",
            "newtab.html",
            "network_error.html",
            "settings.html",
            "library.html",
        ];

        const urlObj = new URL(url, document.baseURI);
        const path = urlObj.pathname;
        const fileName = path.split('/').pop();

        return InternalPages.includes(fileName);
    }

    hidePage(page) {
        page.style.zIndex = 0;
        page.style.opacity = 0;
        page.style.pointerEvents = 'none';
        page.style.visibility = 'hidden';
    }

    showPage(page) {
        page.style.zIndex = 10;
        page.style.opacity = 1;
        page.style.pointerEvents = 'auto';
        page.style.visibility = 'visible';
    }

    loadInternalPage(url) {
        if (!url || !this.isSpecialPage(url))
            return;

        this.curr_app_id = "";
        this.showPage(this._iframe);
        if (this._iframe.getAttribute('src') != url)
            this._iframe.setAttribute('src', url);
    }

    loadSpecialPageByAppStatus(app_id, app_status) {
        var pageUrl;
        if (app_status == pwaos.AppStatus.kNetworkFailure)
            pageUrl = "network_error.html";
        else if (app_status == pwaos.AppStatus.kRenderUnresponsive
                 || app_status == pwaos.AppStatus.kRenderProcessGone)
            pageUrl = "crash.html";

        let urlObj = new URL(pageUrl, document.baseURI);
        urlObj.searchParams.set('app_id', app_id);

        this.loadInternalPage(urlObj.toString());
    }

    async loadUrl(url, app_id) {
        if (typeof(pwaos_) != 'undefined') {
            if (!app_id) {
                const value = await this.createApp(url);
                if (value?.app?.id) {
                    const result = this.apps.get(value.app.id).attachGuest(value.app.guestInstanceId);
                    if (result) {
                        this.hidePage(this._iframe);
                    } else {
                        pwaos_.appManager.closeApp(value.app.id);
                    }
                }
                return value;
            } else {
                if (this.apps.get(app_id)) {
                    this.hidePage(this._iframe);
                    pwaos_.appManager.loadUrl(app_id, url);
                    return true;
                }
            }
        } else
            this.src = url;
    }

    async goBack(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value?.info.appId == app_id)
                    return pwaos_.appManager.goBack(app_id);
            });
        } else if (this._iframe) {
            this._iframe.contentWindow.history.back();
        }
    }

    async goForward(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value?.info.appId == app_id)
                    return pwaos_.appManager.goForward(app_id);
            });
        } else if (this._iframe) {
            this._iframe.contentWindow.history.forward();
        }
    }

    async reload(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value?.info.appId == app_id)
                    return pwaos_.appManager.reload(app_id);
            });
        } else if (this._iframe) {
            this._iframe.contentWindow.history.reload();
        }
    }

    stop(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value?.info.appId == app_id)
                    pwaos_.appManager.stop(app_id);
            });
        } else if (this._iframe) {
            this._iframe.contentWindow.stop();
        }
    }

    closeApp(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            this.apps.get(app_id).remove();
            this.apps.delete(app_id);
        }
    }

    debugApp(app_id) {
        if (typeof(pwaos_) != 'undefined') {
            pwaos_.appManager.getAppInfo(app_id).then(function(value) {
                if (value?.info.appId == app_id)
                    pwaos_.appManager.debugApp(app_id);
            });
        }
    }

    getActiveElement() {
        if (!this.curr_app_id)
            return this._iframe;
        else
            return this.apps.get(this.curr_app_id);
    }

    registerEvent(eventType, func) {
        let pwaosEvent_dispatcher = function(e) {
            if (e.argc == 0)
                func(e);
            else if (e.argc > 0 && e.argc < 30) {
                func.apply(null, e.argv);
            } else
                console.log("Unsupported now, argc is " + e.argc);
        }
        this.evt_.addEventListener(eventType, pwaosEvent_dispatcher);
    }

    sendToEvent(eventType, ...args) {
        let e = new CustomEvent(eventType);
        e.argc = 0;
        e.argv = new Array();

        for (let item of args) {
            e.argv[e.argc] = item;
            e.argc ++;
        }

        this.evt_.dispatchEvent(e);
    }

    async createApp(url, sessionId) {
        var rect = new pwaos.Rect({
          x: this.getBoundingClientRect().left,
          y: this.getBoundingClientRect().top,
          width: this.clientWidth,
          height: this.clientHeight,
        });

        var webview = document.createElement('webappview');
        if (sessionId)
            webview.session_id = sessionId;
        const value = await webview.loadApp(url, rect);
        if (!value?.app?.id){
            this.removeChild(webview);
            webview.remove();
            webview = null;
            return undefined;
        }

        this.pending_apps.set(value.app.id, webview);
        return value;
    }

    loadPrefs() {
        const prefs = new pwaos.AppPrefs;
        prefs.preferredColorScheme = document.documentElement.getAttribute('data-theme');

        for (const [, app] of this.apps) {
            if (app?.remote_app) {
                app.remote_app.setPreferences(prefs);
            }
        }
    }
}
