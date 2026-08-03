import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Returns the authenticated principal that the JWT strategy attached to the
 * request. Kept intentionally free of any concrete entity import so that
 * libs/common never depends on apps/*.
 */
export const AuthenticatedUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest().user,
);
