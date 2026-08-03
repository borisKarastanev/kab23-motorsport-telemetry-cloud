import { AuthenticatedUser } from '@app/common';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Patch,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';

/**
 * Self-service only. There is deliberately no `GET /users` or lookup-by-email
 * route: either would hand any authenticated caller an account-enumeration
 * oracle. Team rosters go through `GET /teams/:id/members` instead.
 *
 * Reading the current user lives at `GET /auth/me`, which the frontend already
 * uses to resolve the session; there is no second copy of it here.
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me')
  updateProfile(
    @AuthenticatedUser() user: User,
    @Body() updateProfileDto: UpdateProfileDto,
  ): Promise<User> {
    return this.usersService.updateProfile(user.id, updateProfileDto);
  }
}
