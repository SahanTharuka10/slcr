/**
 * SLCRICKPRO — Load socket.io client once (CDN). Use before realtime-manager.js
 */
(function (global) {
  const CDN =
    'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.8.1/socket.io.min.js';

  let _promise = null;

  function load() {
    if (typeof global.io !== 'undefined') return Promise.resolve(global.io);
    if (_promise) return _promise;

    _promise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-slcrick-socket-io]');
      if (existing) {
        existing.addEventListener('load', () => resolve(global.io));
        existing.addEventListener('error', () => reject(new Error('socket.io script error')));
        if (typeof global.io !== 'undefined') resolve(global.io);
        return;
      }

      const s = document.createElement('script');
      s.src = CDN;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.dataset.slcrickSocketIo = '1';
      s.onload = () => {
        if (typeof global.io !== 'undefined') resolve(global.io);
        else reject(new Error('socket.io loaded but io is undefined'));
      };
      s.onerror = () => {
        _promise = null;
        reject(new Error('Failed to load socket.io from CDN'));
      };
      document.head.appendChild(s);
    });

    return _promise;
  }

  global.SLCRICK_SOCKET_LOADER = { CDN, load };
})(typeof window !== 'undefined' ? window : global);
