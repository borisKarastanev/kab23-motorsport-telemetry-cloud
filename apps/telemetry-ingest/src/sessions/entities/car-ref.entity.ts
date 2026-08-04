import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The ingest service's read-only view of `apps/api`'s `cars` table.
 *
 * Ingest has to resolve an incoming `deviceId` to a car, but `Car` lives in
 * `apps/api` and `libs/common` may not import from `apps/*`. Promoting the
 * entity into `libs/common` would drag `User` and `Team` along with it; calling
 * the API over HTTP would put a network hop on the write path. So ingest keeps
 * this thin view of the same table instead, carrying only the columns it
 * touches.
 *
 * `synchronize: false` is the whole point: `apps/api` stays the sole owner of
 * this schema, and ingest is structurally incapable of rewriting it — a column
 * missing from this class can never translate into a dropped column.
 *
 * The drift risk that remains (someone renames a column in `apps/api`) is
 * covered by `entity-parity.spec.ts`.
 */
@Entity({ name: 'cars', synchronize: false })
export class CarRef {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  deviceId: string;

  @Column()
  ownerId: string;

  @Column({ nullable: true })
  teamId?: string;
}
