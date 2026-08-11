import { ConflictException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { TeamInvitesRepository } from './team-invites.repository';
import { TeamInvite } from './entities/team-invite.entity';

describe('TeamInvitesRepository', () => {
  let typeormRepository: jest.Mocked<Partial<Repository<TeamInvite>>>;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TeamInvitesRepository;

  beforeEach(() => {
    typeormRepository = { findBy: jest.fn() };
    entityManager = { save: jest.fn() };
    repository = new TeamInvitesRepository(
      typeormRepository as unknown as Repository<TeamInvite>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('createInvite', () => {
    it('saves the invite', async () => {
      const invite = {
        id: '1',
        teamId: 'team-1',
        email: 'driver@example.test',
      } as TeamInvite;
      (entityManager.save as jest.Mock).mockResolvedValue(invite);

      await expect(repository.createInvite(invite)).resolves.toBe(invite);
    });

    it('reports a duplicate (teamId, email) as a conflict', async () => {
      const invite = { id: '1' } as TeamInvite;
      (entityManager.save as jest.Mock).mockRejectedValue({ code: '23505' });

      await expect(repository.createInvite(invite)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('findPending', () => {
    it('returns null when nothing matches, rather than throwing', async () => {
      (typeormRepository.findBy as jest.Mock).mockResolvedValue([]);

      await expect(
        repository.findPending('team-1', 'driver@example.test'),
      ).resolves.toBeNull();
    });

    it('returns the pending invite when one exists', async () => {
      const invite = { id: '1', email: 'driver@example.test' } as TeamInvite;
      (typeormRepository.findBy as jest.Mock).mockResolvedValue([invite]);

      await expect(
        repository.findPending('team-1', 'driver@example.test'),
      ).resolves.toBe(invite);
      expect(typeormRepository.findBy).toHaveBeenCalledWith({
        teamId: 'team-1',
        email: 'driver@example.test',
      });
    });
  });
});
