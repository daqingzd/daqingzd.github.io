// Standalone fallback for when PwaOS is not available
class StandaloneWebAppGroup extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this._iframe = document.createElement('iframe');
        this._iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;';

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

        this._currentUrl = '';
        this._isLoading = false;
        this._iframe.addEventListener('load', () => {
            this._isLoading = false;
            this._hideLoadingOverlay();
            this._dispatchLoading();
        });
        this._iframe.addEventListener('error', () => {
            this._isLoading = false;
            this._hideLoadingOverlay();
            this._dispatchLoading();
        });
    }

    _dispatchLoading() {
        this.dispatchEvent(new CustomEvent('loadingchange', { detail: { loading: this._isLoading } }));
    }

    disconnectedCallback() {
        if (this._iframe) {
            this._iframe.remove();
            this._iframe = null;
        }
        if (this._loadingOverlay) {
            this._loadingOverlay.remove();
            this._loadingOverlay = null;
        }
    }

    init() {
        return true;
    }

    get src() {
        return this._currentUrl;
    }

    set src(url) {
        this._currentUrl = url;
        if (this._iframe) {
            this._isLoading = true;
            this._showLoadingOverlay();
            this._dispatchLoading();
            this._iframe.src = url;
        }
    }

    get curr_app_id() {
        return '';
    }

    set curr_app_id(app_id) {
        // No-op in standalone mode
    }

    get isLoading() {
        return this._isLoading;
    }

    // Public API: show/hide the loading overlay explicitly (used by
    // script.js navigateToUrl() so a placeholder is visible from the moment
    // a new tab begins navigation, before the iframe 'load' fires).
    showLoadingPlaceholder(text) {
        if (!this._loadingOverlay) return;
        if (text) {
            const t = this._loadingOverlay.querySelector('.webappgroup-loading-text');
            if (t) t.textContent = text;
        }
        this._loadingOverlay.style.display = 'flex';
    }

    hideLoadingPlaceholder() {
        this._hideLoadingOverlay();
    }

    _showLoadingOverlay() {
        if (this._loadingOverlay) this._loadingOverlay.style.display = 'flex';
    }

    _hideLoadingOverlay() {
        if (this._loadingOverlay) this._loadingOverlay.style.display = 'none';
    }

    loadNewTabPage(url) {
        this.src = url || 'newtab.html';
    }

    async loadUrl(url) {
        this.src = url;
        return { app: { id: null } };
    }

    goBack() {
        if (this._iframe && this._iframe.contentWindow) {
            this._iframe.contentWindow.history.back();
        }
    }

    goForward() {
        if (this._iframe && this._iframe.contentWindow) {
            this._iframe.contentWindow.history.forward();
        }
    }

    reload() {
        if (this._iframe) {
            this._isLoading = true;
            this._showLoadingOverlay();
            this._dispatchLoading();
            // Force the iframe to actually reload — assigning the same
            // src to itself is a no-op in modern browsers (no load event
            // fires), which would leave _isLoading=true forever and the
            // UI reload spinner spinning indefinitely. Replace the node
            // with a fresh iframe at the same src so the user gets
            // a guaranteed fresh document.
            const old = this._iframe;
            const parent = old.parentNode;
            const src = old.getAttribute('src') || 'about:blank';
            const fresh = document.createElement('iframe');
            fresh.style.cssText = old.style.cssText;
            fresh.addEventListener('load', () => {
                this._isLoading = false;
                this._hideLoadingOverlay();
                this._dispatchLoading();
            });
            fresh.addEventListener('error', () => {
                this._isLoading = false;
                this._hideLoadingOverlay();
                this._dispatchLoading();
            });
            // Build the new node before removing the old one so we
            // never have an empty webappgroup frame.
            fresh.setAttribute('src', src);
            parent.replaceChild(fresh, old);
            this._iframe = fresh;
        }
    }

    closeApp(app_id) {
        // No-op in standalone mode
    }

    debugApp(app_id) {
        console.log('Debug not available in standalone mode');
    }

    registerEvent(eventType, func) {
        // No-op in standalone mode
    }
}