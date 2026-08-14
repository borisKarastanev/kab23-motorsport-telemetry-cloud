import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, RedisModule } from '@app/common';
import { ConfigModule } from '@app/common/config/config.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SlidingSessionInterceptor } from './sliding-session.interceptor';
import { TokenRevocationService } from './token-revocation.service';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    LoggerModule,
    PassportModule,
    // For the token denylist. The live-path modules import this too; Nest
    // gives them the same single pair of connections.
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: `${configService.get('JWT_EXPIRATION')}s`,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenRevocationService,
    LocalStrategy,
    JwtStrategy,
    // Global rather than per-controller: the session should slide on *any*
    // authenticated request, and a route that forgot to opt in would be a
    // route that silently lets an active user's session lapse.
    { provide: APP_INTERCEPTOR, useClass: SlidingSessionInterceptor },
  ],
  // The live gateway verifies the same cookie outside the HTTP request cycle,
  // where guards do not run. It goes through `AuthService.userFromToken` rather
  // than being handed `JwtModule` to verify with itself: the token's shape, the
  // cookie it arrives in and how it resolves to a user are all this module's,
  // and exporting the signer would hand every importer the ability to mint one.
  exports: [AuthService],
})
export class AuthModule {}
