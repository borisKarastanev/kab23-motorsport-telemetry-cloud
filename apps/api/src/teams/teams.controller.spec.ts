import { TeamRole } from '@app/common';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { User } from '../users/entities/user.entity';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { TeamInvite } from './entities/team-invite.entity';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

const TEAM_ID = 'team-1';
const USER_ID = 'user-1';
const INVITE_ID = 'invite-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const team = (overrides: Partial<Team> = {}) =>
  new Team({ id: TEAM_ID, name: 'Apex Racing', ...overrides });

const member = (overrides: Partial<TeamMember> = {}) =>
  new TeamMember({
    id: 'member-1',
    teamId: TEAM_ID,
    userId: USER_ID,
    role: TeamRole.DRIVER,
    ...overrides,
  });

const invite = (overrides: Partial<TeamInvite> = {}) =>
  new TeamInvite({
    id: INVITE_ID,
    teamId: TEAM_ID,
    email: 'invitee@example.test',
    role: TeamRole.DRIVER,
    ...overrides,
  });

describe('TeamsController', () => {
  let controller: TeamsController;
  let teamsService: jest.Mocked<Partial<TeamsService>>;

  beforeEach(() => {
    teamsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      getRoster: jest.fn(),
      inviteMember: jest.fn(),
      updateMemberRole: jest.fn(),
      removeMember: jest.fn(),
      listInvites: jest.fn(),
      revokeInvite: jest.fn(),
    };

    controller = new TeamsController(
      teamsService as unknown as TeamsService,
    );
  });

  it('create delegates to the service with caller and dto', async () => {
    const user = asUser(USER_ID);
    const dto: CreateTeamDto = { name: 'Apex Racing' };
    const created = team();
    teamsService.create!.mockResolvedValue(created);

    await expect(controller.create(user, dto)).resolves.toBe(created);
    expect(teamsService.create).toHaveBeenCalledWith(user, dto);
  });

  it('findAll delegates to the service with the caller', async () => {
    const user = asUser(USER_ID);
    const teams = [team()];
    teamsService.findAll!.mockResolvedValue(teams);

    await expect(controller.findAll(user)).resolves.toBe(teams);
    expect(teamsService.findAll).toHaveBeenCalledWith(user);
  });

  it('findOne delegates to the service with user and id', async () => {
    const user = asUser(USER_ID);
    const found = team();
    teamsService.findOne!.mockResolvedValue(found);

    await expect(controller.findOne(user, TEAM_ID)).resolves.toBe(found);
    expect(teamsService.findOne).toHaveBeenCalledWith(user, TEAM_ID);
  });

  it('update delegates to the service with user, id and dto', async () => {
    const user = asUser(USER_ID);
    const dto: UpdateTeamDto = { name: 'Renamed' };
    const updated = team({ name: 'Renamed' });
    teamsService.update!.mockResolvedValue(updated);

    await expect(controller.update(user, TEAM_ID, dto)).resolves.toBe(
      updated,
    );
    expect(teamsService.update).toHaveBeenCalledWith(user, TEAM_ID, dto);
  });

  it('remove delegates to the service with user and id', async () => {
    const user = asUser(USER_ID);
    teamsService.remove!.mockResolvedValue(undefined);

    await expect(controller.remove(user, TEAM_ID)).resolves.toBeUndefined();
    expect(teamsService.remove).toHaveBeenCalledWith(user, TEAM_ID);
  });

  it('getRoster delegates to the service with user and id', async () => {
    const user = asUser(USER_ID);
    const roster = [member()];
    teamsService.getRoster!.mockResolvedValue(roster);

    await expect(controller.getRoster(user, TEAM_ID)).resolves.toBe(roster);
    expect(teamsService.getRoster).toHaveBeenCalledWith(user, TEAM_ID);
  });

  it('inviteMember delegates to the service with user, id and dto', async () => {
    const user = asUser(USER_ID);
    const dto: InviteMemberDto = { email: 'invitee@example.test' };
    teamsService.inviteMember!.mockResolvedValue(undefined);

    await expect(
      controller.inviteMember(user, TEAM_ID, dto),
    ).resolves.toBeUndefined();
    expect(teamsService.inviteMember).toHaveBeenCalledWith(
      user,
      TEAM_ID,
      dto,
    );
  });

  it('updateMemberRole delegates to the service with user, team id, member id and dto', async () => {
    const user = asUser(USER_ID);
    const dto: UpdateMemberRoleDto = { role: TeamRole.MANAGER };
    const updated = member({ role: TeamRole.MANAGER });
    teamsService.updateMemberRole!.mockResolvedValue(updated);

    await expect(
      controller.updateMemberRole(user, TEAM_ID, USER_ID, dto),
    ).resolves.toBe(updated);
    expect(teamsService.updateMemberRole).toHaveBeenCalledWith(
      user,
      TEAM_ID,
      USER_ID,
      dto,
    );
  });

  it('removeMember delegates to the service with user, team id and member id', async () => {
    const user = asUser(USER_ID);
    teamsService.removeMember!.mockResolvedValue(undefined);

    await expect(
      controller.removeMember(user, TEAM_ID, USER_ID),
    ).resolves.toBeUndefined();
    expect(teamsService.removeMember).toHaveBeenCalledWith(
      user,
      TEAM_ID,
      USER_ID,
    );
  });

  it('listInvites delegates to the service with user and team id', async () => {
    const user = asUser(USER_ID);
    const invites = [invite()];
    teamsService.listInvites!.mockResolvedValue(invites);

    await expect(controller.listInvites(user, TEAM_ID)).resolves.toBe(
      invites,
    );
    expect(teamsService.listInvites).toHaveBeenCalledWith(user, TEAM_ID);
  });

  it('revokeInvite delegates to the service with user, team id and invite id', async () => {
    const user = asUser(USER_ID);
    teamsService.revokeInvite!.mockResolvedValue(undefined);

    await expect(
      controller.revokeInvite(user, TEAM_ID, INVITE_ID),
    ).resolves.toBeUndefined();
    expect(teamsService.revokeInvite).toHaveBeenCalledWith(
      user,
      TEAM_ID,
      INVITE_ID,
    );
  });
});
