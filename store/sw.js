console.log('---service worker loading-------')

importScripts('../js/workbox-sw.js')

if (workbox) {
  workbox.loadModule('workbox-precaching')
  workbox.loadModule('workbox-routing')
  workbox.loadModule('workbox-strategies')
  workbox.loadModule('workbox-expiration')

  const { cleanupOutdatedCaches, precacheAndRoute } = workbox.precaching
  const { registerRoute } = workbox.routing
  const { CacheFirst, StaleWhileRevalidate } = workbox.strategies
  const { ExpirationPlugin } = workbox.expiration

  const DAY_IN_SECONDS = 24 * 60 * 60
  const MONTH_IN_SECONDS = DAY_IN_SECONDS * 30

  // precache
  cleanupOutdatedCaches()

  // 设置缓存的前缀和后缀，一般用项目名作为前缀，版本号作为后缀
  workbox.core.setCacheNameDetails({
    prefix: 'vue-pwa',
    suffix: 'v0.2.a'
  })
  // 配置service work的更新激活策略
  workbox.core.skipWaiting() // 强制等待中 Service Worker 被激活
  workbox.core.clientsClaim() // Service Worker 被激活后使其立即获得页面控制权

  // 设置预加载
  //workbox.precaching.precacheAndRoute(self.__precacheManifest || [])
  workbox.precaching.precacheAndRoute([
    {
      "url": "index.html",
      "revision": null,
    },
  ]);

  // 缓存web的css资源
  registerRoute(
    // Cache CSS files
    /.*\.css/,
    // 使用缓存，但尽快在后台更新
    new StaleWhileRevalidate({
      // 使用自定义缓存名称
      cacheName: 'css-cache'
    })
  )

  // 缓存web的js资源
  registerRoute(
    // 缓存JS文件
    /.*\.js/,
    // 使用缓存，但尽快在后台更新
    new StaleWhileRevalidate({
      // 使用自定义缓存名称
      cacheName: 'js-cache'
    })
  )

  // 缓存web的图片资源
  workbox.routing.registerRoute(
    /\.(?:png|gif|jpg|jpeg|svg)$/,
    new StaleWhileRevalidate({
      cacheName: 'images',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 60,
          maxAgeSeconds: 30 * 24 * 60 * 60 // 设置缓存有效期为30天
        })
      ]
    })
  )
}
