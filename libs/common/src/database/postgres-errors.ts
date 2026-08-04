/**
 * Postgres `SQLSTATE` codes the platform branches on.
 *
 * Shared because both the API's repositories and the ingest service treat a
 * unique-index collision as an expected outcome rather than a fault, and two
 * copies of the literal would be two places to get it wrong.
 */
export const UNIQUE_VIOLATION = '23505';
