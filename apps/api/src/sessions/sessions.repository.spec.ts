import { SessionStatus } from '@app/common';
import { EntityManager, Repository } from 'typeorm';
import { SessionsRepository } from './sessions.repository';
import { Session } from './entities/session.entity';

const mockQueryBuilder = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.getMany = jest.fn();
  return qb;
};

describe('SessionsRepository', () => {
  let typeormRepository: jest.Mocked<
    Partial<Repository<Session>> & { createQueryBuilder: jest.Mock }
  >;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: SessionsRepository;

  beforeEach(() => {
    typeormRepository = { createQueryBuilder: jest.fn() };
    entityManager = { save: jest.fn() };
    repository = new SessionsRepository(
      typeormRepository as unknown as Repository<Session>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('findVisible', () => {
    it('returns [] without querying when there is no driver and no cars', async () => {
      await expect(repository.findVisible(null, [])).resolves.toEqual([]);
      expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('scopes to the driver alone when carIds is empty', async () => {
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisible('driver-1', []);

      expect(qb.where).toHaveBeenCalledWith('(session.driverId = :driverId)', {
        driverId: 'driver-1',
        carIds: [],
      });
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith(
        'session.startedAt',
        'DESC',
      );
    });

    it('scopes to driver OR carIds when both are present', async () => {
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisible('driver-1', ['car-1', 'car-2']);

      expect(qb.where).toHaveBeenCalledWith(
        '(session.driverId = :driverId OR session.carId IN (:...carIds))',
        { driverId: 'driver-1', carIds: ['car-1', 'car-2'] },
      );
    });

    it('scopes to carIds alone when driverId is null', async () => {
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisible(null, ['car-1']);

      expect(qb.where).toHaveBeenCalledWith(
        '(session.carId IN (:...carIds))',
        { driverId: null, carIds: ['car-1'] },
      );
    });

    it('adds a status filter when one is given', async () => {
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisible('driver-1', [], SessionStatus.LIVE);

      expect(qb.andWhere).toHaveBeenCalledWith('session.status = :status', {
        status: SessionStatus.LIVE,
      });
    });
  });

  describe('findAllFiltered', () => {
    it('queries unscoped and orders by startedAt descending', async () => {
      const sessions = [{ id: '1' } as Session];
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue(sessions);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(repository.findAllFiltered()).resolves.toBe(sessions);
      expect(qb.where).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith(
        'session.startedAt',
        'DESC',
      );
    });

    it('applies the status filter when given', async () => {
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findAllFiltered(SessionStatus.COMPLETED);

      expect(qb.andWhere).toHaveBeenCalledWith('session.status = :status', {
        status: SessionStatus.COMPLETED,
      });
    });
  });
});
