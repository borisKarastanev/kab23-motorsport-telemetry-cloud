/**
 * The cookie the JWT rides in.
 *
 * One spelling, because three code paths depend on it and only one of them is
 * covered by an HTTP test: `AuthService` sets and clears it, `JwtStrategy`
 * extracts it per request, and `LiveTelemetryGateway` reads it off the WebSocket
 * handshake. Renaming it as a literal would fix REST and leave sockets
 * silently unauthenticated.
 */
export const AUTH_COOKIE = 'Authentication';
