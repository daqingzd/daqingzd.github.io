var pwaos_ = (function() {
    var app_manager_;
    var install_manager_;
    var window_manager_;

    var app_manager_receiver;
    var app_manager_remote;

    const APP_MANAGER_ID            = 0x1;
    const INSTALL_MANAGER_ID        = 0x2;
    const WINDOW_MANAGER_ID         = 0x3;

    const LOG_VERBOSE = false;

    function loadjs(url) {
        // If the parent script is being loaded lazily, we can't use
        // `document.write` because the document has already been loaded.
        var scriptElement = document.createElement('script');
        scriptElement.type = 'text/javascript';
        scriptElement.async = false;
        scriptElement.src = url;
        document.currentScript.parentElement.appendChild(scriptElement);
    }

    function getModule(moduleID) {
        let module;
        if (moduleID == APP_MANAGER_ID) {
            if (typeof(app_manager_) == 'undefined' && typeof(pwaos.mojom.AppManagerPtr) != 'undefined') {
                app_manager_ = new pwaos.mojom.AppManagerPtr();
                Mojo.bindInterface(
                    pwaos.mojom.AppManager.name,
                    mojo.makeRequest(app_manager_).handle,
                    "context"
                );
                app_manager_.evt_ = new EventTarget();
            }
            module = app_manager_;
        }
        else if (moduleID == INSTALL_MANAGER_ID) {
            if (typeof(install_manager_) == 'undefined' && typeof(pwaos.mojom.InstallManagerPtr) != 'undefined') {
                install_manager_ = new pwaos.mojom.InstallManagerPtr();
                Mojo.bindInterface(
                    pwaos.mojom.InstallManager.name,
                    mojo.makeRequest(install_manager_).handle,
                    "context"
                );
                install_manager_.evt_ = new EventTarget();
            }
            module = install_manager_;
        }
        else if (moduleID == WINDOW_MANAGER_ID) {
            if (typeof(window_manager_) == 'undefined' && typeof(pwaos.mojom.WindowManagerPtr) != 'undefined') {
                window_manager_ = new pwaos.mojom.WindowManagerPtr();
                Mojo.bindInterface(
                    pwaos.mojom.WindowManager.name,
                    mojo.makeRequest(window_manager_).handle,
                    "context"
                );
                window_manager_.evt_ = new EventTarget();
            }
            module = window_manager_;
        }
        else
            return;

        return module;
    }

    function getEventTarget(module) {
        let moduleTarget;
        if (module == 'appManager')
             moduleTarget = getModule(APP_MANAGER_ID).evt_;
        else if (module == 'installManager')
             moduleTarget = getModule(INSTALL_MANAGER_ID).evt_;
        else if (module == 'windowManager')
             moduleTarget = getModule(WINDOW_MANAGER_ID).evt_;
        else
            return;

        return moduleTarget;
    }

    return {
        registerEvent : function(module, eventType, func) {
            let moduleTarget = getEventTarget(module);
            let pwaosEvent_dispatcher = function(e) {
                if (e.argc == 0)
                    func(e);
                else if (e.argc > 0 && e.argc < 30) {
                    func.apply(null, e.argv);
                } else
                    console.log("Unsupported now, argc is " + e.argc);
            }

            moduleTarget.addEventListener(eventType, pwaosEvent_dispatcher);
            if (LOG_VERBOSE) console.log("registerEvent for " + eventType);
        },
        sendToEvent : function(module, eventType, ...args) {
            let moduleTarget = getEventTarget(module);

            let e = new CustomEvent(eventType);
            e.argc = 0;
            e.argv = new Array();

            for (let item of args) {
                e.argv[e.argc] = item;
                e.argc ++;
            }

            moduleTarget.dispatchEvent(e);
            if (LOG_VERBOSE) console.log("sendToEvent for " + eventType);
        },
        get appManager() {
            return getModule(APP_MANAGER_ID);
        },
        get installManager() {
            return getModule(INSTALL_MANAGER_ID);
        },
        get windowManager() {
            return getModule(WINDOW_MANAGER_ID);
        }
    };
})();