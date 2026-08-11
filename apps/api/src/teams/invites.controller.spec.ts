import { TeamRole } from '@app/common';
import { InvitesController } from './invites.controller';
import { TeamsService } from './teams.service';
import { User } from '../users/entities/user.entity';
import { TeamInvite } from './entities/team-invite.entity';
import { TeamMember } from './entities/team-member.entity';

const INVITE_ID = 'invite-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const invite = (overrides: Partial<TeamInvite> = {}) =>
  new TeamInvite({
    id: INVITE_ID,
    teamId: 'team-1',
    email: 'invitee@example.test',
    role: TeamRole.DRIVER,
    ...overrides,
  });

const member = (overrides: Partial<TeamMember> = {}) =>
  new TeamMember({
    id: 'member-1',
    teamId: 'team-1',
    userId: 'user-1',
    role: TeamRole.DRIVER,
    ...overrides,
  });

describe('InvitesController', () => {
  let controller: InvitesController;
  let teamsService: jest.Mocked<Partial<TeamsService>>;

  beforeEach(() => {
    teamsService = {
      listMyInvites: jest.fn(),
      acceptInvite: jest.fn(),
      declineInvite: jest.fn(),
    };

    controller = new InvitesController(teamsService as unknown as TeamsService);
  });

  it('listMine delegates to the service scoped to the caller', async () => {
    const user = asUser('user-1');
    const invites = [invite()];
    teamsService.listMyInvites!.mockResolvedValue(invites);

    await expect(controller.listMine(user)).resolves.toBe(invites);
    expect(teamsService.listMyInvites).toHaveBeenCalledWith(user);
  });

  it('accept delegates to the service with user and invite id', async () => {
    const user = asUser('user-1');
    const joined = member();
    teamsService.acceptInvite!.mockResolvedValue(joined);

    await expect(controller.accept(user, INVITE_ID)).resolves.toBe(joined);
    expect(teamsService.acceptInvite).toHaveBeenCalledWith(user, INVITE_ID);
  });

  it('decline delegates to the service with user and invite id', async () => {
    const user = asUser('user-1');
    teamsService.declineInvite!.mockResolvedValue(undefined);

    await expect(controller.decline(user, INVITE_ID)).resolves.toBeUndefined();
    expect(teamsService.declineInvite).toHaveBeenCalledWith(user, INVITE_ID);
  });
});
