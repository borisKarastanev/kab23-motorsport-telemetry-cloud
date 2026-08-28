import { EntityManager, Repository } from 'typeorm';
import { TracksRepository } from './tracks.repository';
import { Track } from './entities/track.entity';
import { TrackSeed } from './tracks.seed';

const mockQueryBuilder = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.where = jest.fn().mockReturnValue(qb);
  qb.orWhere = jest.fn().mockReturnValue(qb);
  qb.getOne = jest.fn();
  return qb;
};

describe('TracksRepository', () => {
  let typeormRepository: jest.Mocked<
    Partial<Repository<Track>> & { createQueryBuilder: jest.Mock }
  >;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: TracksRepository;

  beforeEach(() => {
    typeormRepository = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    };
    entityManager = { save: jest.fn() };
    repository = new TracksRepository(
      typeormRepository as unknown as Repository<Track>,
      entityManager as unknown as EntityManager,
    );
  });

  describe('findAllOrdered', () => {
    it('orders tracks by name', async () => {
      const tracks = [{ id: '1', name: 'Kaloyanovo' } as Track];
      (typeormRepository.find as jest.Mock).mockResolvedValue(tracks);

      await expect(repository.findAllOrdered()).resolves.toBe(tracks);
      expect(typeormRepository.find).toHaveBeenCalledWith({
        order: { name: 'ASC' },
      });
    });
  });

  describe('findByDeviceTrack', () => {
    it('matches on slug case-insensitively OR a device track id', async () => {
      const track = { id: '1', slug: 'kaloyanovo' } as Track;
      const qb = mockQueryBuilder();
      qb.getOne.mockResolvedValue(track);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(repository.findByDeviceTrack('Kaloyanovo')).resolves.toBe(
        track,
      );

      expect(qb.where).toHaveBeenCalledWith(
        'lower(track.slug) = lower(:track)',
        {
          track: 'Kaloyanovo',
        },
      );
      expect(qb.orWhere).toHaveBeenCalledWith(
        ':track = ANY(track.deviceTrackIds)',
        { track: 'Kaloyanovo' },
      );
    });

    it('returns null rather than throwing when the platform has never heard of the track', async () => {
      const qb = mockQueryBuilder();
      qb.getOne.mockResolvedValue(null);
      typeormRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        repository.findByDeviceTrack('unknown-track-id'),
      ).resolves.toBeNull();
    });
  });

  describe('upsertSeeds', () => {
    it('upserts on the slug conflict path', async () => {
      const seeds = [{ slug: 'kaloyanovo' } as TrackSeed];

      await repository.upsertSeeds(seeds);

      expect(typeormRepository.upsert).toHaveBeenCalledWith(seeds, {
        conflictPaths: ['slug'],
      });
    });
  });

  describe('setDerivedSectorGates', () => {
    it('writes only the derivedSectorGates column, never sectorGates', async () => {
      const value: Track['derivedSectorGates'] = {
        gates: [{ lat1: 1, lon1: 1, lat2: 1, lon2: 2 }],
        source: 'centreline',
        derivedAt: '2026-08-27T00:00:00.000Z',
      };

      await repository.setDerivedSectorGates('track-1', value);

      expect(typeormRepository.update).toHaveBeenCalledWith(
        { id: 'track-1' },
        { derivedSectorGates: value },
      );
    });
  });
});
