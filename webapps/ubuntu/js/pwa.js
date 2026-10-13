if ('serviceWorker' in navigator) {
  // 由于 127.0.0.1:8000 是所有测试 Demo 的 host
  // 为了防止作用域污染，将安装前注销所有已生效的 Service Worker
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (let reg of regs) {
      reg.unregister()
    }
    navigator.serviceWorker.register('/ubuntu/sw.js', {scope: '/ubuntu/'}).then((registration) => {
      console.log(`Service Worker registered! Scope: ${registration.scope}`);
    },(error) => {
       console.error(`Service Worker registration failed: ${error}`);
    })
  })
}