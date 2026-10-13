/**
 * Browser Storage Abstraction Layer
 * Provides unified API for localStorage, IndexedDB, and future cloud sync backends
 * Replaces direct localStorage calls throughout the codebase
 */

(function() {
    'use strict';

    // Storage backend types
    const BACKEND_TYPES = {
        LOCALSTORAGE: 'localStorage',
        INDEXEDDB: 'indexedDB',
        MEMORY: 'memory'
    };

    // Default to localStorage for now
    let currentBackend = BACKEND_TYPES.LOCALSTORAGE;
    let dbInstance = null;
    const DB_NAME = 'browser_storage';
    const DB_VERSION = 1;
    const STORE_NAME = 'keyval';

    // In-memory fallback
    const memoryStore = new Map();

    // Initialize IndexedDB
    function initIndexedDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not supported'));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                dbInstance = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
        });
    }

    // Storage API
    const Storage = {
        // Set backend (for future cloud sync)
        setBackend(type) {
            if (Object.values(BACKEND_TYPES).includes(type)) {
                currentBackend = type;
                if (type === BACKEND_TYPES.INDEXEDDB && !dbInstance) {
                    return initIndexedDB();
                }
            }
            return Promise.resolve();
        },

        // Get current backend
        getBackend() {
            return currentBackend;
        },

        // Get item
        getItem(key) {
            switch (currentBackend) {
                case BACKEND_TYPES.INDEXEDDB:
                    if (!dbInstance) return Promise.resolve(null);
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(STORE_NAME, 'readonly');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.get(key);
                        request.onsuccess = () => resolve(request.result ?? null);
                        request.onerror = () => reject(request.error);
                    });
                case BACKEND_TYPES.MEMORY:
                    return Promise.resolve(memoryStore.get(key) ?? null);
                case BACKEND_TYPES.LOCALSTORAGE:
                default:
                    try {
                        return Promise.resolve(localStorage.getItem(key));
                    } catch (e) {
                        return Promise.resolve(null);
                    }
            }
        },

        // Get item synchronously (for backward compat - localStorage only)
        getItemSync(key) {
            if (currentBackend === BACKEND_TYPES.LOCALSTORAGE) {
                try {
                    return localStorage.getItem(key);
                } catch (e) {
                    return null;
                }
            }
            // For other backends, return from memory cache if available
            return memoryStore.get(key) ?? null;
        },

        // Set item
        setItem(key, value) {
            switch (currentBackend) {
                case BACKEND_TYPES.INDEXEDDB:
                    if (!dbInstance) return Promise.resolve();
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.put(value, key);
                        request.onsuccess = () => resolve();
                        request.onerror = () => reject(request.error);
                    });
                case BACKEND_TYPES.MEMORY:
                    memoryStore.set(key, value);
                    return Promise.resolve();
                case BACKEND_TYPES.LOCALSTORAGE:
                default:
                    try {
                        localStorage.setItem(key, value);
                        return Promise.resolve();
                    } catch (e) {
                        return Promise.resolve();
                    }
            }
        },

        // Remove item
        removeItem(key) {
            switch (currentBackend) {
                case BACKEND_TYPES.INDEXEDDB:
                    if (!dbInstance) return Promise.resolve();
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.delete(key);
                        request.onsuccess = () => resolve();
                        request.onerror = () => reject(request.error);
                    });
                case BACKEND_TYPES.MEMORY:
                    memoryStore.delete(key);
                    return Promise.resolve();
                case BACKEND_TYPES.LOCALSTORAGE:
                default:
                    try {
                        localStorage.removeItem(key);
                        return Promise.resolve();
                    } catch (e) {
                        return Promise.resolve();
                    }
            }
        },

        // Clear all
        clear() {
            switch (currentBackend) {
                case BACKEND_TYPES.INDEXEDDB:
                    if (!dbInstance) return Promise.resolve();
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.clear();
                        request.onsuccess = () => resolve();
                        request.onerror = () => reject(request.error);
                    });
                case BACKEND_TYPES.MEMORY:
                    memoryStore.clear();
                    return Promise.resolve();
                case BACKEND_TYPES.LOCALSTORAGE:
                default:
                    try {
                        localStorage.clear();
                        return Promise.resolve();
                    } catch (e) {
                        return Promise.resolve();
                    }
            }
        },

        // Get all keys
        keys() {
            switch (currentBackend) {
                case BACKEND_TYPES.INDEXEDDB:
                    if (!dbInstance) return Promise.resolve([]);
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(STORE_NAME, 'readonly');
                        const store = tx.objectStore(STORE_NAME);
                        const request = store.getAllKeys();
                        request.onsuccess = () => resolve(request.result || []);
                        request.onerror = () => reject(request.error);
                    });
                case BACKEND_TYPES.MEMORY:
                    return Promise.resolve([...memoryStore.keys()]);
                case BACKEND_TYPES.LOCALSTORAGE:
                default:
                    try {
                        return Promise.resolve(Object.keys(localStorage));
                    } catch (e) {
                        return Promise.resolve([]);
                    }
            }
        },

        // Migrate from localStorage to current backend
        async migrateFromLocalStorage() {
            if (currentBackend === BACKEND_TYPES.LOCALSTORAGE) return;
            try {
                const keys = Object.keys(localStorage);
                for (const key of keys) {
                    const value = localStorage.getItem(key);
                    if (value !== null) {
                        await this.setItem(key, value);
                    }
                }
            } catch (e) {
                console.warn('Migration from localStorage failed:', e);
            }
        },

        // JSON helpers
        getJSON(key, defaultValue = null) {
            return this.getItem(key).then(val => {
                if (val === null) return defaultValue;
                try {
                    return JSON.parse(val);
                } catch (e) {
                    return defaultValue;
                }
            });
        },

        setJSON(key, value) {
            return this.setItem(key, JSON.stringify(value));
        }
    };

    // Expose globally
    window.BrowserStorage = Storage;

    // Auto-initialize IndexedDB if preferred
    if (typeof window !== 'undefined' && window.indexedDB) {
        // Could auto-init here, but keeping localStorage as default for compatibility
    }
})();