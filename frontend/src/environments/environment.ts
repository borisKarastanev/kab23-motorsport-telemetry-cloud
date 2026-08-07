export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000',

  // Base for the live socket.io connection, deliberately separate from
  // `apiUrl`: socket.io-client reads a leading-slash argument as a *namespace*,
  // not a path, so it cannot share a path-prefixed API base. See
  // environment.prod.ts.
  wsUrl: 'http://localhost:3000',
};
