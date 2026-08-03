import { MANAGING_TEAM_ROLES, TeamRole, UserRole } from '@app/common';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User } from '../users/entities/user.entity';
import { TeamsRepository } from './teams.repository';
import { TeamMembersRepository } from './team-members.repository';
import { TeamInvitesRepository } from './team-invites.repository';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { TeamInvite } from './entities/team-invite.entity';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

@Injectable()
export class TeamsService {
  constructor(
    private readonly teamsRepository: TeamsRepository,
    private readonly membersRepository: TeamMembersRepository,
    private readonly invitesRepository: TeamInvitesRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Authorization primitives — also consumed by CarsService and SessionsService.
  // ---------------------------------------------------------------------------

  async getMembership(
    userId: string,
    teamId: string,
  ): Promise<TeamMember | null> {
    return this.membersRepository.findMembership(userId, teamId);
  }

  /**
   * Asserts the caller may act on a team.
   *
   * A non-member gets 404, never 403: telling an outsider "you lack the role"
   * would confirm the team exists. 403 is reserved for a member whose role is
   * too low, where existence is already known.
   */
  async requireTeamRole(
    user: User,
    teamId: string,
    ...roles: TeamRole[]
  ): Promise<TeamMember | null> {
    const membership = await this.membersRepository.findMembership(
      user.id,
      teamId,
    );

    if (user.role === UserRole.ADMIN) {
      // Still resolve the team so a bad id 404s for admins too.
      await this.teamsRepository.findOne({ id: teamId });
      return membership;
    }

    if (!membership) {
      throw new NotFoundException('Team not found');
    }

    if (roles.length && !roles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient team role');
    }

    return membership;
  }

  async getUserTeamIds(userId: string): Promise<string[]> {
    const memberships = await this.membersRepository.find({ userId });
    return memberships.map((membership) => membership.teamId);
  }

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  async create(user: User, createTeamDto: CreateTeamDto): Promise<Team> {
    return this.teamsRepository.createWithOwner(createTeamDto.name, user.id);
  }

  async findAll(user: User): Promise<Team[]> {
    if (user.role === UserRole.ADMIN) {
      return this.teamsRepository.findAll();
    }
    return this.teamsRepository.findByIds(await this.getUserTeamIds(user.id));
  }

  async findOne(user: User, teamId: string): Promise<Team> {
    await this.requireTeamRole(user, teamId);
    return this.teamsRepository.findOne({ id: teamId });
  }

  async update(
    user: User,
    teamId: string,
    updateTeamDto: UpdateTeamDto,
  ): Promise<Team> {
    await this.requireTeamRole(user, teamId, TeamRole.OWNER);
    return this.teamsRepository.findOneAndUpdate({ id: teamId }, updateTeamDto);
  }

  async remove(user: User, teamId: string): Promise<void> {
    await this.requireTeamRole(user, teamId, TeamRole.OWNER);
    await this.teamsRepository.findOneAndDelete({ id: teamId });
  }

  // ---------------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------------

  async getRoster(user: User, teamId: string): Promise<TeamMember[]> {
    await this.requireTeamRole(user, teamId);
    return this.membersRepository.findRoster(teamId);
  }

  async updateMemberRole(
    user: User,
    teamId: string,
    targetUserId: string,
    { role }: UpdateMemberRoleDto,
  ): Promise<TeamMember> {
    const callerMembership = await this.requireTeamRole(
      user,
      teamId,
      TeamRole.OWNER,
    );

    const membership = await this.resolveMember(
      teamId,
      targetUserId,
      user.id,
      callerMembership,
    );

    if (membership.role === TeamRole.OWNER && role !== TeamRole.OWNER) {
      await this.assertNotLastOwner(teamId);
    }

    return this.membersRepository.findOneAndUpdate(
      { id: membership.id },
      { role },
    );
  }

  async removeMember(
    user: User,
    teamId: string,
    targetUserId: string,
  ): Promise<void> {
    // Leaving your own team needs no elevated role; removing someone else does.
    const callerMembership =
      targetUserId === user.id
        ? await this.requireTeamRole(user, teamId)
        : await this.requireTeamRole(user, teamId, TeamRole.OWNER);

    const membership = await this.resolveMember(
      teamId,
      targetUserId,
      user.id,
      callerMembership,
    );

    if (membership.role === TeamRole.OWNER) {
      await this.assertNotLastOwner(teamId);
    }

    await this.membersRepository.findOneAndDelete({ id: membership.id });
  }

  /**
   * The membership being acted on. Reuses the row `requireTeamRole` already
   * loaded when the target is the caller themselves — the self-leave path is
   * the common one and would otherwise fetch it twice.
   */
  private async resolveMember(
    teamId: string,
    targetUserId: string,
    callerId: string,
    callerMembership: TeamMember | null,
  ): Promise<TeamMember> {
    const membership =
      targetUserId === callerId && callerMembership
        ? callerMembership
        : await this.membersRepository.findMembership(targetUserId, teamId);

    if (!membership) {
      throw new NotFoundException('Member not found');
    }

    return membership;
  }

  /**
   * A team whose last OWNER walks out can never be administered again — no one
   * left can rename it, manage the roster, or delete it.
   */
  private async assertNotLastOwner(teamId: string): Promise<void> {
    const owners = await this.membersRepository.countByRole(
      teamId,
      TeamRole.OWNER,
    );

    if (owners <= 1) {
      throw new ForbiddenException('A team must keep at least one owner');
    }
  }

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------

  /**
   * Records a pending invite. Never looks the address up and never creates a
   * membership, for two reasons:
   *
   * 1. **No enumeration oracle.** An earlier version added existing users
   *    straight to the roster and only unknown addresses to `team_invites`.
   *    Both tables are readable by the inviter, so a single follow-up
   *    `GET /teams/:id/members` vs `GET /teams/:id/invites` revealed which
   *    branch ran — and the roster leaked the target's id and display name too.
   *    Writing to one table unconditionally removes the signal.
   * 2. **Consent.** Joining a team is the invitee's decision; without this,
   *    any stranger could attach a real user to a team they control.
   */
  async inviteMember(
    user: User,
    teamId: string,
    { email, role }: InviteMemberDto,
  ): Promise<void> {
    const membership = await this.requireTeamRole(
      user,
      teamId,
      ...MANAGING_TEAM_ROLES,
    );

    const teamRole = role ?? TeamRole.DRIVER;

    // A MANAGER may not mint an OWNER: promotion is OWNER-only in
    // `updateMemberRole`, and an unrestricted invite would route around it.
    if (
      teamRole === TeamRole.OWNER &&
      user.role !== UserRole.ADMIN &&
      membership?.role !== TeamRole.OWNER
    ) {
      throw new ForbiddenException('Only an owner may invite an owner');
    }

    const normalizedEmail = email.toLowerCase();
    // Single indexed probe on `(teamId, email)` rather than loading the team's
    // whole pending list to scan it in memory.
    const alreadyInvited = await this.invitesRepository.findPending(
      teamId,
      normalizedEmail,
    );

    if (alreadyInvited) {
      await this.invitesRepository.findOneAndUpdate(
        { id: alreadyInvited.id },
        { role: teamRole },
      );
      return;
    }

    await this.invitesRepository.createInvite(
      new TeamInvite({ teamId, email: normalizedEmail, role: teamRole }),
    );
  }

  // ---------------------------------------------------------------------------
  // Invitee-facing
  // ---------------------------------------------------------------------------

  /** Invites addressed to the caller. Reveals nothing about other accounts. */
  async listMyInvites(user: User): Promise<TeamInvite[]> {
    return this.invitesRepository.find({ email: user.email.toLowerCase() });
  }

  /** Accepting is the consent step that turns an invite into a membership. */
  async acceptInvite(user: User, inviteId: string): Promise<TeamMember> {
    const invite = await this.requireOwnInvite(user, inviteId);

    const existing = await this.membersRepository.findMembership(
      user.id,
      invite.teamId,
    );

    const member =
      existing ??
      (await this.membersRepository.create(
        new TeamMember({
          teamId: invite.teamId,
          userId: user.id,
          role: invite.role,
        }),
      ));

    await this.invitesRepository.findOneAndDelete({ id: invite.id });
    return member;
  }

  async declineInvite(user: User, inviteId: string): Promise<void> {
    const invite = await this.requireOwnInvite(user, inviteId);
    await this.invitesRepository.findOneAndDelete({ id: invite.id });
  }

  /**
   * 404 rather than 403 on someone else's invite: a 403 would confirm the
   * invite id is real, and with it that some team invited some address.
   */
  private async requireOwnInvite(
    user: User,
    inviteId: string,
  ): Promise<TeamInvite> {
    const invite = await this.invitesRepository.findOne({ id: inviteId });

    if (invite.email !== user.email.toLowerCase()) {
      throw new NotFoundException('Invite not found');
    }

    return invite;
  }

  /** Listable so an owner who mistyped an address can see and revoke it. */
  async listInvites(user: User, teamId: string): Promise<TeamInvite[]> {
    await this.requireTeamRole(user, teamId, ...MANAGING_TEAM_ROLES);
    return this.invitesRepository.find({ teamId });
  }

  async revokeInvite(
    user: User,
    teamId: string,
    inviteId: string,
  ): Promise<void> {
    await this.requireTeamRole(user, teamId, ...MANAGING_TEAM_ROLES);
    await this.invitesRepository.findOneAndDelete({ id: inviteId, teamId });
  }
}
