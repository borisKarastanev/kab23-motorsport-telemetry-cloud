import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AbstractEntity } from './abstract.entity';
import { UNIQUE_VIOLATION } from './postgres-errors';

/**
 * Log which fields were searched on, never their values — lookup criteria carry
 * PII (emails, user ids, device ids) that must not land in a log sink.
 */
const criteriaKeys = (where: object): string => Object.keys(where).join(', ');

export abstract class AbstractRepository<T extends AbstractEntity<T>> {
  protected abstract readonly logger: Logger;

  constructor(
    private readonly entityRepository: Repository<T>,
    private readonly entityManager: EntityManager,
  ) {}

  async create(entity: T): Promise<T> {
    return this.entityManager.save(entity);
  }

  async findOne(where: FindOptionsWhere<T>): Promise<T> {
    const entity = await this.entityRepository.findOne({ where });

    if (!entity) {
      this.logger.warn(`Entity not found where ${criteriaKeys(where)}`);
      throw new NotFoundException('Entity not found');
    }

    return entity;
  }

  async findOneAndUpdate(
    where: FindOptionsWhere<T>,
    partialEntity: QueryDeepPartialEntity<T>,
  ): Promise<T> {
    const updateResult = await this.entityRepository.update(
      where,
      partialEntity,
    );

    if (!updateResult.affected) {
      this.logger.warn(`Entity not found where ${criteriaKeys(where)}`);
      throw new NotFoundException('Entity not found');
    }

    return this.findOne(where);
  }

  async find(where: FindOptionsWhere<T>): Promise<T[]> {
    return this.entityRepository.findBy(where);
  }

  async findAll(): Promise<T[]> {
    return this.entityRepository.find();
  }

  async findOneAndDelete(where: FindOptionsWhere<T>): Promise<void> {
    const result = await this.entityRepository.delete(where);
    if (!result.affected) {
      this.logger.warn(`Entity not found where ${criteriaKeys(where)}`);
      throw new NotFoundException('Entity not found');
    }
  }

  /**
   * Colliding with a unique index is a duplicate request, not a server fault,
   * so it must surface as 409 rather than 500.
   *
   * `message` is a caller-supplied constant, never the offending value: echoing
   * it back would confirm which emails or device ids are already registered.
   * Anything that is not a unique violation is rethrown untouched, so a
   * connection failure cannot masquerade as a duplicate.
   */
  protected async createOrConflict(entity: T, message: string): Promise<T> {
    try {
      return await this.create(entity);
    } catch (error) {
      throw this.asConflict(error, message);
    }
  }

  protected async updateOrConflict(
    where: FindOptionsWhere<T>,
    partialEntity: QueryDeepPartialEntity<T>,
    message: string,
  ): Promise<T> {
    try {
      return await this.findOneAndUpdate(where, partialEntity);
    } catch (error) {
      throw this.asConflict(error, message);
    }
  }

  private asConflict(error: { code?: string }, message: string): unknown {
    return error?.code === UNIQUE_VIOLATION
      ? new ConflictException(message)
      : error;
  }
}
