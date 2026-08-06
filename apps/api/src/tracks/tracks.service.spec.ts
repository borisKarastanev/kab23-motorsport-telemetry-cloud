import { Test } from '@nestjs/testing';
import { TracksService } from './tracks.service';
import { TracksRepository } from './tracks.repository';
import { TracksSeedService } from './tracks-seed.service';
import { TRACK_SEEDS } from './tracks.seed';

describe('TracksService', () => {
  let service: TracksService;
  let repository: jest.Mocked<
    Pick<
      TracksRepository,
      'findAllOrdered' | 'findByDeviceTrack' | 'upsertSeeds'
    >
  >;

  beforeEach(async () => {
    repository = {
      findAllOrdered: jest.fn(),
      findByDeviceTrack: jest.fn().mockResolvedValue(null),
      upsertSeeds: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TracksService,
        { provide: TracksRepository, useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(TracksService);
  });

  describe('resolve', () => {
    it('looks up the track a device reported', async () => {
      await service.resolve('kaloyanovo');
      expect(repository.findByDeviceTrack).toHaveBeenCalledWith('kaloyanovo');
    });

    it('trims what the device sent', async () => {
      await service.resolve('  kaloyanovo \n');
      expect(repository.findByDeviceTrack).toHaveBeenCalledWith('kaloyanovo');
    });

    it.each([undefined, '', '   '])(
      'returns null without a lookup for %p',
      async (track) => {
        // A blank track is the common case for a REST-created session, not an
        // error — and it must not reach the database as a wildcard-ish query.
        await expect(service.resolve(track)).resolves.toBeNull();
        expect(repository.findByDeviceTrack).not.toHaveBeenCalled();
      },
    );

    it('returns null for a track the platform has never heard of', async () => {
      // The on-car track database is versioned independently, so a car may
      // legitimately report a track we do not carry a gate for. The analysis
      // pass turns this into `no-track-gate`, never an error.
      await expect(service.resolve('brands-hatch')).resolves.toBeNull();
    });
  });
});

describe('TracksSeedService', () => {
  const build = (upsertSeeds: jest.Mock) => {
    const seedService = new TracksSeedService({
      upsertSeeds,
    } as unknown as TracksRepository);
    return seedService;
  };

  it('seeds the reference tracks on boot', async () => {
    const upsertSeeds = jest.fn().mockResolvedValue(undefined);
    await build(upsertSeeds).onModuleInit();

    expect(upsertSeeds).toHaveBeenCalledWith(TRACK_SEEDS);
  });

  it('does not take the API down when seeding fails', async () => {
    // Three rows of reference data are worth less than every other endpoint,
    // and the next restart retries. A missing track degrades to `no-track-gate`,
    // which the analysis path already handles.
    const upsertSeeds = jest.fn().mockRejectedValue(new Error('db is down'));

    await expect(build(upsertSeeds).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('TRACK_SEEDS', () => {
  it('carries every track the dash has a confirmed gate for', () => {
    // Exactly three entries in the dash's track-db.json have a `start` field.
    // If that changes upstream, this seed is stale.
    expect(TRACK_SEEDS.map((track) => track.slug).sort()).toEqual([
      'a1-motor-park',
      'kaloyanovo',
      'serres-automotive',
    ]);
  });

  it('has unique slugs, since the upsert conflicts on them', () => {
    const slugs = TRACK_SEEDS.map((track) => track.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every track a usable gate', () => {
    for (const track of TRACK_SEEDS) {
      // Distinct endpoints: a zero-length gate is a line nothing can cross, and
      // would silently segment no laps at all.
      expect([track.sfLat1, track.sfLon1]).not.toEqual([
        track.sfLat2,
        track.sfLon2,
      ]);

      // Roughly a track's width apart. Catches a transposed or truncated
      // coordinate, which would otherwise look plausible.
      const metres = Math.hypot(
        (track.sfLat1 - track.sfLat2) * 111132,
        (track.sfLon1 - track.sfLon2) *
          111320 *
          Math.cos((track.sfLat1 * Math.PI) / 180),
      );
      expect(metres).toBeGreaterThan(5);
      expect(metres).toBeLessThan(50);

      // The gate belongs to the circuit it is filed under. A copy-paste from
      // the wrong row would put it kilometres away.
      const centreMetres = Math.hypot(
        (track.sfLat1 - track.centreLat) * 111132,
        (track.sfLon1 - track.centreLon) *
          111320 *
          Math.cos((track.centreLat * Math.PI) / 180),
      );
      expect(centreMetres).toBeLessThan(2000);
    }
  });

  it('records the id the on-car dash knows each track by', () => {
    for (const track of TRACK_SEEDS) {
      expect(track.deviceTrackIds.length).toBeGreaterThan(0);
      // The dash's ids are 24-character hex, and a device reporting one has to
      // match the row exactly.
      for (const id of track.deviceTrackIds) {
        expect(id).toMatch(/^[0-9a-f]{24}$/);
      }
    }
  });
});
