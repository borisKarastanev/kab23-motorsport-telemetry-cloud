import { ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from './authenticated-user.decorator';

// Not part of the public @nestjs/common barrel, but stable across major
// versions and how Nest's own docs recommend unit-testing a custom param
// decorator: apply it inside a throwaway class and read the factory back out
// of the route-args metadata Nest stashed there.
const ROUTE_ARGS_METADATA = '__routeArguments__';

/**
 * `createParamDecorator` only unwraps its factory when applied to a real
 * controller method parameter, so it cannot be invoked directly here.
 */
const factoryOf = (decorator: () => ParameterDecorator) => {
  class TestController {
    // The parameter exists only so the decorator has somewhere to attach.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    method(@decorator() value: unknown) {}
  }

  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    TestController,
    'method',
  );

  return Object.values(args)[0] as {
    factory: (data: unknown, ctx: ExecutionContext) => unknown;
  };
};

describe('AuthenticatedUser', () => {
  const contextFor = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as unknown as ExecutionContext;

  const { factory } = factoryOf(AuthenticatedUser);

  it('returns the request user attached by the JWT strategy', () => {
    const user = { id: 'user-1' };

    expect(factory(undefined, contextFor(user))).toBe(user);
  });

  it('returns undefined when no user has been attached', () => {
    expect(factory(undefined, contextFor(undefined))).toBeUndefined();
  });
});
