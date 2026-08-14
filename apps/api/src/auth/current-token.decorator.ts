import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { TOKEN_PAYLOAD } from './auth.constants';
import { TokenPayload } from './interfaces/token-payload.interface';

/**
 * The verified token payload `JwtStrategy` stashed on the request, or
 * `undefined` on an unauthenticated route — or on a token minted before this
 * feature existed, which carries no `jti`.
 *
 * The one place the symbol is read and the type asserted. Every other reader
 * goes through this or `@CurrentToken()`, so the assertion is made once
 * rather than restated — unchecked — at each call site.
 */
export function tokenPayloadOf(request: Request): TokenPayload | undefined {
  return request[TOKEN_PAYLOAD] as TokenPayload | undefined;
}

/**
 * The caller's token, for the handlers that act on the *token* rather than on
 * the user — logout, which revokes exactly the one presented.
 *
 * Separate from `@AuthenticatedUser()` because `request.user` is contractually
 * the `User` entity; this is the JWT payload beside it. Lives in `apps/api`
 * rather than `libs/common` because it names `TokenPayload`, and
 * `libs/common` must never import from `apps/*`.
 */
export const CurrentToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    tokenPayloadOf(context.switchToHttp().getRequest<Request>()),
);
