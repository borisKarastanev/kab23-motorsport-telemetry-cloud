import { SessionStatus } from '@app/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { User } from '../users/entities/user.entity';
import { Session } from './entities/session.entity';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { QuerySessionsDto } from './dto/query-sessions.dto';
import { QueryTelemetryDto } from './dto/query-telemetry.dto';
import { TelemetryPointDto } from './dto/telemetry-point.dto';
import { SessionListItemDto } from './dto/session-list-item.dto';

const SESSION_ID = 'session-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const session = (overrides: Partial<Session> = {}) =>
  new Session({
    id: SESSION_ID,
    carId: 'car-1',
    driverId: 'user-1',
    track: 'spa',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    status: SessionStatus.LIVE,
    ...overrides,
  });

describe('SessionsController', () => {
  let controller: SessionsController;
  let sessionsService: jest.Mocked<Partial<SessionsService>>;

  beforeEach(() => {
    sessionsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      getTelemetry: jest.fn(),
      update: jest.fn(),
      close: jest.fn(),
      remove: jest.fn(),
    };

    controller = new SessionsController(
      sessionsService as unknown as SessionsService,
    );
  });

  it('create delegates to the service with the caller and dto', async () => {
    const user = asUser('user-1');
    const dto: CreateSessionDto = { carId: 'car-1', track: 'spa' };
    const created = session();
    sessionsService.create!.mockResolvedValue(created);

    await expect(controller.create(user, dto)).resolves.toBe(created);
    expect(sessionsService.create).toHaveBeenCalledWith(user, dto);
  });

  it('findAll delegates to the service with the caller and query', async () => {
    const user = asUser('user-1');
    const query: QuerySessionsDto = { carId: 'car-1' };
    const items = [session() as unknown as SessionListItemDto];
    sessionsService.findAll!.mockResolvedValue(items);

    await expect(controller.findAll(user, query)).resolves.toBe(items);
    expect(sessionsService.findAll).toHaveBeenCalledWith(user, query);
  });

  it('findOne delegates to the service with user and id', async () => {
    const user = asUser('user-1');
    const found = session();
    sessionsService.findOne!.mockResolvedValue(found);

    await expect(controller.findOne(user, SESSION_ID)).resolves.toBe(found);
    expect(sessionsService.findOne).toHaveBeenCalledWith(user, SESSION_ID);
  });

  it('getTelemetry delegates to the service with user, id and query', async () => {
    const user = asUser('user-1');
    const query: QueryTelemetryDto = { maxPoints: 500 };
    const points: TelemetryPointDto[] = [];
    sessionsService.getTelemetry!.mockResolvedValue(points);

    await expect(
      controller.getTelemetry(user, SESSION_ID, query),
    ).resolves.toBe(points);
    expect(sessionsService.getTelemetry).toHaveBeenCalledWith(
      user,
      SESSION_ID,
      query,
    );
  });

  it('update delegates to the service with user, id and dto', async () => {
    const user = asUser('user-1');
    const dto: UpdateSessionDto = { track: 'monza' };
    const updated = session({ track: 'monza' });
    sessionsService.update!.mockResolvedValue(updated);

    await expect(controller.update(user, SESSION_ID, dto)).resolves.toBe(
      updated,
    );
    expect(sessionsService.update).toHaveBeenCalledWith(
      user,
      SESSION_ID,
      dto,
    );
  });

  it('close delegates to the service with user and id', async () => {
    const user = asUser('user-1');
    const closed = session({ status: SessionStatus.COMPLETED });
    sessionsService.close!.mockResolvedValue(closed);

    await expect(controller.close(user, SESSION_ID)).resolves.toBe(closed);
    expect(sessionsService.close).toHaveBeenCalledWith(user, SESSION_ID);
  });

  it('remove delegates to the service with user and id', async () => {
    const user = asUser('user-1');
    sessionsService.remove!.mockResolvedValue(undefined);

    await expect(
      controller.remove(user, SESSION_ID),
    ).resolves.toBeUndefined();
    expect(sessionsService.remove).toHaveBeenCalledWith(user, SESSION_ID);
  });
});
