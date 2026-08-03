import { AuthenticatedUser } from '@app/common';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { TeamsService } from './teams.service';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { TeamInvite } from './entities/team-invite.entity';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

@Controller('teams')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  create(
    @AuthenticatedUser() user: User,
    @Body() createTeamDto: CreateTeamDto,
  ): Promise<Team> {
    return this.teamsService.create(user, createTeamDto);
  }

  @Get()
  findAll(@AuthenticatedUser() user: User): Promise<Team[]> {
    return this.teamsService.findAll(user);
  }

  @Get(':id')
  findOne(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Team> {
    return this.teamsService.findOne(user, id);
  }

  @Patch(':id')
  update(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateTeamDto: UpdateTeamDto,
  ): Promise<Team> {
    return this.teamsService.update(user, id, updateTeamDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.teamsService.remove(user, id);
  }

  @Get(':id/members')
  getRoster(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeamMember[]> {
    return this.teamsService.getRoster(user, id);
  }

  /**
   * 202 with an empty body in every case — created a membership, stored a
   * pending invite, or found the user already on the roster. A status or body
   * that varied would leak whether the address has an account.
   */
  @Post(':id/members')
  @HttpCode(HttpStatus.ACCEPTED)
  inviteMember(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() inviteMemberDto: InviteMemberDto,
  ): Promise<void> {
    return this.teamsService.inviteMember(user, id, inviteMemberDto);
  }

  @Patch(':id/members/:userId')
  updateMemberRole(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() updateMemberRoleDto: UpdateMemberRoleDto,
  ): Promise<TeamMember> {
    return this.teamsService.updateMemberRole(
      user,
      id,
      userId,
      updateMemberRoleDto,
    );
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.teamsService.removeMember(user, id, userId);
  }

  @Get(':id/invites')
  listInvites(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeamInvite[]> {
    return this.teamsService.listInvites(user, id);
  }

  @Delete(':id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ): Promise<void> {
    return this.teamsService.revokeInvite(user, id, inviteId);
  }
}
