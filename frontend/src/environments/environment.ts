// Same-origin, like production: `ng serve` proxies /api (prefix stripped) and
// /socket.io to the API on localhost:3000 (see proxy.conf.json). Going through
// the dev server's origin instead of http://localhost:3000 is what lets the
// app work behind a forwarded port (e.g. a VS Code dev tunnel), where the
// viewer's own `localhost` is not the machine running the API. It also means
// no CORS and no cross-site cookie to worry about.
export const environment = {
  production: false,
  apiUrl: '/api',

  // Empty = current origin; see environment.prod.ts for why this is not '/api'.
  wsUrl: '',
};
