import { AuthenticatedUser } from '@app/common';
import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { TeamsService } from './teams.service';
import { TeamInvite } from './entities/team-invite.entity';
import { TeamMember } from './entities/team-member.entity';

/**
 * The invitee's side of the invite flow. Separate from `TeamsController`
 * because these routes are scoped to the caller's own email, not to a team the
 * caller can already see — an invitee is by definition not yet a member.
 */
@Controller('invites')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class InvitesController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get()
  listMine(@AuthenticatedUser() user: User): Promise<TeamInvite[]> {
    return this.teamsService.listMyInvites(user);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeamMember> {
    return this.teamsService.acceptInvite(user, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.teamsService.declineInvite(user, id);
  }
}
