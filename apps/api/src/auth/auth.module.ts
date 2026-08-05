import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from '@app/common';
import { ConfigModule } from '@app/common/config/config.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    LoggerModule,
    PassportModule,
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
  providers: [AuthService, LocalStrategy, JwtStrategy],
  // The live gateway verifies the same cookie outside the HTTP request cycle,
  // where guards do not run. It goes through `AuthService.userFromToken` rather
  // than being handed `JwtModule` to verify with itself: the token's shape, the
  // cookie it arrives in and how it resolves to a user are all this module's,
  // and exporting the signer would hand every importer the ability to mint one.
  exports: [AuthService],
})
export class AuthModule {}
