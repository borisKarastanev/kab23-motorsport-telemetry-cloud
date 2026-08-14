import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { TOKEN_PAYLOAD } from './auth.constants';
import { SlidingSessionInterceptor } from './sliding-session.interceptor';
import { TokenPayload } from './interfaces/token-payload.interface';
import { User } from '../users/entities/user.entity';

const REFRESH_AFTER = 900;
const user = { id: 'user-1' } as User;

describe('SlidingSessionInterceptor', () => {
  let authService: jest.Mocked<Pick<AuthService, 'issueCookie'>>;
  let interceptor: SlidingSessionInterceptor;
  let response: Response;

  /** `iat` for a token issued `ageSeconds` ago. */
  const issuedAgo = (ageSeconds: number) =>
    Math.floor(Date.now() / 1000) - ageSeconds;

  const contextFor = (request: Partial<Request>, type = 'http') =>
    ({
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    }) as unknown as ExecutionContext;

  const handler = (result = of('ok')): CallHandler => ({
    handle: () => result,
  });

  const requestWith = (payload: Partial<TokenPayload> | undefined) =>
    ({
      user,
      ...(payload ? { [TOKEN_PAYLOAD]: payload } : {}),
    }) as unknown as Request;

  /** Drives the observable, which is what actually runs the `tap`. */
  const run = async (context: ExecutionContext, call = handler()) => {
    try {
      await new Promise((resolve, reject) =>
        interceptor.intercept(context, call).subscribe({
          next: resolve,
          error: reject,
          complete: () => resolve(null),
        }),
      );
    } catch {
      // Swallowed on purpose: the failure-path test asserts on the cookie,
      // not on the error, and the error is re-thrown by design.
    }
  };

  beforeEach(() => {
    authService = { issueCookie: jest.fn() };
    response = { headersSent: false } as Response;
    interceptor = new SlidingSessionInterceptor(
      authService as unknown as AuthService,
      {
        get: () => REFRESH_AFTER,
      } as unknown as ConfigService,
    );
  });

  it('re-issues the cookie once the token is older than the refresh window', async () => {
    // The whole point: activity slides the expiry forward, so a tab in use
    // all day is never logged out mid-session.
    await run(
      contextFor(
        requestWith({
          userId: user.id,
          jti: 't',
          iat: issuedAgo(REFRESH_AFTER + 1),
        }),
      ),
    );

    expect(authService.issueCookie).toHaveBeenCalledWith(user, response);
  });

  it('leaves a freshly issued token alone', async () => {
    // Otherwise every authenticated request would mint and Set-Cookie a new
    // JWT, which is a lot of signing for no added session life.
    await run(
      contextFor(
        requestWith({ userId: user.id, jti: 't', iat: issuedAgo(10) }),
      ),
    );

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });

  it('ignores unauthenticated requests', async () => {
    // Login, register and health have no token; minting a cookie for them
    // would hand out a session nobody authenticated for.
    await run(contextFor({} as Request));

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });

  it('does not refresh when the handler failed', async () => {
    // Extending a session off the back of a request that errored — a 403 from
    // a downstream ownership check, say — would work against the failure.
    await run(
      contextFor(
        requestWith({
          userId: user.id,
          jti: 't',
          iat: issuedAgo(REFRESH_AFTER + 1),
        }),
      ),
      handler(throwError(() => new Error('denied'))),
    );

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });

  it('does not refresh a token minted before jti and iat existed', async () => {
    // Refreshing it forever would keep a token alive that logout could never
    // revoke, because there is no id to denylist.
    await run(contextFor(requestWith({ userId: user.id })));

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });

  it('skips a response already on the wire', async () => {
    // A late Set-Cookie on a streamed response throws.
    response = { headersSent: true } as Response;

    await run(
      contextFor(
        requestWith({
          userId: user.id,
          jti: 't',
          iat: issuedAgo(REFRESH_AFTER + 1),
        }),
      ),
    );

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });

  it('leaves non-HTTP contexts alone', async () => {
    // The MQTT microservice and the WebSocket gateway have no cookie jar.
    await run(
      contextFor(
        requestWith({
          userId: user.id,
          jti: 't',
          iat: issuedAgo(REFRESH_AFTER + 1),
        }),
        'ws',
      ),
    );

    expect(authService.issueCookie).not.toHaveBeenCalled();
  });
});
