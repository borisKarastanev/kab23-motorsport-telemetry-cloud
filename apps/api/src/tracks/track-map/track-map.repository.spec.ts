import { EntityManager, Repository } from 'typeorm';
import { TrackMapRepository } from './track-map.repository';
import { TrackMap, TrackMapStatus } from './entities/track-map.entity';

describe('TrackMapRepository', () => {
  let typeormRepository: jest.Mocked<
    Pick<Repository<TrackMap>, 'findOne' | 'upsert' | 'findOneOrFail'>
  >;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TrackMapRepository;

  beforeEach(() => {
    typeormRepository = {
      findOne: jest.fn(),
      upsert: jest.fn(),
      findOneOrFail: jest.fn(),
    };
    entityManager = { save: jest.fn() };
    repository = new TrackMapRepository(
      typeormRepository as unknown as Repository<TrackMap>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('findByTrackId', () => {
    it('returns the row for a track', async () => {
      const row = { trackId: 'track-1' } as TrackMap;
      typeormRepository.findOne.mockResolvedValue(row);

      await expect(repository.findByTrackId('track-1')).resolves.toBe(row);
      expect(typeormRepository.findOne).toHaveBeenCalledWith({
        where: { trackId: 'track-1' },
      });
    });

    it('returns null rather than throwing for a track with no cached map yet', async () => {
      typeormRepository.findOne.mockResolvedValue(null);

      await expect(repository.findByTrackId('track-1')).resolves.toBeNull();
    });
  });

  describe('save', () => {
    it('upserts on the trackId conflict path and reads the row back', async () => {
      const row = new TrackMap({
        trackId: 'track-1',
        status: TrackMapStatus.READY,
        fetchedAt: new Date(),
      });
      const saved = { ...row, id: 'row-1' } as TrackMap;
      typeormRepository.findOneOrFail.mockResolvedValue(saved);

      await expect(repository.save(row)).resolves.toBe(saved);

      expect(typeormRepository.upsert).toHaveBeenCalledWith(row, {
        conflictPaths: ['trackId'],
      });
      expect(typeormRepository.findOneOrFail).toHaveBeenCalledWith({
        where: { trackId: 'track-1' },
      });
    });
  });
});
