// The native shell sends the system theme as a query parameter. The app theme
// is a fixed light theme, so the WebView reports prefers-color-scheme: light
// and the media query alone can never follow the system. This runs
// synchronously in the head so the first paint already uses the right palette.
(() => {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') document.documentElement.dataset.theme = forced;
})();
