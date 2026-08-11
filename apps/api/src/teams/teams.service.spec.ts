import { TeamRole, UserRole } from '@app/common';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { User } from '../users/entities/user.entity';
import { TeamsService } from './teams.service';
import { TeamsRepository } from './teams.repository';
import { TeamMembersRepository } from './team-members.repository';
import { TeamInvitesRepository } from './team-invites.repository';

const TEAM_ID = 'team-1';

const asUser = (id: string, role = UserRole.DRIVER) =>
  ({ id, email: `${id}@example.test`, role }) as User;

describe('TeamsService', () => {
  let service: TeamsService;
  let teamsRepository: jest.Mocked<Partial<TeamsRepository>>;
  let membersRepository: jest.Mocked<Partial<TeamMembersRepository>>;
  let invitesRepository: jest.Mocked<Partial<TeamInvitesRepository>>;

  beforeEach(async () => {
    teamsRepository = {
      createWithOwner: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn(),
      findByIds: jest.fn().mockResolvedValue([]),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
    };
    membersRepository = {
      findMembership: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      findRoster: jest.fn().mockResolvedValue([]),
      countByRole: jest.fn().mockResolvedValue(1),
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
    };
    invitesRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findPending: jest.fn().mockResolvedValue(null),
      createInvite: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamsService,
        { provide: TeamsRepository, useValue: teamsRepository },
        { provide: TeamMembersRepository, useValue: membersRepository },
        { provide: TeamInvitesRepository, useValue: invitesRepository },
      ],
    }).compile();

    service = moduleRef.get(TeamsService);
  });

  const membership = (role: TeamRole, userId = 'user-1') => ({
    id: `member-${userId}`,
    teamId: TEAM_ID,
    userId,
    role,
  });

  describe('create', () => {
    it('makes the creator the owner', async () => {
      await service.create(asUser('user-1'), { name: 'Kab23 Racing' });

      expect(teamsRepository.createWithOwner).toHaveBeenCalledWith(
        'Kab23 Racing',
        'user-1',
      );
    });
  });

  describe('requireTeamRole', () => {
    it('404s a non-member rather than 403, so the team stays unconfirmed', async () => {
      membersRepository.findMembership.mockResolvedValue(null);

      await expect(
        service.requireTeamRole(asUser('outsider'), TEAM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s a member whose role is too low', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );

      await expect(
        service.requireTeamRole(asUser('user-1'), TEAM_ID, TeamRole.OWNER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admits a platform admin who is not a member', async () => {
      membersRepository.findMembership.mockResolvedValue(null);
      teamsRepository.findOne.mockResolvedValue({ id: TEAM_ID } as never);

      await expect(
        service.requireTeamRole(
          asUser('admin', UserRole.ADMIN),
          TEAM_ID,
          TeamRole.OWNER,
        ),
      ).resolves.toBeNull();
    });
  });

  describe('findAll', () => {
    it('never widens to every team when the caller has no memberships', async () => {
      membersRepository.find.mockResolvedValue([]);

      await service.findAll(asUser('loner'));

      expect(teamsRepository.findByIds).toHaveBeenCalledWith([]);
      expect(teamsRepository.findAll).not.toHaveBeenCalled();
    });

    it('returns every team for a platform admin', async () => {
      teamsRepository.findAll.mockResolvedValue([{ id: TEAM_ID } as never]);

      await service.findAll(asUser('admin', UserRole.ADMIN));

      expect(teamsRepository.findAll).toHaveBeenCalled();
      expect(teamsRepository.findByIds).not.toHaveBeenCalled();
    });
  });

  describe('getMembership', () => {
    it('delegates straight to the members repository', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER) as never,
      );

      await expect(
        service.getMembership('user-1', TEAM_ID),
      ).resolves.toMatchObject({ role: TeamRole.MANAGER });
      expect(membersRepository.findMembership).toHaveBeenCalledWith(
        'user-1',
        TEAM_ID,
      );
    });
  });

  describe('findOne', () => {
    it('authorizes before reading the team', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );
      teamsRepository.findOne.mockResolvedValue({ id: TEAM_ID } as never);

      await expect(
        service.findOne(asUser('user-1'), TEAM_ID),
      ).resolves.toMatchObject({ id: TEAM_ID });
    });
  });

  describe('update', () => {
    it('requires OWNER before patching the team', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER) as never,
      );

      await expect(
        service.update(asUser('user-1'), TEAM_ID, { name: 'New name' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(teamsRepository.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('lets an OWNER rename the team', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.OWNER) as never,
      );
      teamsRepository.findOneAndUpdate.mockResolvedValue({
        id: TEAM_ID,
        name: 'New name',
      } as never);

      await service.update(asUser('owner'), TEAM_ID, { name: 'New name' });

      expect(teamsRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: TEAM_ID },
        { name: 'New name' },
      );
    });
  });

  describe('remove', () => {
    it('requires OWNER before deleting the team', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER) as never,
      );

      await expect(
        service.remove(asUser('user-1'), TEAM_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(teamsRepository.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('lets an OWNER delete the team', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.OWNER) as never,
      );

      await service.remove(asUser('owner'), TEAM_ID);

      expect(teamsRepository.findOneAndDelete).toHaveBeenCalledWith({
        id: TEAM_ID,
      });
    });
  });

  describe('getRoster', () => {
    it('authorizes membership before listing the roster', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );
      membersRepository.findRoster.mockResolvedValue([
        membership(TeamRole.DRIVER),
      ] as never);

      await expect(
        service.getRoster(asUser('user-1'), TEAM_ID),
      ).resolves.toHaveLength(1);
    });
  });

  describe('inviteMember', () => {
    beforeEach(() => {
      membersRepository.findMembership.mockImplementation(async (userId) =>
        userId === 'owner'
          ? (membership(TeamRole.OWNER, 'owner') as never)
          : null,
      );
    });

    it('never writes a membership, whatever the address', async () => {
      await service.inviteMember(asUser('owner'), TEAM_ID, {
        email: 'Invitee@Example.test',
        role: TeamRole.MANAGER,
      });

      // Writing to the roster here is what previously let the inviter tell an
      // existing account from an unknown one, and attached real users to a
      // stranger's team without consent.
      expect(membersRepository.create).not.toHaveBeenCalled();
      expect(invitesRepository.createInvite).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'invitee@example.test' }),
      );
    });

    it('takes the same code path for two different addresses', async () => {
      await service.inviteMember(asUser('owner'), TEAM_ID, {
        email: 'known@example.test',
      });
      await service.inviteMember(asUser('owner'), TEAM_ID, {
        email: 'unknown@example.test',
      });

      // Same table, same call shape, no lookup in between — nothing the caller
      // can observe afterwards distinguishes the two.
      expect(invitesRepository.createInvite).toHaveBeenCalledTimes(2);
      expect(membersRepository.create).not.toHaveBeenCalled();
    });

    it('refuses to let a MANAGER mint an OWNER', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER, 'manager') as never,
      );

      await expect(
        service.inviteMember(asUser('manager'), TEAM_ID, {
          email: 'accomplice@example.test',
          role: TeamRole.OWNER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(invitesRepository.createInvite).not.toHaveBeenCalled();
    });

    it('lets an OWNER invite another OWNER', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.OWNER, 'owner') as never,
      );

      await service.inviteMember(asUser('owner'), TEAM_ID, {
        email: 'co-owner@example.test',
        role: TeamRole.OWNER,
      });

      expect(invitesRepository.createInvite).toHaveBeenCalled();
    });

    it('rejects a plain member trying to invite', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );

      await expect(
        service.inviteMember(asUser('user-1'), TEAM_ID, {
          email: 'someone@example.test',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updates the role on an already-pending invite instead of duplicating it', async () => {
      invitesRepository.findPending.mockResolvedValue({
        id: 'invite-1',
        teamId: TEAM_ID,
        email: 'someone@example.test',
        role: TeamRole.DRIVER,
      } as never);

      await service.inviteMember(asUser('owner'), TEAM_ID, {
        email: 'someone@example.test',
        role: TeamRole.MANAGER,
      });

      expect(invitesRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'invite-1' },
        { role: TeamRole.MANAGER },
      );
      expect(invitesRepository.createInvite).not.toHaveBeenCalled();
    });
  });

  describe('last owner protection', () => {
    beforeEach(() => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.OWNER, 'owner') as never,
      );
    });

    it('refuses to remove the only owner', async () => {
      membersRepository.countByRole.mockResolvedValue(1);

      await expect(
        service.removeMember(asUser('owner'), TEAM_ID, 'owner'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(membersRepository.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('refuses to demote the only owner', async () => {
      membersRepository.countByRole.mockResolvedValue(1);

      await expect(
        service.updateMemberRole(asUser('owner'), TEAM_ID, 'owner', {
          role: TeamRole.DRIVER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows removing an owner while another remains', async () => {
      membersRepository.countByRole.mockResolvedValue(2);

      await service.removeMember(asUser('owner'), TEAM_ID, 'owner');

      expect(membersRepository.findOneAndDelete).toHaveBeenCalled();
    });

    it('updates a role that does not touch the last-owner protection', async () => {
      membersRepository.findMembership.mockImplementation(async (userId) =>
        userId === 'owner'
          ? (membership(TeamRole.OWNER, 'owner') as never)
          : (membership(TeamRole.DRIVER, 'target') as never),
      );

      await service.updateMemberRole(asUser('owner'), TEAM_ID, 'target', {
        role: TeamRole.MANAGER,
      });

      expect(membersRepository.countByRole).not.toHaveBeenCalled();
      expect(membersRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: 'member-target' },
        { role: TeamRole.MANAGER },
      );
    });

    it('404s a role update for a target who is not a member', async () => {
      membersRepository.findMembership.mockImplementation(async (userId) =>
        userId === 'owner'
          ? (membership(TeamRole.OWNER, 'owner') as never)
          : null,
      );

      await expect(
        service.updateMemberRole(asUser('owner'), TEAM_ID, 'ghost', {
          role: TeamRole.MANAGER,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membersRepository.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('404s removing a target who is not a member', async () => {
      membersRepository.findMembership.mockImplementation(async (userId) =>
        userId === 'owner'
          ? (membership(TeamRole.OWNER, 'owner') as never)
          : null,
      );

      await expect(
        service.removeMember(asUser('owner'), TEAM_ID, 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membersRepository.findOneAndDelete).not.toHaveBeenCalled();
    });
  });

  describe('accepting an invite', () => {
    const invite = (email: string) => ({
      id: 'invite-1',
      teamId: TEAM_ID,
      email,
      role: TeamRole.MANAGER,
    });

    it('creates the membership only once the invitee consents', async () => {
      invitesRepository.findOne.mockResolvedValue(
        invite('newcomer@example.test') as never,
      );
      membersRepository.findMembership.mockResolvedValue(null);

      await service.acceptInvite(asUser('newcomer'), 'invite-1');

      expect(membersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEAM_ID, role: TeamRole.MANAGER }),
      );
      expect(invitesRepository.findOneAndDelete).toHaveBeenCalledWith({
        id: 'invite-1',
      });
    });

    it('404s an invite addressed to someone else', async () => {
      invitesRepository.findOne.mockResolvedValue(
        invite('victim@example.test') as never,
      );

      await expect(
        service.acceptInvite(asUser('attacker'), 'invite-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membersRepository.create).not.toHaveBeenCalled();
    });

    it('matches the invitee address case-insensitively', async () => {
      const user = { ...asUser('newcomer'), email: 'Mixed@Case.test' } as User;
      invitesRepository.findOne.mockResolvedValue(
        invite('mixed@case.test') as never,
      );
      membersRepository.findMembership.mockResolvedValue(null);

      await service.acceptInvite(user, 'invite-1');

      expect(membersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'newcomer' }),
      );
    });

    it('scopes the invitee list to their own address', async () => {
      const user = { ...asUser('newcomer'), email: 'Mixed@Case.test' } as User;

      await service.listMyInvites(user);

      expect(invitesRepository.find).toHaveBeenCalledWith({
        email: 'mixed@case.test',
      });
    });

    it('declines an invite addressed to the caller', async () => {
      invitesRepository.findOne.mockResolvedValue(
        invite('newcomer@example.test') as never,
      );

      await service.declineInvite(asUser('newcomer'), 'invite-1');

      expect(invitesRepository.findOneAndDelete).toHaveBeenCalledWith({
        id: 'invite-1',
      });
      expect(membersRepository.create).not.toHaveBeenCalled();
    });

    it('404s declining someone else invite', async () => {
      invitesRepository.findOne.mockResolvedValue(
        invite('victim@example.test') as never,
      );

      await expect(
        service.declineInvite(asUser('attacker'), 'invite-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(invitesRepository.findOneAndDelete).not.toHaveBeenCalled();
    });
  });

  describe('managing invites', () => {
    it('lets a manager list the team pending invites', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER) as never,
      );
      invitesRepository.find.mockResolvedValue([
        { id: 'invite-1', teamId: TEAM_ID },
      ] as never);

      await expect(
        service.listInvites(asUser('manager'), TEAM_ID),
      ).resolves.toHaveLength(1);
      expect(invitesRepository.find).toHaveBeenCalledWith({ teamId: TEAM_ID });
    });

    it('403s a driver trying to list invites', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );

      await expect(
        service.listInvites(asUser('user-1'), TEAM_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a manager revoke a pending invite', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.MANAGER) as never,
      );

      await service.revokeInvite(asUser('manager'), TEAM_ID, 'invite-1');

      expect(invitesRepository.findOneAndDelete).toHaveBeenCalledWith({
        id: 'invite-1',
        teamId: TEAM_ID,
      });
    });

    it('403s a driver trying to revoke an invite', async () => {
      membersRepository.findMembership.mockResolvedValue(
        membership(TeamRole.DRIVER) as never,
      );

      await expect(
        service.revokeInvite(asUser('user-1'), TEAM_ID, 'invite-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(invitesRepository.findOneAndDelete).not.toHaveBeenCalled();
    });
  });
});
