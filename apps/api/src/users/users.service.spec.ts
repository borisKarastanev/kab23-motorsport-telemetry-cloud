import { Test } from '@nestjs/testing';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { User } from './entities/user.entity';

const USER_ID = 'user-1';

const user = (overrides: Partial<User> = {}) =>
  ({
    id: USER_ID,
    email: 'driver@example.test',
    displayName: 'Driver',
    ...overrides,
  }) as User;

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: jest.Mocked<Partial<UsersRepository>>;

  beforeEach(async () => {
    usersRepository = {
      createUser: jest.fn(),
      validateUser: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: usersRepository },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  describe('create', () => {
    it('delegates registration to the repository', async () => {
      const createUserDto = {
        email: 'driver@example.test',
        password: 'hunter2',
        displayName: 'Driver',
      };
      usersRepository.createUser.mockResolvedValue(user());

      await expect(service.create(createUserDto as never)).resolves.toEqual(
        user(),
      );
      expect(usersRepository.createUser).toHaveBeenCalledWith(createUserDto);
    });
  });

  describe('verifyUser', () => {
    it('delegates credential checking to the repository', async () => {
      usersRepository.validateUser.mockResolvedValue(user());

      await expect(
        service.verifyUser('driver@example.test', 'hunter2'),
      ).resolves.toEqual(user());
      expect(usersRepository.validateUser).toHaveBeenCalledWith(
        'driver@example.test',
        'hunter2',
      );
    });
  });

  describe('fetchUser', () => {
    it('looks the user up by id', async () => {
      usersRepository.findOne.mockResolvedValue(user());

      await expect(service.fetchUser({ id: USER_ID })).resolves.toEqual(user());
      expect(usersRepository.findOne).toHaveBeenCalledWith({ id: USER_ID });
    });
  });

  describe('updateProfile', () => {
    it('patches the caller identified by userId, not a body field', async () => {
      const updateProfileDto = { displayName: 'New Name' };
      usersRepository.findOneAndUpdate.mockResolvedValue(
        user({ displayName: 'New Name' }),
      );

      await expect(
        service.updateProfile(USER_ID, updateProfileDto),
      ).resolves.toMatchObject({ displayName: 'New Name' });
      expect(usersRepository.findOneAndUpdate).toHaveBeenCalledWith(
        { id: USER_ID },
        updateProfileDto,
      );
    });
  });
});
