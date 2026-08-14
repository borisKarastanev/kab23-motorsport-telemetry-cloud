import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { User } from '../users/entities/user.entity';
import { AuthService } from './auth.service';
import { tokenPayloadOf } from './current-token.decorator';
import { TokenPayload } from './interfaces/token-payload.interface';

/**
 * Keeps a session alive for as long as its owner is using the app.
 *
 * `JWT_EXPIRATION` on its own is a hard cap measured from *sign-in*: at 1 h it
 * logged a driver out mid-session, and simply raising it to 24 h only moved
 * the same cliff further out while handing a leaked cookie a whole day of
 * validity. Re-issuing the token on activity turns it into an *inactivity*
 * timeout instead — an in-use tab never expires, an abandoned one stops
 * working a day after the last request rather than a day after login.
 *
 * Only tokens older than `JWT_REFRESH_AFTER` are re-issued, so this costs one
 * signature per active session per quarter hour rather than one per request.
 *
 * **The old token is deliberately not revoked on refresh.** A browser sends
 * one cookie from every tab, and requests already in flight when the new
 * `Set-Cookie` lands still carry the old one; denylisting it here would 401
 * them and log the user out for the crime of having two tabs open. Old
 * tokens in a refresh chain are left to expire on their own, which they do
 * within `JWT_EXPIRATION` of being issued. Logout, where there is no such
 * race, does revoke — see `TokenRevocationService`.
 */
@Injectable()
export class SlidingSessionInterceptor implements NestInterceptor {
  /** Read once: config cannot change after boot, and this runs per request. */
  private readonly refreshAfterSeconds: number;

  constructor(
    private readonly authService: AuthService,
    configService: ConfigService,
  ) {
    this.refreshAfterSeconds = configService.get<number>('JWT_REFRESH_AFTER');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const payload = tokenPayloadOf(request);
    const user = request.user as User | undefined;

    // Unauthenticated routes — login, register, health — have neither, and
    // must not have a cookie minted for them.
    if (!payload || !user) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        // Only on success. Re-issuing after a handler threw would extend a
        // session off the back of a request that did nothing, and on a 401
        // from a downstream check it would actively work against the failure.
        next: () => this.refreshIfStale(payload, user, http.getResponse()),
      }),
    );
  }

  private refreshIfStale(
    payload: TokenPayload,
    user: User,
    response: Response,
  ): void {
    // Pre-`jti` tokens carry no `iat` either; leaving them alone lets them
    // age out and be replaced by a normal login rather than being refreshed
    // forever without ever gaining an id that logout could revoke.
    if (!payload.iat || !payload.jti) {
      return;
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds < this.refreshAfterSeconds) {
      return;
    }

    // `headersSent` guards the streaming and file-download shapes, where the
    // response is already on the wire by the time the handler resolves and a
    // late `Set-Cookie` would throw.
    if (!response.headersSent) {
      this.authService.issueCookie(user, response);
    }
  }
}
