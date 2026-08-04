import { SessionStatus } from '@app/common';
import { IngestSessionsService } from '../sessions/ingest-sessions.service';
import { CarRef } from '../sessions/entities/car-ref.entity';
import { SessionRef } from '../sessions/entities/session-ref.entity';
import { DeviceRegistryService } from './device-registry.service';

const DEVICE_ID = 'TEST123';
const SID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CAR_ID = '33333333-3333-4333-8333-333333333333';

const STARTED_AT = new Date('2026-08-01T10:00:00.000Z');

const car = () => ({ id: CAR_ID, ownerId: 'owner' }) as CarRef;

const sessionRow = (overrides: Partial<SessionRef> = {}) =>
  ({
    id: SESSION_ID,
    carId: CAR_ID,
    driverId: 'owner',
    track: 'kaloyanovo',
    startedAt: STARTED_AT,
    status: SessionStatus.LIVE,
    deviceSessionId: SID,
    deviceMonoStartMs: 1_000,
    ...overrides,
  }) as SessionRef;

describe('DeviceRegistryService', () => {
  let service: DeviceRegistryService;
  let sessions: jest.Mocked<Partial<IngestSessionsService>>;

  beforeEach(() => {
    sessions = {
      findCarByDeviceId: jest.fn().mockResolvedValue(car()),
      openSession: jest.fn().mockResolvedValue(sessionRow()),
    };
    service = new DeviceRegistryService(
      sessions as unknown as IngestSessionsService,
    );
  });

  afterEach(() => service.onApplicationShutdown());

  it('resolves a run once, however many frames arrive at once', async () => {
    // At 10 Hz a burst for an unseen session would otherwise all miss the cache
    // and race to open the same row.
    await Promise.all(
      Array.from({ length: 20 }, () => service.resolve(DEVICE_ID, SID, 1_000)),
    );

    expect(sessions.openSession).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the anchor from the session row, not from now()', async () => {
    // A backlog replayed hours later must land on the same timeline the live
    // frames did.
    const context = await service.resolve(DEVICE_ID, SID, 500_000);

    expect(context).toMatchObject({
      sessionId: SESSION_ID,
      carId: CAR_ID,
      anchorMs: STARTED_AT.getTime(),
      monoStartMs: 1_000,
    });
  });

  it('places a sample relative to the session anchor', () => {
    expect(
      DeviceRegistryService.sampleTime(
        {
          sessionId: SESSION_ID,
          carId: CAR_ID,
          anchorMs: STARTED_AT.getTime(),
          monoStartMs: 1_000,
        },
        4_500,
      ),
    ).toEqual(new Date(STARTED_AT.getTime() + 3_500));
  });

  it('returns null for a device the platform does not know', async () => {
    sessions.findCarByDeviceId.mockResolvedValue(null);

    await expect(service.resolve('GONE', SID, 0)).resolves.toBeNull();
  });

  it('does not cache an unknown device, so registering it later works', async () => {
    // Powering the Pi up at the track before creating the car in the web app
    // would otherwise drop every frame of the whole run.
    sessions.findCarByDeviceId.mockResolvedValueOnce(null);

    await expect(service.resolve(DEVICE_ID, SID, 1_000)).resolves.toBeNull();
    await expect(service.resolve(DEVICE_ID, SID, 1_000)).resolves.toMatchObject(
      { sessionId: SESSION_ID },
    );
  });

  it('keeps two cars presenting the same sid apart', async () => {
    // A sid is device-supplied, so it is not a safe cache key on its own. If
    // the second car hit the first one's cache entry it would be handed that
    // car's session and its GPS trace would be written into another team's run.
    const other = { id: 'other-car', ownerId: 'other-owner' } as CarRef;

    const mine = await service.resolve(DEVICE_ID, SID, 1_000);

    sessions.findCarByDeviceId.mockResolvedValue(other);
    // Ownership is enforced a layer down, and this is what it returns.
    sessions.openSession.mockResolvedValue(null);
    const theirs = await service.resolve('OTHER-DEVICE', SID, 1_000);

    expect(mine).toMatchObject({ sessionId: SESSION_ID, carId: CAR_ID });
    expect(theirs).toBeNull();
    // The second car reached openSession at all — i.e. it did not silently read
    // the first car's cached context.
    expect(sessions.openSession).toHaveBeenCalledTimes(2);
    expect(sessions.openSession).toHaveBeenLastCalledWith(
      other,
      SID,
      1_000,
      undefined,
    );
  });

  it('returns null when the sid belongs to another car', async () => {
    sessions.openSession.mockResolvedValue(null);

    await expect(service.resolve(DEVICE_ID, SID, 1_000)).resolves.toBeNull();
  });

  it('does not cache a failed lookup', async () => {
    // A poisoned entry would keep every later frame for this run out of the
    // database until the TTL expired.
    sessions.openSession.mockRejectedValueOnce(new Error('database is down'));

    await expect(service.resolve(DEVICE_ID, SID, 1_000)).rejects.toThrow();
    await expect(service.resolve(DEVICE_ID, SID, 1_000)).resolves.toMatchObject(
      { sessionId: SESSION_ID },
    );
  });

  it('re-resolves a run it has been told to forget', async () => {
    await service.resolve(DEVICE_ID, SID, 1_000);
    service.forget(DEVICE_ID, SID);
    await service.resolve(DEVICE_ID, SID, 1_000);

    expect(sessions.openSession).toHaveBeenCalledTimes(2);
  });
});
