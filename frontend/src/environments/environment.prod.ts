export const environment = {
  production: true,

  // Served behind the same reverse proxy as the API in production, which
  // forwards /api/ to the api container. Swapped in for environment.ts by the
  // `fileReplacements` entry in angular.json — without that entry this file is
  // never bundled and the deployed app calls the *viewer's* localhost.
  apiUrl: '/api',

  // Empty on purpose, and NOT '/api'. socket.io-client treats a leading-slash
  // argument as a namespace, so `io('/api/live')` asks for the namespace
  // "/api/live" while the gateway serves "/live". Empty means "current origin",
  // so `io('/live')` hits namespace /live on the default socket.io path, which
  // nginx proxies straight through to the api container.
  wsUrl: '',
};
