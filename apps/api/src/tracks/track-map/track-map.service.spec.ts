import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackMapService } from './track-map.service';
import { PENDING } from './track-map.types';
import { OverpassClient } from './overpass.client';
import { TrackMapRepository } from './track-map.repository';
import { TrackMap, TrackMapStatus } from './entities/track-map.entity';
import { Track } from '../entities/track.entity';
import { buildTrackMap } from './track-map.builder';
import { BuildOutcome, OverpassResponse } from './track-map.types';

jest.mock('./track-map.builder', () => ({
  buildTrackMap: jest.fn(),
}));

const mockedBuild = buildTrackMap as jest.MockedFunction<typeof buildTrackMap>;

const track = (overrides: Partial<Track> = {}): Track =>
  new Track({
    id: 'track-1',
    slug: 'serres-automotive',
    name: 'Serres Automotive',
    country: 'Greece',
    centreLat: 41.07,
    centreLon: 23.51,
    sfLat1: 41.0732367,
    sfLon1: 23.5178661,
    sfLat2: 41.0730709,
    sfLon2: 23.5176703,
    deviceTrackIds: [],
    ...overrides,
  });

const BUILT: Extract<BuildOutcome, { outcome: 'built' }> = {
  outcome: 'built',
  geojson: { type: 'FeatureCollection', features: [] },
  bbox: { minLat: 41, minLon: 23, maxLat: 41.1, maxLon: 23.1 },
  centrelineLengthM: 3175,
  osmDataTimestamp: new Date('2026-08-12T12:00:00Z'),
};

const OVERPASS_RESPONSE: OverpassResponse = {
  version: 0.6,
  generator: 'test',
  osm3s: {
    timestamp_osm_base: '2026-08-12T12:00:00Z',
    copyright: 'The data is made available under ODbL.',
  },
  elements: [],
};

describe('TrackMapService', () => {
  let config: Record<string, unknown>;
  let configService: ConfigService;
  let overpassClient: jest.Mocked<Pick<OverpassClient, 'fetchRaceways'>>;
  let repository: jest.Mocked<
    Pick<TrackMapRepository, 'findByTrackId' | 'save'>
  >;
  let service: TrackMapService;

  beforeEach(() => {
    mockedBuild.mockReset();
    config = {
      TRACK_MAP_FETCH_ENABLED: true,
      TRACK_MAP_FETCH_DEADLINE_MS: 8000,
      TRACK_MAP_RETRY_AFTER_HOURS: 24,
    };
    configService = {
      get: (key: string) => config[key],
    } as unknown as ConfigService;
    overpassClient = { fetchRaceways: jest.fn() };
    repository = {
      findByTrackId: jest.fn(),
      // Mirrors the real repository's upsert-then-read-back shape closely
      // enough for these tests: whatever is saved is what a later read sees.
      save: jest.fn((row: TrackMap) => Promise.resolve(row)),
    };

    service = new TrackMapService(
      configService,
      overpassClient as unknown as OverpassClient,
      repository as unknown as TrackMapRepository,
    );
  });

  it('returns a cached ready row without touching Overpass', async () => {
    const cached = new TrackMap({
      trackId: 'track-1',
      status: TrackMapStatus.READY,
      fetchedAt: new Date(),
    });
    repository.findByTrackId.mockResolvedValue(cached);

    const result = await service.get(track());

    expect(result).toBe(cached);
    expect(overpassClient.fetchRaceways).not.toHaveBeenCalled();
  });

  it('fetches, builds and persists a cold track', async () => {
    repository.findByTrackId.mockResolvedValue(null);
    overpassClient.fetchRaceways.mockResolvedValue(OVERPASS_RESPONSE);
    mockedBuild.mockReturnValue(BUILT);

    const result = await service.get(track());

    expect(overpassClient.fetchRaceways).toHaveBeenCalledWith(41.07, 23.51);
    expect(result).not.toBe(PENDING);
    if (result === PENDING) return;
    expect(result.status).toBe(TrackMapStatus.READY);
    expect(result.centrelineLengthM).toBe(3175);
    expect(result.attribution).toBe('The data is made available under ODbL.');
  });

  it('persists unavailable when the builder rejects, without throwing', async () => {
    repository.findByTrackId.mockResolvedValue(null);
    overpassClient.fetchRaceways.mockResolvedValue(OVERPASS_RESPONSE);
    mockedBuild.mockReturnValue({
      outcome: 'rejected',
      reason: 'gate-not-on-ring (500m away)',
    });

    const result = await service.get(track());

    expect(result).not.toBe(PENDING);
    if (result === PENDING) return;
    expect(result.status).toBe(TrackMapStatus.UNAVAILABLE);
    expect(result.failureReason).toBe('gate-not-on-ring (500m away)');
  });

  it('persists unavailable rather than throwing when Overpass itself fails', async () => {
    // The persisted reason is a constant, never the caught error's message:
    // that message carries internal network topology — `connect ECONNREFUSED
    // 10.0.0.5:3128` behind an egress proxy — and `failureReason` is served
    // to any authenticated client by `GET /tracks/:track/map`. The detail
    // belongs in the log, which is what this asserts.
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repository.findByTrackId.mockResolvedValue(null);
    overpassClient.fetchRaceways.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:3128'),
    );

    try {
      const result = await service.get(track());

      expect(result).not.toBe(PENDING);
      if (result === PENDING) return;
      expect(result.status).toBe(TrackMapStatus.UNAVAILABLE);
      expect(result.failureReason).toBe('fetch-failed');
      expect(result.failureReason).not.toContain('10.0.0.5');
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('connect ECONNREFUSED 10.0.0.5:3128'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('single-flights concurrent requests for the same cold track', async () => {
    repository.findByTrackId.mockResolvedValue(null);
    overpassClient.fetchRaceways.mockResolvedValue(OVERPASS_RESPONSE);
    mockedBuild.mockReturnValue(BUILT);

    const t = track();
    await Promise.all([service.get(t), service.get(t), service.get(t)]);

    expect(overpassClient.fetchRaceways).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('retries a stale unavailable row after the cooldown', async () => {
    const stale = new TrackMap({
      trackId: 'track-1',
      status: TrackMapStatus.UNAVAILABLE,
      fetchedAt: new Date(Date.now() - 25 * 3_600_000),
      failureReason: 'no-raceway-ways',
    });
    repository.findByTrackId.mockResolvedValue(stale);
    overpassClient.fetchRaceways.mockResolvedValue(OVERPASS_RESPONSE);
    mockedBuild.mockReturnValue(BUILT);

    const result = await service.get(track());

    expect(overpassClient.fetchRaceways).toHaveBeenCalled();
    expect(result).not.toBe(PENDING);
    if (result === PENDING) return;
    expect(result.status).toBe(TrackMapStatus.READY);
  });

  it('does not retry an unavailable row inside the cooldown', async () => {
    const fresh = new TrackMap({
      trackId: 'track-1',
      status: TrackMapStatus.UNAVAILABLE,
      fetchedAt: new Date(Date.now() - 60_000),
      failureReason: 'no-raceway-ways',
    });
    repository.findByTrackId.mockResolvedValue(fresh);

    const result = await service.get(track());

    expect(result).toBe(fresh);
    expect(overpassClient.fetchRaceways).not.toHaveBeenCalled();
  });

  it('does not call Overpass when fetching is disabled, and does not persist a placeholder', async () => {
    config.TRACK_MAP_FETCH_ENABLED = false;
    repository.findByTrackId.mockResolvedValue(null);

    const result = await service.get(track());

    expect(overpassClient.fetchRaceways).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(result).not.toBe(PENDING);
    if (result === PENDING) return;
    expect(result.status).toBe(TrackMapStatus.UNAVAILABLE);
    expect(result.failureReason).toBe('fetch-disabled');
  });

  it('returns the existing row when fetching is disabled but one is already cached', async () => {
    config.TRACK_MAP_FETCH_ENABLED = false;
    const cached = new TrackMap({
      trackId: 'track-1',
      status: TrackMapStatus.READY,
      fetchedAt: new Date(),
    });
    repository.findByTrackId.mockResolvedValue(cached);

    const result = await service.get(track());

    expect(result).toBe(cached);
  });

  it('answers PENDING when the fetch outruns the deadline, and still persists once it finishes', async () => {
    jest.useFakeTimers();
    try {
      repository.findByTrackId.mockResolvedValue(null);
      config.TRACK_MAP_FETCH_DEADLINE_MS = 100;

      let resolveFetch!: (value: OverpassResponse) => void;
      overpassClient.fetchRaceways.mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );
      mockedBuild.mockReturnValue(BUILT);

      const pending = service.get(track());
      await jest.advanceTimersByTimeAsync(150);

      await expect(pending).resolves.toBe(PENDING);
      expect(repository.save).not.toHaveBeenCalled();

      resolveFetch(OVERPASS_RESPONSE);
      // Let the still-running background fetch's microtasks/persistence
      // settle — this is the part of the promise chain the deadline race
      // deliberately does not wait for.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(repository.save).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
