import { TeamRole, UserRole } from '@app/common';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TeamsService } from '../teams/teams.service';
import { User } from '../users/entities/user.entity';
import { CarsService } from './cars.service';
import { CarsRepository } from './cars.repository';
import { MqttAdminService } from './mqtt-admin.service';
import { Car } from './entities/car.entity';

const CAR_ID = 'car-1';
const TEAM_ID = 'team-1';

const asUser = (id: string, role = UserRole.DRIVER) =>
  ({ id, email: `${id}@example.test`, role }) as User;

const car = (overrides: Partial<Car> = {}) =>
  ({
    id: CAR_ID,
    name: 'E46',
    deviceId: 'TEST123',
    ownerId: 'owner',
    ...overrides,
  }) as Car;

describe('CarsService', () => {
  let service: CarsService;
  let carsRepository: jest.Mocked<Partial<CarsRepository>>;
  let teamsService: jest.Mocked<Partial<TeamsService>>;
  let mqttAdminService: jest.Mocked<Partial<MqttAdminService>>;

  beforeEach(async () => {
    carsRepository = {
      createCar: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findVisible: jest.fn().mockResolvedValue([]),
      findVisibleIds: jest.fn().mockResolvedValue([]),
      findAllIds: jest.fn().mockResolvedValue([]),
      updateCar: jest.fn(),
      findOneAndDelete: jest.fn(),
    };
    teamsService = {
      requireTeamRole: jest.fn(),
      getMembership: jest.fn().mockResolvedValue(null),
      getUserTeamIds: jest.fn().mockResolvedValue([]),
    };
    mqttAdminService = {
      ensureCar: jest.fn(),
      issuePassword: jest.fn().mockResolvedValue('broker-secret'),
      removeCar: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CarsService,
        { provide: CarsRepository, useValue: carsRepository },
        { provide: TeamsService, useValue: teamsService },
        { provide: MqttAdminService, useValue: mqttAdminService },
      ],
    }).compile();

    service = moduleRef.get(CarsService);
  });

  describe('create', () => {
    it('requires a managing role to file a car under a team', async () => {
      teamsService.requireTeamRole.mockRejectedValue(new ForbiddenException());

      await expect(
        service.create(asUser('user-1'), {
          name: 'E46',
          deviceId: 'TEST123',
          teamId: TEAM_ID,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(carsRepository.createCar).not.toHaveBeenCalled();
    });

    it('needs no team check for a privateer car', async () => {
      await service.create(asUser('user-1'), {
        name: 'E46',
        deviceId: 'TEST123',
      });

      expect(teamsService.requireTeamRole).not.toHaveBeenCalled();
      expect(carsRepository.createCar).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1' }),
      );
    });
  });

  describe('requireReadableCar', () => {
    it('lets the owner through', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      await expect(
        service.requireReadableCar(asUser('owner'), CAR_ID),
      ).resolves.toMatchObject({ id: CAR_ID });
    });

    it('lets a teammate through', async () => {
      carsRepository.findOne.mockResolvedValue(car({ teamId: TEAM_ID }));
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.DRIVER,
      } as never);

      await expect(
        service.requireReadableCar(asUser('teammate'), CAR_ID),
      ).resolves.toMatchObject({ id: CAR_ID });
    });

    it('404s an outsider instead of 403, so the car stays unconfirmed', async () => {
      carsRepository.findOne.mockResolvedValue(car({ teamId: TEAM_ID }));
      teamsService.getMembership.mockResolvedValue(null);

      await expect(
        service.requireReadableCar(asUser('outsider'), CAR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s an outsider on a privateer car too', async () => {
      carsRepository.findOne.mockResolvedValue(car());

      await expect(
        service.requireReadableCar(asUser('outsider'), CAR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('requireWritableCar', () => {
    it('403s a team driver who can see the car but not change it', async () => {
      carsRepository.findOne.mockResolvedValue(car({ teamId: TEAM_ID }));
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.DRIVER,
      } as never);

      await expect(
        service.requireWritableCar(asUser('teammate'), CAR_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admits a team manager', async () => {
      carsRepository.findOne.mockResolvedValue(car({ teamId: TEAM_ID }));
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.MANAGER,
      } as never);

      await expect(
        service.requireWritableCar(asUser('manager'), CAR_ID),
      ).resolves.toMatchObject({ id: CAR_ID });
    });
  });

  describe('update', () => {
    it('checks the destination team when re-homing a car', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      teamsService.requireTeamRole.mockRejectedValue(new ForbiddenException());

      await expect(
        service.update(asUser('owner'), CAR_ID, { teamId: 'other-team' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(carsRepository.updateCar).not.toHaveBeenCalled();
    });

    it('stops a team manager detaching a car they do not own', async () => {
      // `teamId: null` is a re-homing, not a field edit: class-validator lets
      // null past @IsOptional, so a truthiness check would skip the guard and
      // let a manager orphan someone else's car irreversibly.
      carsRepository.findOne.mockResolvedValue(
        car({ ownerId: 'owner', teamId: TEAM_ID }),
      );
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.MANAGER,
      } as never);

      await expect(
        service.update(asUser('manager'), CAR_ID, { teamId: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(carsRepository.updateCar).not.toHaveBeenCalled();
    });

    it('lets the owner detach their own car', async () => {
      carsRepository.findOne.mockResolvedValue(
        car({ ownerId: 'owner', teamId: TEAM_ID }),
      );

      await service.update(asUser('owner'), CAR_ID, { teamId: null });

      expect(carsRepository.updateCar).toHaveBeenCalledWith(CAR_ID, {
        teamId: null,
      });
    });

    it('leaves teamId alone when the patch does not mention it', async () => {
      carsRepository.findOne.mockResolvedValue(
        car({ ownerId: 'owner', teamId: TEAM_ID }),
      );

      await service.update(asUser('owner'), CAR_ID, { name: 'E46 GTR' });

      expect(teamsService.requireTeamRole).not.toHaveBeenCalled();
      expect(carsRepository.updateCar).toHaveBeenCalled();
    });
  });

  describe('broker provisioning', () => {
    it('provisions a broker account when a car is created', async () => {
      carsRepository.createCar.mockResolvedValue(car());

      await service.create(asUser('user-1'), {
        name: 'E46',
        deviceId: 'TEST123',
      });

      expect(mqttAdminService.ensureCar).toHaveBeenCalledWith('TEST123');
    });

    it('still creates the car when the broker is unreachable', async () => {
      // Nothing can publish yet — no credential has been issued — so a broker
      // outage here costs a retry, not a failed creation.
      carsRepository.createCar.mockResolvedValue(car());
      mqttAdminService.ensureCar.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(
        service.create(asUser('user-1'), { name: 'E46', deviceId: 'TEST123' }),
      ).resolves.toMatchObject({ id: CAR_ID });
    });

    it('revokes the old broker account when the deviceId changes', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      await service.update(asUser('owner'), CAR_ID, { deviceId: 'NEW456' });

      expect(mqttAdminService.removeCar).toHaveBeenCalledWith('TEST123');
      expect(mqttAdminService.ensureCar).toHaveBeenCalledWith('NEW456');
      // The old secret died with the old account, so the car is unprovisioned
      // until its owner issues a new one.
      expect(carsRepository.updateCar).toHaveBeenCalledWith(CAR_ID, {
        deviceId: 'NEW456',
        mqttProvisionedAt: null,
      });
    });

    it('does not touch the broker when the deviceId is unchanged', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      await service.update(asUser('owner'), CAR_ID, { deviceId: 'TEST123' });

      expect(mqttAdminService.removeCar).not.toHaveBeenCalled();
      expect(carsRepository.updateCar).toHaveBeenCalledWith(CAR_ID, {
        deviceId: 'TEST123',
      });
    });

    it('aborts a rename the broker could not even start', async () => {
      // Nothing has been revoked yet, so the car is untouched.
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      mqttAdminService.removeCar.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(
        service.update(asUser('owner'), CAR_ID, { deviceId: 'NEW456' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(carsRepository.updateCar).not.toHaveBeenCalled();
    });

    it('marks the car unprovisioned when a rename fails after revoking', async () => {
      // The old account is already gone, so the row must not keep claiming the
      // car is provisioned — an operator told otherwise has no reason to
      // re-issue, and the car silently never connects again.
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      mqttAdminService.ensureCar.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(
        service.update(asUser('owner'), CAR_ID, { deviceId: 'NEW456' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(carsRepository.updateCar).toHaveBeenCalledWith(CAR_ID, {
        mqttProvisionedAt: null,
      });
    });

    it('marks the car unprovisioned when the new deviceId collides', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      carsRepository.updateCar.mockRejectedValueOnce(
        new ConflictException('Car could not be saved'),
      );

      await expect(
        service.update(asUser('owner'), CAR_ID, { deviceId: 'TAKEN' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(carsRepository.updateCar).toHaveBeenLastCalledWith(CAR_ID, {
        mqttProvisionedAt: null,
      });
    });

    it('revokes broker access before deleting the car', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      await service.remove(asUser('owner'), CAR_ID);

      expect(mqttAdminService.removeCar).toHaveBeenCalledWith('TEST123');
      expect(carsRepository.findOneAndDelete).toHaveBeenCalledWith({
        id: CAR_ID,
      });
    });

    it('refuses to delete a car whose broker access it cannot revoke', async () => {
      // A deleted row with a live broker account is a device that still
      // publishes, with nothing left in the platform to show it exists.
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      mqttAdminService.removeCar.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(
        service.remove(asUser('owner'), CAR_ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(carsRepository.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('returns the secret once and records only the timestamp', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      const credentials = await service.issueMqttCredentials(
        asUser('owner'),
        CAR_ID,
      );

      expect(credentials).toMatchObject({
        username: 'TEST123',
        password: 'broker-secret',
      });
      // Whatever is persisted must not contain the secret in any form.
      const [, patch] = carsRepository.updateCar.mock.calls[0];
      expect(Object.keys(patch)).toEqual(['mqttProvisionedAt']);
      expect(JSON.stringify(patch)).not.toContain('broker-secret');
    });

    it('refuses to issue credentials to a team driver', async () => {
      // Handing out a credential grants the ability to publish as this car, so
      // it is an owner/manager action rather than something every driver can do.
      carsRepository.findOne.mockResolvedValue(car({ teamId: TEAM_ID }));
      teamsService.getMembership.mockResolvedValue({
        role: TeamRole.DRIVER,
      } as never);

      await expect(
        service.issueMqttCredentials(asUser('teammate'), CAR_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mqttAdminService.issuePassword).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('scopes to owned plus team cars for a normal user', async () => {
      teamsService.getUserTeamIds.mockResolvedValue([TEAM_ID]);

      await service.findAll(asUser('user-1'));

      expect(carsRepository.findVisible).toHaveBeenCalledWith({
        ownerId: 'user-1',
        teamIds: [TEAM_ID],
      });
      expect(carsRepository.findAll).not.toHaveBeenCalled();
    });

    it('returns everything for a platform admin', async () => {
      await service.findAll(asUser('admin', UserRole.ADMIN));

      expect(carsRepository.findAll).toHaveBeenCalled();
      expect(carsRepository.findVisible).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('resolves a readable car', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));

      await expect(
        service.findOne(asUser('owner'), CAR_ID),
      ).resolves.toMatchObject({ id: CAR_ID });
    });

    it('404s a car outside the caller tenant', async () => {
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'someone-else' }));

      await expect(
        service.findOne(asUser('outsider'), CAR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markUnprovisioned failure', () => {
    it('logs rather than throws when the fallback write also fails', async () => {
      // This runs while a rename failure is already propagating; it must not
      // replace that error with a failure of its own best-effort cleanup.
      carsRepository.findOne.mockResolvedValue(car({ ownerId: 'owner' }));
      mqttAdminService.ensureCar.mockRejectedValue(
        new ServiceUnavailableException(),
      );
      carsRepository.updateCar.mockRejectedValue(new Error('db unavailable'));

      await expect(
        service.update(asUser('owner'), CAR_ID, { deviceId: 'NEW456' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // The original rename failure surfaces, not the markUnprovisioned one.
      expect(carsRepository.updateCar).toHaveBeenCalledWith(CAR_ID, {
        mqttProvisionedAt: null,
      });
    });
  });

  describe('getVisibleCarIds', () => {
    it('narrows to a single team when teamId is given', async () => {
      carsRepository.findVisibleIds.mockResolvedValue(['car-a']);

      await expect(
        service.getVisibleCarIds(asUser('user-1'), TEAM_ID),
      ).resolves.toEqual(['car-a']);
      expect(carsRepository.findVisibleIds).toHaveBeenCalledWith({
        teamIds: [TEAM_ID],
      });
      expect(teamsService.getUserTeamIds).not.toHaveBeenCalled();
    });

    it('returns every car id for a platform admin with no teamId', async () => {
      carsRepository.findAllIds.mockResolvedValue(['car-a', 'car-b']);

      await expect(
        service.getVisibleCarIds(asUser('admin', UserRole.ADMIN)),
      ).resolves.toEqual(['car-a', 'car-b']);
      expect(carsRepository.findVisibleIds).not.toHaveBeenCalled();
    });

    it('scopes to owned plus team car ids for a normal user', async () => {
      teamsService.getUserTeamIds.mockResolvedValue([TEAM_ID]);
      carsRepository.findVisibleIds.mockResolvedValue(['car-a']);

      await expect(
        service.getVisibleCarIds(asUser('user-1')),
      ).resolves.toEqual(['car-a']);
      expect(carsRepository.findVisibleIds).toHaveBeenCalledWith({
        ownerId: 'user-1',
        teamIds: [TEAM_ID],
      });
    });
  });
});
