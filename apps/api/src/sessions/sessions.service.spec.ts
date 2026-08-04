import { SessionStatus, TeamRole, UserRole } from '@app/common';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CarsService } from '../cars/cars.service';
import { Car } from '../cars/entities/car.entity';
import { TeamsService } from '../teams/teams.service';
import { User } from '../users/entities/user.entity';
import { SessionsService } from './sessions.service';
import { SessionsRepository } from './sessions.repository';
import { TelemetryRepository } from './telemetry.repository';
import { Session } from './entities/session.entity';

const SESSION_ID = 'session-1';
const CAR_ID = 'car-1';
const TEAM_ID = 'team-1';

const asUser = (id: string, role = UserRole.DRIVER) =>
  ({ id, email: `${id}@example.test`, role }) as User;

const session = (overrides: Partial<Session> = {}) =>
  ({
    id: SESSION_ID,
    carId: CAR_ID,
    driverId: 'driver',
    track: 'Kaloyanovo',
    startedAt: new Date('2026-08-01T10:00:00Z'),
    status: SessionStatus.LIVE,
    ...overrides,
  }) as Session;

describe('SessionsService', () => {
  let service: SessionsService;
  let sessionsRepository: jest.Mocked<Partial<SessionsRepository>>;
  let carsService: jest.Mocked<Partial<CarsService>>;
  let teamsService: jest.Mocked<Partial<TeamsService>>;
  let telemetryRepository: jest.Mocked<Partial<TelemetryRepository>>;

  beforeEach(async () => {
    sessionsRepository = {
      create: jest.fn(),
      findOne: jest.fn(),
      findVisible: jest.fn().mockResolvedValue([]),
      findAllFiltered: jest.fn().mockResolvedValue([]),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
    };
    carsService = {
      requireReadableCar: jest.fn().mockResolvedValue({ id: CAR_ID } as Car),
      requireWritableCar: jest.fn().mockResolvedValue({ id: CAR_ID } as Car),
      findAll: jest.fn().mockResolvedValue([]),
      getVisibleCarIds: jest.fn().mockResolvedValue([]),
    };
    teamsService = {
      requireTeamRole: jest.fn(),
      getMembership: jest.fn().mockResolvedValue(null),
    };
    telemetryRepository = {
      findDownsampled: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: SessionsRepository, useValue: sessionsRepository },
        { provide: CarsService, useValue: carsService },
        { provide: TeamsService, useValue: teamsService },
        { provide: TelemetryRepository, useValue: telemetryRepository },
      ],
    }).compile();

    service = moduleRef.get(SessionsService);
  });

  describe('create', () => {
    it('opens the session against the caller by default', async () => {
      await service.create(asUser('driver'), {
        carId: CAR_ID,
        track: 'Kaloyanovo',
      });

      expect(sessionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          carId: CAR_ID,
          driverId: 'driver',
          status: SessionStatus.LIVE,
        }),
      );
    });

    it('refuses a car the caller cannot see', async () => {
      carsService.requireReadableCar.mockRejectedValue(new NotFoundException());

      await expect(
        service.create(asUser('outsider'), { carId: CAR_ID, track: 'Serres' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sessionsRepository.create).not.toHaveBeenCalled();
    });

    it('refuses to assign another driver on a privateer car', async () => {
      carsService.requireReadableCar.mockResolvedValue({ id: CAR_ID } as Car);

      await expect(
        service.create(asUser('owner'), {
          carId: CAR_ID,
          track: 'Serres',
          driverId: 'someone-else',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to assign a driver who is not in the car team', async () => {
      carsService.requireReadableCar.mockResolvedValue({
        id: CAR_ID,
        teamId: TEAM_ID,
      } as Car);
      teamsService.getMembership.mockResolvedValue(null);

      await expect(
        service.create(asUser('manager'), {
          carId: CAR_ID,
          track: 'Serres',
          driverId: 'stranger',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a manager open a session for a team driver', async () => {
      carsService.requireReadableCar.mockResolvedValue({
        id: CAR_ID,
        teamId: TEAM_ID,
      } as Car);
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.DRIVER,
      } as never);

      await service.create(asUser('manager'), {
        carId: CAR_ID,
        track: 'Serres',
        driverId: 'team-driver',
      });

      expect(sessionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'team-driver' }),
      );
    });
  });

  describe('findOne', () => {
    it('lets the driver read their own run', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());

      await expect(
        service.findOne(asUser('driver'), SESSION_ID),
      ).resolves.toMatchObject({ id: SESSION_ID });
      expect(carsService.requireReadableCar).not.toHaveBeenCalled();
    });

    it('lets a team manager read a run on their car', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());

      await expect(
        service.findOne(asUser('manager'), SESSION_ID),
      ).resolves.toMatchObject({ id: SESSION_ID });
      expect(carsService.requireReadableCar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'manager' }),
        CAR_ID,
      );
    });

    it('404s an outsider, masking the underlying car check', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());
      carsService.requireReadableCar.mockRejectedValue(
        new NotFoundException('Car not found'),
      );

      await expect(
        service.findOne(asUser('outsider'), SESSION_ID),
      ).rejects.toThrow('Session not found');
    });
  });

  describe('findAll', () => {
    it('does not fall back to an unscoped scan when nothing is visible', async () => {
      carsService.getVisibleCarIds.mockResolvedValue([]);

      await service.findAll(asUser('loner'), {});

      expect(sessionsRepository.findVisible).toHaveBeenCalledWith(
        'loner',
        [],
        undefined,
      );
      expect(sessionsRepository.findAllFiltered).not.toHaveBeenCalled();
    });

    it('authorizes the car before filtering by it', async () => {
      carsService.requireReadableCar.mockRejectedValue(new NotFoundException());

      await expect(
        service.findAll(asUser('outsider'), { carId: CAR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sessionsRepository.findVisible).not.toHaveBeenCalled();
    });

    it('honours teamId for an admin instead of returning the platform', async () => {
      carsService.getVisibleCarIds.mockResolvedValue(['car-a']);

      await service.findAll(asUser('admin', UserRole.ADMIN), {
        teamId: TEAM_ID,
      });

      expect(sessionsRepository.findAllFiltered).not.toHaveBeenCalled();
      expect(sessionsRepository.findVisible).toHaveBeenCalledWith(
        null,
        ['car-a'],
        undefined,
      );
    });

    it('narrows a team query to that team cars only', async () => {
      carsService.getVisibleCarIds.mockResolvedValue(['car-a']);

      await service.findAll(asUser('member'), { teamId: TEAM_ID });

      expect(carsService.getVisibleCarIds).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ID,
      );
      expect(sessionsRepository.findVisible).toHaveBeenCalledWith(
        null,
        ['car-a'],
        undefined,
      );
    });
  });

  describe('close', () => {
    it('completes a live session', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());

      await service.close(asUser('driver'), SESSION_ID);

      expect(sessionsRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: SESSION_ID },
        expect.objectContaining({ status: SessionStatus.COMPLETED }),
      );
    });

    it('rejects a second close rather than moving endedAt', async () => {
      sessionsRepository.findOne.mockResolvedValue(
        session({ status: SessionStatus.COMPLETED }),
      );

      await expect(
        service.close(asUser('driver'), SESSION_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(sessionsRepository.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('403s a team driver closing someone else run', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());
      carsService.requireWritableCar.mockRejectedValue(
        new ForbiddenException(),
      );

      await expect(
        service.close(asUser('teammate'), SESSION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getTelemetry', () => {
    it('defaults the window to the session, ending now while it is live', async () => {
      sessionsRepository.findOne.mockResolvedValue(session());
      const before = Date.now();

      await service.getTelemetry(asUser('driver'), SESSION_ID, {});

      const [sessionId, from, to, maxPoints] =
        telemetryRepository.findDownsampled.mock.calls[0];
      expect(sessionId).toBe(SESSION_ID);
      expect(from).toEqual(new Date('2026-08-01T10:00:00Z'));
      expect(to.getTime()).toBeGreaterThanOrEqual(before);
      expect(maxPoints).toBe(2000);
    });

    it('ends the window at endedAt once the session is closed', async () => {
      const endedAt = new Date('2026-08-01T10:40:00Z');
      sessionsRepository.findOne.mockResolvedValue(
        session({ status: SessionStatus.COMPLETED, endedAt }),
      );

      await service.getTelemetry(asUser('driver'), SESSION_ID, {});

      expect(telemetryRepository.findDownsampled.mock.calls[0][2]).toEqual(
        endedAt,
      );
    });

    it('404s an outsider rather than returning a driver GPS trace', async () => {
      // Same scoping as every other session read — there is no route to
      // telemetry that skips requireReadableSession.
      sessionsRepository.findOne.mockResolvedValue(session());
      carsService.requireReadableCar.mockRejectedValue(new NotFoundException());

      await expect(
        service.getTelemetry(asUser('outsider'), SESSION_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(telemetryRepository.findDownsampled).not.toHaveBeenCalled();
    });
  });
});
