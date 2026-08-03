import { TeamRole, UserRole } from '@app/common';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TeamsService } from '../teams/teams.service';
import { User } from '../users/entities/user.entity';
import { CarsService } from './cars.service';
import { CarsRepository } from './cars.repository';
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

  beforeEach(async () => {
    carsRepository = {
      createCar: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findVisible: jest.fn().mockResolvedValue([]),
      findVisibleIds: jest.fn().mockResolvedValue([]),
      findAllIds: jest.fn().mockResolvedValue([]),
      updateCar: jest.fn(),
    };
    teamsService = {
      requireTeamRole: jest.fn(),
      getMembership: jest.fn().mockResolvedValue(null),
      getUserTeamIds: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CarsService,
        { provide: CarsRepository, useValue: carsRepository },
        { provide: TeamsService, useValue: teamsService },
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
});
