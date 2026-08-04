import { getMetadataArgsStorage } from 'typeorm';
import { Car } from '../../../api/src/cars/entities/car.entity';
import { Session } from '../../../api/src/sessions/entities/session.entity';
import { CarRef } from './entities/car-ref.entity';
import { SessionRef } from './entities/session-ref.entity';

/**
 * Guards the one real cost of ingest keeping its own view of `apps/api`'s
 * tables (see `car-ref.entity.ts`): the two definitions can drift.
 *
 * A rename in `apps/api` is invisible to ingest until frames stop being
 * written in production, so it is caught here instead. This is the only place
 * that reaches across app boundaries, and it is a test — no runtime coupling
 * comes with it.
 */

type Ctor = { new (...args: never[]): object };

/** Column property → database column name, following the inheritance chain. */
const columnsOf = (target: Ctor): Map<string, string> => {
  const chain: unknown[] = [];
  for (
    let current: unknown = target;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    chain.push(current);
  }

  return new Map(
    getMetadataArgsStorage()
      .columns.filter((column) => chain.includes(column.target))
      .map((column) => [
        column.propertyName,
        column.options?.name ?? column.propertyName,
      ]),
  );
};

const tableOf = (target: Ctor) =>
  getMetadataArgsStorage().tables.find((table) => table.target === target);

describe('ingest entity parity with apps/api', () => {
  describe.each([
    ['CarRef', 'Car', CarRef as Ctor, Car as Ctor],
    ['SessionRef', 'Session', SessionRef as Ctor, Session as Ctor],
  ])('%s ↔ %s', (_refName, _ownerName, ref, owner) => {
    it('points at the same table', () => {
      expect(tableOf(ref)?.name).toBe(tableOf(owner)?.name);
    });

    it('never synchronises, so apps/api stays the only schema owner', () => {
      // Without this, a TypeORM schema sync from the ingest process could drop
      // every column of the real table that this thin view omits.
      expect(tableOf(ref)?.synchronize).toBe(false);
    });

    it('maps each property to the same column name', () => {
      const ownerColumns = columnsOf(owner);

      for (const [property, columnName] of columnsOf(ref)) {
        expect(ownerColumns.has(property)).toBe(true);
        expect({ property, columnName }).toEqual({
          property,
          columnName: ownerColumns.get(property),
        });
      }
    });
  });

  it('covers every column ingest writes to sessions', () => {
    // SessionRef is written, not just read, so a NOT NULL column added in
    // apps/api and missing here would fail every insert at runtime. Reads are
    // free to be partial; writes are not.
    const required = [
      'carId',
      'driverId',
      'track',
      'startedAt',
      'status',
      'deviceSessionId',
      'deviceMonoStartMs',
      'createdAt',
      'updatedAt',
    ];

    expect([...columnsOf(SessionRef as Ctor).keys()]).toEqual(
      expect.arrayContaining(required),
    );
  });
});
