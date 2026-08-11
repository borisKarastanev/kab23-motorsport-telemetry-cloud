import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { Track } from './entities/track.entity';

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

  beforeEach(() => {
    tracksService = {
      findAll: jest.fn(),
    };

    controller = new TracksController(
      tracksService as unknown as TracksService,
    );
  });

  it('findAll delegates to the service with no arguments', async () => {
    const tracks = [track()];
    tracksService.findAll!.mockResolvedValue(tracks);

    await expect(controller.findAll()).resolves.toBe(tracks);
    expect(tracksService.findAll).toHaveBeenCalledWith();
  });
});
