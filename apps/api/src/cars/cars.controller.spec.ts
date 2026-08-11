import { CarsController } from './cars.controller';
import { CarsService } from './cars.service';
import { User } from '../users/entities/user.entity';
import { Car } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { MqttCredentialsDto } from './dto/mqtt-credentials.dto';

const CAR_ID = 'car-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const car = (overrides: Partial<Car> = {}) =>
  new Car({
    id: CAR_ID,
    name: 'E46',
    deviceId: 'TEST123',
    ownerId: 'owner',
    ...overrides,
  });

describe('CarsController', () => {
  let controller: CarsController;
  let carsService: jest.Mocked<Partial<CarsService>>;

  beforeEach(() => {
    carsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      issueMqttCredentials: jest.fn(),
      remove: jest.fn(),
    };

    controller = new CarsController(carsService as unknown as CarsService);
  });

  it('create delegates to the service with the caller and dto', async () => {
    const user = asUser('user-1');
    const dto: CreateCarDto = { name: 'E46', deviceId: 'TEST123' };
    const created = car();
    carsService.create!.mockResolvedValue(created);

    await expect(controller.create(user, dto)).resolves.toBe(created);
    expect(carsService.create).toHaveBeenCalledWith(user, dto);
  });

  it('findAll delegates to the service scoped to the caller', async () => {
    const user = asUser('user-1');
    const cars = [car()];
    carsService.findAll!.mockResolvedValue(cars);

    await expect(controller.findAll(user)).resolves.toBe(cars);
    expect(carsService.findAll).toHaveBeenCalledWith(user);
  });

  it('findOne delegates to the service with user and id', async () => {
    const user = asUser('user-1');
    const found = car();
    carsService.findOne!.mockResolvedValue(found);

    await expect(controller.findOne(user, CAR_ID)).resolves.toBe(found);
    expect(carsService.findOne).toHaveBeenCalledWith(user, CAR_ID);
  });

  it('update delegates to the service with user, id and dto', async () => {
    const user = asUser('user-1');
    const dto: UpdateCarDto = { name: 'E46 GTR' };
    const updated = car({ name: 'E46 GTR' });
    carsService.update!.mockResolvedValue(updated);

    await expect(controller.update(user, CAR_ID, dto)).resolves.toBe(updated);
    expect(carsService.update).toHaveBeenCalledWith(user, CAR_ID, dto);
  });

  it('issueMqttCredentials delegates to the service', async () => {
    const user = asUser('user-1');
    const credentials: MqttCredentialsDto = {
      username: 'TEST123',
      password: 'broker-secret',
      issuedAt: new Date(),
    };
    carsService.issueMqttCredentials!.mockResolvedValue(credentials);

    await expect(controller.issueMqttCredentials(user, CAR_ID)).resolves.toBe(
      credentials,
    );
    expect(carsService.issueMqttCredentials).toHaveBeenCalledWith(user, CAR_ID);
  });

  it('remove delegates to the service with user and id', async () => {
    const user = asUser('user-1');
    carsService.remove!.mockResolvedValue(undefined);

    await expect(controller.remove(user, CAR_ID)).resolves.toBeUndefined();
    expect(carsService.remove).toHaveBeenCalledWith(user, CAR_ID);
  });
});
