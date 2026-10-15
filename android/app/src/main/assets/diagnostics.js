(() => {
  if (window.__codexDiagnosticsInstalled) return;
  window.__codexDiagnosticsInstalled = true;
  const prefix = '__CODEX_DIAGNOSTIC__';
  const print = console.info.bind(console);
  const routes = new Set(['api', 'sessions', 'messages', 'repos', 'runs', 'search', 'select', 'read', 'archive',
    'restore', 'requests', 'respond', 'files', 'preview', 'uploads', 'notifications', 'subscriptions', 'config',
    'account', 'rate-limits', 'codex', 'models', 'dev', 'interrupt']);
  function safeUrl(value) {
    try {
      const url = new URL(value, location.href);
      const path = url.pathname;
      let route = '/:path';
      if (['/', '/healthz', '/ws', '/icon.svg'].includes(path)) route = path;
      else if (path.startsWith('/api/')) route = path.split('/').filter(Boolean)
        .map(segment => routes.has(segment) ? segment : ':id').join('/');
      else if (path.startsWith('/assets/')) route = '/assets/:file';
      else if (path.startsWith('/cdn-cgi/')) route = '/cdn-cgi/:path';
      return url.protocol + '//' + url.host + (route.startsWith('/') ? route : '/' + route);
    } catch { return '[invalid-url]'; }
  }
  function emit(event, data) {
    try { print(prefix + JSON.stringify({ event, data })); } catch { /* logging must never break a request */ }
  }
  const failure = error => ['TypeError', 'AbortError', 'Error'].includes(error?.name) ? error.name : 'Error';
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const data = { url: safeUrl(typeof input === 'string' || input instanceof URL ? input : input?.url),
      method: String(init?.method || input?.method || 'GET').toUpperCase() };
    const start = performance.now();
    emit('fetch.start', data);
    try {
      return Reflect.apply(originalFetch, this, arguments).then(response => {
        emit('fetch.end', { ...data, status: response.status, redirected: response.redirected,
          durationMs: Math.round(performance.now() - start), source: safeUrl(response.url) });
        return response;
      }, error => {
        emit('fetch.error', { ...data, error: failure(error), durationMs: Math.round(performance.now() - start) });
        throw error;
      });
    } catch (error) {
      emit('fetch.error', { ...data, error: failure(error) });
      throw error;
    }
  };
  const xhrData = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    const result = Reflect.apply(open, this, arguments);
    xhrData.set(this, { method: String(method).toUpperCase(), url: safeUrl(url) });
    return result;
  };
  XMLHttpRequest.prototype.send = function() {
    const data = xhrData.get(this) || {};
    const start = performance.now();
    const done = () => {
      this.removeEventListener('loadend', done);
      emit('xhr.end', { ...data, status: this.status, source: safeUrl(this.responseURL),
        durationMs: Math.round(performance.now() - start) });
    };
    this.addEventListener('loadend', done);
    emit('xhr.start', data);
    try { return Reflect.apply(send, this, arguments); }
    catch (error) { this.removeEventListener('loadend', done); emit('xhr.error', { ...data, error: failure(error) }); throw error; }
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const data = { method: 'WS', url: safeUrl(args[0]) };
      emit('ws.connect', data);
      this.addEventListener('open', () => emit('ws.open', data));
      this.addEventListener('error', () => emit('ws.error', data));
      this.addEventListener('close', event => emit('ws.close', { ...data, closeCode: event.code, clean: event.wasClean }));
    }
  };
  emit('diagnostics.ready', { url: safeUrl(location.href) });
})();
