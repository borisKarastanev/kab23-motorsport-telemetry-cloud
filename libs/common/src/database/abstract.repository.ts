import { Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AbstractEntity } from './abstract.entity';

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
}
