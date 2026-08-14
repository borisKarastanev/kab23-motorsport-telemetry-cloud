import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedUser } from '@app/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { User } from '../users/entities/user.entity';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentToken } from './current-token.decorator';
import { TokenPayload } from './interfaces/token-payload.interface';

@Controller('auth')
@UseInterceptors(ClassSerializerInterceptor)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  register(@Body() createUserDto: CreateUserDto): Promise<User> {
    return this.usersService.create(createUserDto);
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  login(
    @AuthenticatedUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ): User {
    return this.authService.login(user, response);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(
    // The payload, not just the user: revocation names the individual token,
    // so that signing out here does not sign the same person out on their
    // other devices. `JwtStrategy` put it on the request.
    @CurrentToken() token: TokenPayload | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: boolean }> {
    await this.authService.logout(response, token);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@AuthenticatedUser() user: User): User {
    return user;
  }
}
