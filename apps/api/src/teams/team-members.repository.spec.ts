import { TeamRole } from '@app/common';
import { EntityManager, Repository } from 'typeorm';
import { TeamMembersRepository } from './team-members.repository';
import { TeamMember } from './entities/team-member.entity';

const mockQueryBuilder = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.leftJoin = jest.fn().mockReturnValue(qb);
  qb.addSelect = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.getMany = jest.fn();
  return qb;
};

describe('TeamMembersRepository', () => {
  let typeormRepository: jest.Mocked<
    Partial<Repository<TeamMember>> & { createQueryBuilder: jest.Mock }
  >;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TeamMembersRepository;

  beforeEach(() => {
    typeormRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      countBy: jest.fn(),
    };
    entityManager = { save: jest.fn() };
    repository = new TeamMembersRepository(
      typeormRepository as unknown as Repository<TeamMember>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('findMembership', () => {
    it('returns null on a miss instead of throwing', async () => {
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        repository.findMembership('user-1', 'team-1'),
      ).resolves.toBeNull();
      expect(typeormRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', teamId: 'team-1' },
      });
    });

    it('returns the membership when found', async () => {
      const membership = { id: '1', role: TeamRole.MANAGER } as TeamMember;
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(membership);

      await expect(repository.findMembership('user-1', 'team-1')).resolves.toBe(
        membership,
      );
    });
  });

  describe('findRoster', () => {
    it('joins the user and never selects the password', async () => {
      const roster = [{ id: '1' } as TeamMember];
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue(roster);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(repository.findRoster('team-1')).resolves.toBe(roster);

      expect(qb.leftJoin).toHaveBeenCalledWith('member.user', 'user');
      expect(qb.addSelect).toHaveBeenCalledWith([
        'user.id',
        'user.email',
        'user.displayName',
        'user.role',
      ]);
      const selectedFields = (qb.addSelect as jest.Mock).mock.calls[0][0];
      expect(selectedFields).not.toContain('user.password');
      expect(qb.where).toHaveBeenCalledWith('member.teamId = :teamId', {
        teamId: 'team-1',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('member.createdAt', 'ASC');
    });
  });

  describe('countByRole', () => {
    it('delegates to countBy', async () => {
      (typeormRepository.countBy as jest.Mock).mockResolvedValue(2);

      await expect(
        repository.countByRole('team-1', TeamRole.OWNER),
      ).resolves.toBe(2);
      expect(typeormRepository.countBy).toHaveBeenCalledWith({
        teamId: 'team-1',
        role: TeamRole.OWNER,
      });
    });
  });
});
