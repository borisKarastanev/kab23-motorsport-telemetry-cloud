import { NotFoundException } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { Track } from './entities/track.entity';
import { TrackMapService } from './track-map/track-map.service';
import { PENDING } from './track-map/track-map.types';
import {
  TrackMap,
  TrackMapStatus,
} from './track-map/entities/track-map.entity';

const track = (overrides: Partial<Track> = {}) =>
  new Track({
    id: 'track-1',
    slug: 'spa',
    name: 'Spa-Francorchamps',
    country: 'Belgium',
    centreLat: 50.4372,
    centreLon: 5.9714,
    sfLat1: 50.4,
    sfLon1: 5.9,
    sfLat2: 50.41,
    sfLon2: 5.91,
    deviceTrackIds: [],
    ...overrides,
  });

describe('TracksController', () => {
  let controller: TracksController;
  let tracksService: jest.Mocked<Partial<TracksService>>;
  let trackMapService: jest.Mocked<Partial<TrackMapService>>;

  beforeEach(() => {
    tracksService = {
      findAll: jest.fn(),
      resolve: jest.fn(),
    };
    trackMapService = {
      get: jest.fn(),
    };

    controller = new TracksController(
      tracksService as unknown as TracksService,
      trackMapService as unknown as TrackMapService,
    );
  });

  it('findAll delegates to the service with no arguments', async () => {
    const tracks = [track()];
    tracksService.findAll!.mockResolvedValue(tracks);

    await expect(controller.findAll()).resolves.toBe(tracks);
    expect(tracksService.findAll).toHaveBeenCalledWith();
  });

  describe('getMap', () => {
    it('404s for a track string that resolves to nothing', async () => {
      tracksService.resolve!.mockResolvedValue(null);

      await expect(controller.getMap('brands-hatch')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(trackMapService.get).not.toHaveBeenCalled();
    });

    it('resolves the track string, then asks TrackMapService for its map', async () => {
      const spa = track();
      tracksService.resolve!.mockResolvedValue(spa);
      trackMapService.get!.mockResolvedValue(
        new TrackMap({
          status: TrackMapStatus.READY,
          geojson: { type: 'FeatureCollection', features: [] },
          centrelineLengthM: 7004,
          fetchedAt: new Date(),
        }),
      );

      const result = await controller.getMap('spa');

      expect(tracksService.resolve).toHaveBeenCalledWith('spa');
      expect(trackMapService.get).toHaveBeenCalledWith(spa);
      expect(result).toEqual({
        status: 'ready',
        // The name the *server* resolved, so the browser never has to
        // re-implement the slug-or-deviceTrackIds match to label the chart.
        trackName: 'Spa-Francorchamps',
        map: { type: 'FeatureCollection', features: [] },
        bbox: undefined,
        centrelineLengthM: 7004,
        attribution: undefined,
        osmDataTimestamp: undefined,
      });
    });

    it('passes PENDING straight through as a pending status', async () => {
      tracksService.resolve!.mockResolvedValue(track());
      trackMapService.get!.mockResolvedValue(PENDING);

      await expect(controller.getMap('spa')).resolves.toEqual({
        status: 'pending',
        trackName: 'Spa-Francorchamps',
      });
    });
  });
});
