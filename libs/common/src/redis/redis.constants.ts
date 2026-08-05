/**
 * Two connections, two tokens.
 *
 * A Redis connection in subscribe mode accepts no other commands, so the
 * subscriber cannot also be the client that `PUBLISH`es or reads a key. Naming
 * them separately makes that impossible to get wrong by injecting "the Redis
 * client" and discovering the restriction at runtime.
 */

/** Ordinary commands: publish, get, set, del. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Subscribe mode only. Accepts nothing else. */
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';
