import { AuthGuard } from '@nestjs/passport';

/**
 * In-process JWT guard. The multi-service reference proxied every auth check
 * over TCP to a separate authentication service; in this modular monolith the
 * passport strategy validates the cookie locally — no network hop.
 */
export class JwtAuthGuard extends AuthGuard('jwt') {}
