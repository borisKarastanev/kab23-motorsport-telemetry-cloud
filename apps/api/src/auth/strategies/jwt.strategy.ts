import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { AUTH_COOKIE, TOKEN_PAYLOAD } from '../auth.constants';
import { TokenPayload } from '../interfaces/token-payload.interface';
import { TokenRevocationService } from '../token-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly usersService: UsersService,
    private readonly revocations: TokenRevocationService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: any) =>
          request?.cookies?.[AUTH_COOKIE] || request?.headers?.authentication,
      ]),
      secretOrKey: configService.get<string>('JWT_SECRET'),
      // The payload has to reach the request for `SlidingSessionInterceptor`
      // to read its age, and `request.user` is spoken for — it is the `User`
      // entity every controller and `@AuthenticatedUser()` expects. Stashing
      // the payload separately keeps both.
      passReqToCallback: true,
    });
  }

  async validate(request: Request, payload: TokenPayload) {
    if (await this.revocations.isRevoked(payload.jti)) {
      // Same generic failure as a bad signature. A caller learns that the
      // token is not usable, not which of the several reasons applies.
      throw new UnauthorizedException();
    }

    request[TOKEN_PAYLOAD] = payload;
    return this.usersService.fetchUser({ id: payload.userId });
  }
}
