import { TeamRole } from '@app/common';
import { EntityManager, Repository } from 'typeorm';
import { TeamsRepository } from './teams.repository';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';

describe('TeamsRepository', () => {
  let typeormRepository: jest.Mocked<Partial<Repository<Team>>>;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TeamsRepository;

  beforeEach(() => {
    typeormRepository = { find: jest.fn() };
    entityManager = { save: jest.fn(), transaction: jest.fn() };
    repository = new TeamsRepository(
      typeormRepository as unknown as Repository<Team>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('createWithOwner', () => {
    it('writes the team and its founding OWNER membership in one transaction', async () => {
      const team = { id: 'team-1', name: 'Apex Racing' } as Team;
      const transactionManager = { save: jest.fn() };
      transactionManager.save
        .mockResolvedValueOnce(team)
        .mockResolvedValueOnce({} as TeamMember);

      (entityManager.transaction as jest.Mock).mockImplementation(
        async (cb: (manager: typeof transactionManager) => unknown) =>
          cb(transactionManager),
      );

      await expect(
        repository.createWithOwner('Apex Racing', 'owner-1'),
      ).resolves.toBe(team);

      expect(transactionManager.save).toHaveBeenCalledTimes(2);
      const [teamArg] = transactionManager.save.mock.calls[0];
      expect(teamArg).toMatchObject({ name: 'Apex Racing' });
      const [memberArg] = transactionManager.save.mock.calls[1];
      expect(memberArg).toMatchObject({
        teamId: 'team-1',
        userId: 'owner-1',
        role: TeamRole.OWNER,
      });
    });
  });

  describe('findByIds', () => {
    it('returns [] without querying for an empty id list', async () => {
      await expect(repository.findByIds([])).resolves.toEqual([]);
      expect(typeormRepository.find).not.toHaveBeenCalled();
    });

    it('finds by ids, ordered by name', async () => {
      const teams = [{ id: 'team-1' } as Team];
      (typeormRepository.find as jest.Mock).mockResolvedValue(teams);

      await expect(repository.findByIds(['team-1', 'team-2'])).resolves.toBe(
        teams,
      );
      expect(typeormRepository.find).toHaveBeenCalledWith({
        where: { id: expect.anything() },
        order: { name: 'ASC' },
      });
    });
  });
});
