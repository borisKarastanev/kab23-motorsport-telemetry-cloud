import { SessionStatus } from '@app/common';
import { Repository } from 'typeorm';
import { IngestSessionsService } from './ingest-sessions.service';
import { CarRef } from './entities/car-ref.entity';
import { SessionRef } from './entities/session-ref.entity';

const SID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CAR_ID = '33333333-3333-4333-8333-333333333333';

const car = () => ({ id: CAR_ID, ownerId: 'owner-1' }) as CarRef;

describe('IngestSessionsService', () => {
  let service: IngestSessionsService;
  // Plain jest.Mock rather than jest.Mocked<Repository<…>>: TypeORM's create
  // and save are heavily overloaded, and matching those signatures adds noise
  // without adding safety to a mock.
  let cars: { findOne: jest.Mock };
  let sessions: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(() => {
    cars = { findOne: jest.fn().mockResolvedValue(car()) };
    sessions = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((input) => input),
      save: jest.fn(async (input) => ({ id: SESSION_ID, ...input })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    service = new IngestSessionsService(
      cars as unknown as Repository<CarRef>,
      sessions as unknown as Repository<SessionRef>,
    );
  });

  describe('openSession', () => {
    it('opens a live session anchored to the device monotonic clock', async () => {
      const session = await service.openSession(car(), SID, 4_200, 'serres');

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          carId: CAR_ID,
          status: SessionStatus.LIVE,
          deviceSessionId: SID,
          deviceMonoStartMs: 4_200,
          track: 'serres',
        }),
      );
      expect(session.id).toBe(SESSION_ID);
    });

    it('attributes the run to the car owner', async () => {
      // The device cannot know who is driving, and the owner is the only person
      // the platform can attribute a run to without guessing.
      await service.openSession(car(), SID, 0);

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'owner-1' }),
      );
    });

    it('falls back to an unknown track rather than refusing the run', async () => {
      await service.openSession(car(), SID, 0);

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ track: 'unknown' }),
      );
    });

    it('returns the existing session when a start is repeated', async () => {
      // A duplicate start — or a backlog replayed hours later — must resolve
      // back to the original row, not open a second one.
      sessions.findOne.mockResolvedValue({
        id: SESSION_ID,
        carId: CAR_ID,
      } as SessionRef);

      const session = await service.openSession(car(), SID, 0);

      expect(session.id).toBe(SESSION_ID);
      expect(sessions.save).not.toHaveBeenCalled();
    });

    it('refuses a sid that already belongs to another car', async () => {
      // A sid comes from the device body, so a cloned SD image or a re-flashed
      // unit can present another car's. Honouring it would write this car's GPS
      // trace into another team's session, where that team could read it.
      sessions.findOne.mockResolvedValue({
        id: SESSION_ID,
        carId: 'someone-elses-car',
      } as SessionRef);

      await expect(service.openSession(car(), SID, 0)).resolves.toBeNull();
      expect(sessions.save).not.toHaveBeenCalled();
    });

    it('re-reads instead of failing when two opens race', async () => {
      // The unique index on deviceSessionId is what makes the loser of the race
      // a re-read rather than a duplicate session.
      sessions.save.mockRejectedValueOnce({ code: '23505' });
      sessions.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: SESSION_ID, carId: CAR_ID } as SessionRef);

      await expect(service.openSession(car(), SID, 0)).resolves.toMatchObject({
        id: SESSION_ID,
      });
    });

    it('refuses a race lost to a different car', async () => {
      sessions.save.mockRejectedValueOnce({ code: '23505' });
      sessions.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: SESSION_ID,
        carId: 'someone-elses-car',
      } as SessionRef);

      await expect(service.openSession(car(), SID, 0)).resolves.toBeNull();
    });

    it('rethrows anything that is not a duplicate', async () => {
      sessions.save.mockRejectedValueOnce(new Error('disk full'));

      await expect(service.openSession(car(), SID, 0)).rejects.toThrow(
        'disk full',
      );
    });
  });

  describe('closeSession', () => {
    it('completes only a live session belonging to the publishing car', async () => {
      // Scoped by carId as well as sid: without it any car could end another
      // team's run in progress just by echoing their sid on its own topic.
      await service.closeSession(CAR_ID, SID);

      expect(sessions.update).toHaveBeenCalledWith(
        { deviceSessionId: SID, carId: CAR_ID, status: SessionStatus.LIVE },
        expect.objectContaining({ status: SessionStatus.COMPLETED }),
      );
    });

    it('treats a repeated stop as a no-op, not an error', async () => {
      sessions.update.mockResolvedValue({ affected: 0 });

      // Null rather than a session: nothing was closed, so there is nothing for
      // the caller to announce on the live bus a second time.
      await expect(service.closeSession(CAR_ID, SID)).resolves.toBeNull();
    });

    it('returns the closed session so the caller can announce it', async () => {
      sessions.update.mockResolvedValue({ affected: 1 });
      sessions.findOne.mockResolvedValue({
        id: SESSION_ID,
        carId: CAR_ID,
      } as SessionRef);

      await expect(service.closeSession(CAR_ID, SID)).resolves.toEqual(
        expect.objectContaining({ id: SESSION_ID }),
      );
    });
  });
});
