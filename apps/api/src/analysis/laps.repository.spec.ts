import { EntityManager, Repository } from 'typeorm';
import { LapsRepository } from './laps.repository';
import { Lap } from './entities/lap.entity';

const mockInsertQueryBuilder = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.insert = jest.fn().mockReturnValue(qb);
  qb.into = jest.fn().mockReturnValue(qb);
  qb.values = jest.fn().mockReturnValue(qb);
  qb.orIgnore = jest.fn().mockReturnValue(qb);
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return qb;
};

describe('LapsRepository', () => {
  let typeormRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: LapsRepository;

  beforeEach(() => {
    typeormRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      manager: { transaction: jest.fn() },
    };
    entityManager = { save: jest.fn() };
    repository = new LapsRepository(
      typeormRepository as unknown as Repository<Lap>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('findBySession', () => {
    it('orders laps ascending by lap number', async () => {
      const laps = [{ id: '1', lapNumber: 1 } as Lap];
      (typeormRepository.find as jest.Mock).mockResolvedValue(laps);

      await expect(repository.findBySession('session-1')).resolves.toBe(
        laps,
      );
      expect(typeormRepository.find).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        order: { lapNumber: 'ASC' },
      });
    });
  });

  describe('findOneByNumber', () => {
    it('returns null on a miss, rather than throwing', async () => {
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        repository.findOneByNumber('session-1', 3),
      ).resolves.toBeNull();
      expect(typeormRepository.findOne).toHaveBeenCalledWith({
        where: { sessionId: 'session-1', lapNumber: 3 },
      });
    });

    it('returns the lap when found', async () => {
      const lap = { id: '1', lapNumber: 3 } as Lap;
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(lap);

      await expect(repository.findOneByNumber('session-1', 3)).resolves.toBe(
        lap,
      );
    });
  });

  describe('insertIgnoringDuplicates', () => {
    it('does nothing, and does not query, for an empty set', async () => {
      await repository.insertIgnoringDuplicates([]);
      expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('inserts with orIgnore so a concurrent derivation collides rather than duplicates', async () => {
      const qb = mockInsertQueryBuilder();
      typeormRepository.createQueryBuilder.mockReturnValue(qb);
      const laps = [{ id: '1', lapNumber: 1 } as Lap];

      await repository.insertIgnoringDuplicates(laps);

      expect(qb.insert).toHaveBeenCalled();
      expect(qb.into).toHaveBeenCalledWith(Lap);
      expect(qb.values).toHaveBeenCalledWith(laps);
      expect(qb.orIgnore).toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalled();
    });
  });

  describe('replaceSession', () => {
    it('deletes the session laps and inserts the replacement inside one transaction', async () => {
      const manager = {
        delete: jest.fn(),
        createQueryBuilder: jest.fn(),
      };
      const qb = mockInsertQueryBuilder();
      manager.createQueryBuilder.mockReturnValue(qb);
      typeormRepository.manager.transaction.mockImplementation(
        async (cb: (m: typeof manager) => unknown) => cb(manager),
      );
      const laps = [{ id: '1', lapNumber: 1 } as Lap];

      await repository.replaceSession('session-1', laps);

      expect(manager.delete).toHaveBeenCalledWith(Lap, {
        sessionId: 'session-1',
      });
      expect(qb.values).toHaveBeenCalledWith(laps);
      expect(qb.orIgnore).toHaveBeenCalled();
    });

    it('deletes but skips the insert when the replacement set is empty', async () => {
      const manager = {
        delete: jest.fn(),
        createQueryBuilder: jest.fn(),
      };
      typeormRepository.manager.transaction.mockImplementation(
        async (cb: (m: typeof manager) => unknown) => cb(manager),
      );

      await repository.replaceSession('session-1', []);

      expect(manager.delete).toHaveBeenCalledWith(Lap, {
        sessionId: 'session-1',
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
