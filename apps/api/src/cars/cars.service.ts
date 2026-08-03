import { MANAGING_TEAM_ROLES, UserRole } from '@app/common';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TeamsService } from '../teams/teams.service';
import { TeamMember } from '../teams/entities/team-member.entity';
import { User } from '../users/entities/user.entity';
import { CarsRepository } from './cars.repository';
import { Car } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';

@Injectable()
export class CarsService {
  constructor(
    private readonly carsRepository: CarsRepository,
    private readonly teamsService: TeamsService,
  ) {}

  async create(user: User, createCarDto: CreateCarDto): Promise<Car> {
    const { teamId } = createCarDto;

    if (teamId) {
      await this.teamsService.requireTeamRole(
        user,
        teamId,
        ...MANAGING_TEAM_ROLES,
      );
    }

    return this.carsRepository.createCar(
      new Car({ ...createCarDto, ownerId: user.id }),
    );
  }

  async findAll(user: User): Promise<Car[]> {
    if (user.role === UserRole.ADMIN) {
      return this.carsRepository.findAll();
    }

    return this.carsRepository.findVisible({
      ownerId: user.id,
      teamIds: await this.teamsService.getUserTeamIds(user.id),
    });
  }

  async findOne(user: User, carId: string): Promise<Car> {
    return this.requireReadableCar(user, carId);
  }

  async update(
    user: User,
    carId: string,
    updateCarDto: UpdateCarDto,
  ): Promise<Car> {
    const car = await this.requireWritableCar(user, carId);

    // Re-homing a car is an authorization change, not a field edit — and
    // `teamId: null` is a re-homing too. `@IsOptional()` lets null through
    // unvalidated, so testing truthiness here would silently skip the check and
    // let a team manager detach a car they do not own, cutting off every other
    // member (and themselves) from it irreversibly.
    if ('teamId' in updateCarDto && updateCarDto.teamId !== car.teamId) {
      // Only the owner may take a car out of, or move it between, teams.
      if (
        car.teamId &&
        car.ownerId !== user.id &&
        user.role !== UserRole.ADMIN
      ) {
        throw new ForbiddenException(
          'Only the car owner may move it between teams',
        );
      }

      if (updateCarDto.teamId) {
        await this.teamsService.requireTeamRole(
          user,
          updateCarDto.teamId,
          ...MANAGING_TEAM_ROLES,
        );
      }
    }

    return this.carsRepository.updateCar(carId, updateCarDto);
  }

  async remove(user: User, carId: string): Promise<void> {
    await this.requireWritableCar(user, carId);
    await this.carsRepository.findOneAndDelete({ id: carId });
  }

  // ---------------------------------------------------------------------------
  // Scoping primitives — SessionsService derives its own scoping from these.
  // ---------------------------------------------------------------------------

  /**
   * A car the caller owns, or one belonging to a team they are in.
   *
   * Anything else is a 404 even though the row exists: a 403 would confirm to
   * an outsider that this car id is real and belongs to someone.
   */
  async requireReadableCar(user: User, carId: string): Promise<Car> {
    const { car, membership } = await this.resolveAccess(user, carId);
    return this.assertReadable(user, car, membership);
  }

  /**
   * Write access: the owner, or a manager of the team the car runs under. A
   * team DRIVER can see the car but not change or delete it — hence 403 here,
   * where existence is already established by the read check.
   */
  async requireWritableCar(user: User, carId: string): Promise<Car> {
    const { car, membership } = await this.resolveAccess(user, carId);

    // Read first: an outsider must get the 404 rather than a 403 that would
    // confirm the id is real.
    this.assertReadable(user, car, membership);

    if (user.role === UserRole.ADMIN || car.ownerId === user.id) {
      return car;
    }

    if (membership && MANAGING_TEAM_ROLES.includes(membership.role)) {
      return car;
    }

    throw new ForbiddenException('Insufficient permissions for this car');
  }

  /**
   * The car plus the caller's standing in its team, fetched once. Both
   * `require*` methods read from this, so a write no longer re-queries the
   * membership the read check already resolved.
   */
  private async resolveAccess(
    user: User,
    carId: string,
  ): Promise<{ car: Car; membership: TeamMember | null }> {
    const car = await this.carsRepository.findOne({ id: carId });
    const membership = car.teamId
      ? await this.teamsService.getMembership(user.id, car.teamId)
      : null;

    return { car, membership };
  }

  private assertReadable(
    user: User,
    car: Car,
    membership: TeamMember | null,
  ): Car {
    if (user.role === UserRole.ADMIN || car.ownerId === user.id || membership) {
      return car;
    }

    throw new NotFoundException('Car not found');
  }

  /**
   * Ids only — sessions scope themselves by car id and never render the car.
   * `teamId` narrows to a single team; callers must have authorized it first.
   */
  async getVisibleCarIds(user: User, teamId?: string): Promise<string[]> {
    if (teamId) {
      return this.carsRepository.findVisibleIds({ teamIds: [teamId] });
    }

    if (user.role === UserRole.ADMIN) {
      return this.carsRepository.findAllIds();
    }

    return this.carsRepository.findVisibleIds({
      ownerId: user.id,
      teamIds: await this.teamsService.getUserTeamIds(user.id),
    });
  }
}
