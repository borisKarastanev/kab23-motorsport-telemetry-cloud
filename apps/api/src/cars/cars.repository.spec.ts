import { ConflictException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { CarsRepository } from './cars.repository';
import { Car } from './entities/car.entity';

/** A minimal `SelectQueryBuilder` stand-in: chainable except for the terminal call. */
const mockQueryBuilder = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.select = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.orderBy = jest.fn().mockReturnValue(qb);
  qb.getMany = jest.fn();
  qb.getRawMany = jest.fn();
  return qb;
};

describe('CarsRepository', () => {
  let typeormRepository: jest.Mocked<
    Partial<Repository<Car>> & { createQueryBuilder: jest.Mock }
  >;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: CarsRepository;

  beforeEach(() => {
    typeormRepository = {
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    entityManager = { save: jest.fn() };
    repository = new CarsRepository(
      typeormRepository as unknown as Repository<Car>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('createCar', () => {
    it('saves the car', async () => {
      const car = { id: '1', deviceId: 'TEST123' } as Car;
      (entityManager.save as jest.Mock).mockResolvedValue(car);

      await expect(repository.createCar(car)).resolves.toBe(car);
    });

    it('reports a device-id collision as a conflict without echoing the device id', async () => {
      const car = { id: '1', deviceId: 'TAKEN' } as Car;
      (entityManager.save as jest.Mock).mockRejectedValue({ code: '23505' });

      const promise = repository.createCar(car);
      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await promise.catch((error: ConflictException) => {
        expect(JSON.stringify(error.getResponse())).not.toContain('TAKEN');
      });
    });
  });

  describe('updateCar', () => {
    it('updates then re-reads the car', async () => {
      const updated = { id: '1', name: 'E46 GTR' } as Car;
      (typeormRepository.update as jest.Mock).mockResolvedValue({
        affected: 1,
      });
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(updated);

      await expect(
        repository.updateCar('1', { name: 'E46 GTR' }),
      ).resolves.toBe(updated);
      expect(typeormRepository.update).toHaveBeenCalledWith(
        { id: '1' },
        { name: 'E46 GTR' },
      );
    });

    it('reports a device-id collision on update as a conflict', async () => {
      (typeormRepository.update as jest.Mock).mockRejectedValue({
        code: '23505',
      });

      await expect(
        repository.updateCar('1', { deviceId: 'TAKEN' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findVisibleIds', () => {
    it('returns [] without querying when the scope is empty', async () => {
      await expect(repository.findVisibleIds({})).resolves.toEqual([]);
      expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('scopes by owner only', async () => {
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'car-1' }, { id: 'car-2' }]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        repository.findVisibleIds({ ownerId: 'owner-1' }),
      ).resolves.toEqual(['car-1', 'car-2']);

      expect(qb.where).toHaveBeenCalledWith('(car.ownerId = :ownerId)', {
        ownerId: 'owner-1',
        teamIds: [],
      });
      expect(qb.select).toHaveBeenCalledWith('car.id', 'id');
    });

    it('scopes by owner OR team when both are present', async () => {
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisibleIds({
        ownerId: 'owner-1',
        teamIds: ['team-1'],
      });

      expect(qb.where).toHaveBeenCalledWith(
        '(car.ownerId = :ownerId OR car.teamId IN (:...teamIds))',
        { ownerId: 'owner-1', teamIds: ['team-1'] },
      );
    });

    it('scopes by team only', async () => {
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await repository.findVisibleIds({ teamIds: ['team-1'] });

      expect(qb.where).toHaveBeenCalledWith('(car.teamId IN (:...teamIds))', {
        ownerId: undefined,
        teamIds: ['team-1'],
      });
    });
  });

  describe('findAllIds', () => {
    it('returns every car id, unscoped', async () => {
      const qb = mockQueryBuilder();
      qb.getRawMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(repository.findAllIds()).resolves.toEqual(['a', 'b']);
      expect(qb.select).toHaveBeenCalledWith('car.id', 'id');
    });
  });

  describe('findVisible', () => {
    it('returns [] without querying when the scope is empty', async () => {
      await expect(repository.findVisible({})).resolves.toEqual([]);
      expect(typeormRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('orders by name when the scope selects something', async () => {
      const cars = [{ id: '1' } as Car];
      const qb = mockQueryBuilder();
      qb.getMany.mockResolvedValue(cars);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        repository.findVisible({ ownerId: 'owner-1' }),
      ).resolves.toBe(cars);
      expect(qb.orderBy).toHaveBeenCalledWith('car.name', 'ASC');
    });
  });
});
