import { AbstractRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Car } from './entities/car.entity';

// Never names the deviceId: a message echoing it would confirm which device
// identifiers are already provisioned on the platform.
const DEVICE_CONFLICT = 'Car could not be saved';

/** Which cars a query covers. At least one field must select something. */
export interface CarScope {
  ownerId?: string;
  teamIds?: string[];
}

@Injectable()
export class CarsRepository extends AbstractRepository<Car> {
  protected readonly logger: Logger = new Logger(CarsRepository.name);

  constructor(
    @InjectRepository(Car)
    private readonly carsRepository: Repository<Car>,
    entityManager: EntityManager,
  ) {
    super(carsRepository, entityManager);
  }

  async createCar(car: Car): Promise<Car> {
    return this.createOrConflict(car, DEVICE_CONFLICT);
  }

  /** `deviceId` is patchable and unique, so an update collides as a create does. */
  async updateCar(
    id: string,
    partial: QueryDeepPartialEntity<Car>,
  ): Promise<Car> {
    return this.updateOrConflict({ id }, partial, DEVICE_CONFLICT);
  }

  /**
   * Ids only — sessions scope themselves by car id and never render the car,
   * so hydrating whole rows just to read `.id` is wasted I/O.
   */
  async findVisibleIds(scope: CarScope): Promise<string[]> {
    const query = this.scopedQuery(scope);

    if (!query) {
      return [];
    }

    const rows = await query
      .select('car.id', 'id')
      .getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  async findAllIds(): Promise<string[]> {
    const rows = await this.carsRepository
      .createQueryBuilder('car')
      .select('car.id', 'id')
      .getRawMany<{ id: string }>();

    return rows.map((row) => row.id);
  }

  async findVisible(scope: CarScope): Promise<Car[]> {
    const query = this.scopedQuery(scope);
    return query ? query.orderBy('car.name', 'ASC').getMany() : [];
  }

  /**
   * Null when the scope selects nothing at all. Returning a query with no
   * predicates would silently widen to every car on the platform, so the
   * "empty scope" case is made unrepresentable rather than left to SQL.
   */
  private scopedQuery({ ownerId, teamIds = [] }: CarScope) {
    const predicates: string[] = [];

    if (ownerId) {
      predicates.push('car.ownerId = :ownerId');
    }
    if (teamIds.length) {
      predicates.push('car.teamId IN (:...teamIds)');
    }
    if (!predicates.length) {
      return null;
    }

    return this.carsRepository
      .createQueryBuilder('car')
      .where(`(${predicates.join(' OR ')})`, { ownerId, teamIds });
  }
}
