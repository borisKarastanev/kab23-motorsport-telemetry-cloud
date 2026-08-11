import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AbstractEntity } from './abstract.entity';
import { AbstractRepository } from './abstract.repository';
import { UNIQUE_VIOLATION } from './postgres-errors';

class TestEntity extends AbstractEntity<TestEntity> {
  email: string;
  name: string;
}

/**
 * `createOrConflict`/`updateOrConflict` are protected — every real repository
 * exposes them through a domain-specific method name (`createCar`, and so on).
 * This subclass exposes them directly so the base-class behavior can be tested
 * without picking one concrete repository to stand in for all of them.
 */
class TestRepository extends AbstractRepository<TestEntity> {
  protected readonly logger = new Logger(TestRepository.name);

  createOrConflictPublic(
    entity: TestEntity,
    message: string,
  ): Promise<TestEntity> {
    return this.createOrConflict(entity, message);
  }

  updateOrConflictPublic(
    where: FindOptionsWhere<TestEntity>,
    partial: QueryDeepPartialEntity<TestEntity>,
    message: string,
  ): Promise<TestEntity> {
    return this.updateOrConflict(where, partial, message);
  }
}

describe('AbstractRepository', () => {
  let entityRepository: jest.Mocked<Partial<Repository<TestEntity>>>;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TestRepository;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    entityRepository = {
      findOne: jest.fn(),
      update: jest.fn(),
      findBy: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
    };
    entityManager = {
      save: jest.fn(),
    };
    repository = new TestRepository(
      entityRepository as Repository<TestEntity>,
      entityManager as unknown as EntityManager,
    );
    warnSpy = jest
      .spyOn((repository as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create', () => {
    it('delegates to entityManager.save', async () => {
      const entity = { id: '1', name: 'x' } as TestEntity;
      (entityManager.save as jest.Mock).mockResolvedValue(entity);

      await expect(repository.create(entity)).resolves.toBe(entity);
      expect(entityManager.save).toHaveBeenCalledWith(entity);
    });
  });

  describe('findOne', () => {
    it('returns the entity when a match exists', async () => {
      const entity = { id: '1', name: 'x' } as TestEntity;
      (entityRepository.findOne as jest.Mock).mockResolvedValue(entity);

      await expect(repository.findOne({ id: '1' })).resolves.toBe(entity);
      expect(entityRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });

    it('throws NotFoundException on a miss, logging only field names, never values', async () => {
      (entityRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        repository.findOne({ email: 'driver@example.test' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [loggedMessage] = warnSpy.mock.calls[0];
      expect(loggedMessage).toBe('Entity not found where email');
      expect(loggedMessage).not.toContain('driver@example.test');
    });
  });

  describe('findOneAndUpdate', () => {
    it('updates then re-fetches the entity', async () => {
      const updated = { id: '1', name: 'y' } as TestEntity;
      (entityRepository.update as jest.Mock).mockResolvedValue({
        affected: 1,
      });
      (entityRepository.findOne as jest.Mock).mockResolvedValue(updated);

      await expect(
        repository.findOneAndUpdate({ id: '1' }, { name: 'y' }),
      ).resolves.toBe(updated);
      expect(entityRepository.update).toHaveBeenCalledWith(
        { id: '1' },
        { name: 'y' },
      );
      expect(entityRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });

    it('throws NotFoundException when nothing was affected, without re-fetching', async () => {
      (entityRepository.update as jest.Mock).mockResolvedValue({
        affected: 0,
      });

      await expect(
        repository.findOneAndUpdate({ id: 'missing' }, { name: 'y' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(entityRepository.findOne).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('Entity not found where id');
    });
  });

  describe('find', () => {
    it('delegates to findBy', async () => {
      const rows = [{ id: '1' } as TestEntity];
      (entityRepository.findBy as jest.Mock).mockResolvedValue(rows);

      await expect(repository.find({ name: 'x' })).resolves.toBe(rows);
      expect(entityRepository.findBy).toHaveBeenCalledWith({ name: 'x' });
    });
  });

  describe('findAll', () => {
    it('delegates to an unfiltered find', async () => {
      const rows = [{ id: '1' } as TestEntity, { id: '2' } as TestEntity];
      (entityRepository.find as jest.Mock).mockResolvedValue(rows);

      await expect(repository.findAll()).resolves.toBe(rows);
      expect(entityRepository.find).toHaveBeenCalledWith();
    });
  });

  describe('findOneAndDelete', () => {
    it('resolves when a row was deleted', async () => {
      (entityRepository.delete as jest.Mock).mockResolvedValue({
        affected: 1,
      });

      await expect(
        repository.findOneAndDelete({ id: '1' }),
      ).resolves.toBeUndefined();
      expect(entityRepository.delete).toHaveBeenCalledWith({ id: '1' });
    });

    it('throws NotFoundException when nothing was deleted', async () => {
      (entityRepository.delete as jest.Mock).mockResolvedValue({
        affected: 0,
      });

      await expect(
        repository.findOneAndDelete({ id: 'missing' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(warnSpy).toHaveBeenCalledWith('Entity not found where id');
    });
  });

  describe('createOrConflict', () => {
    it('returns the created entity on success', async () => {
      const entity = { id: '1', name: 'x' } as TestEntity;
      (entityManager.save as jest.Mock).mockResolvedValue(entity);

      await expect(
        repository.createOrConflictPublic(entity, 'Duplicate'),
      ).resolves.toBe(entity);
    });

    it('turns a unique-violation into a ConflictException with the caller message, never the original error', async () => {
      const entity = { id: '1', name: 'x' } as TestEntity;
      const dbError = {
        code: UNIQUE_VIOLATION,
        detail: 'Key (email)=(driver@example.test) already exists.',
      };
      (entityManager.save as jest.Mock).mockRejectedValue(dbError);

      const promise = repository.createOrConflictPublic(
        entity,
        'Registration failed',
      );

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await expect(promise).rejects.toThrow('Registration failed');
      await promise.catch((error: ConflictException) => {
        expect(JSON.stringify(error.getResponse())).not.toContain(
          'driver@example.test',
        );
      });
    });

    it('rethrows any other error untouched, so a connection failure cannot masquerade as a duplicate', async () => {
      const entity = { id: '1', name: 'x' } as TestEntity;
      const dbError = { code: '57P01', message: 'connection terminated' };
      (entityManager.save as jest.Mock).mockRejectedValue(dbError);

      await expect(
        repository.createOrConflictPublic(entity, 'Registration failed'),
      ).rejects.toBe(dbError);
    });
  });

  describe('updateOrConflict', () => {
    it('returns the updated entity on success', async () => {
      const updated = { id: '1', name: 'y' } as TestEntity;
      (entityRepository.update as jest.Mock).mockResolvedValue({
        affected: 1,
      });
      (entityRepository.findOne as jest.Mock).mockResolvedValue(updated);

      await expect(
        repository.updateOrConflictPublic(
          { id: '1' },
          { name: 'y' },
          'Car could not be saved',
        ),
      ).resolves.toBe(updated);
    });

    it('turns a unique-violation from the update into a ConflictException', async () => {
      const dbError = { code: UNIQUE_VIOLATION };
      (entityRepository.update as jest.Mock).mockRejectedValue(dbError);

      await expect(
        repository.updateOrConflictPublic(
          { id: '1' },
          { name: 'TAKEN' },
          'Car could not be saved',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows a not-found untouched rather than reporting a conflict', async () => {
      (entityRepository.update as jest.Mock).mockResolvedValue({
        affected: 0,
      });

      await expect(
        repository.updateOrConflictPublic(
          { id: 'missing' },
          { name: 'y' },
          'Car could not be saved',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
