import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';

const USER_ID = 'user-1';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

const user = (overrides: Partial<User> = {}) =>
  new User({
    id: USER_ID,
    email: 'driver@example.test',
    password: 'hashed',
    displayName: 'Driver',
    ...overrides,
  });

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<Partial<UsersService>>;

  beforeEach(() => {
    usersService = {
      updateProfile: jest.fn(),
    };

    controller = new UsersController(usersService as unknown as UsersService);
  });

  it('updateProfile delegates to the service with the caller id and dto', async () => {
    const caller = asUser(USER_ID);
    const dto: UpdateProfileDto = { displayName: 'New Name' };
    const updated = user({ displayName: 'New Name' });
    usersService.updateProfile!.mockResolvedValue(updated);

    await expect(controller.updateProfile(caller, dto)).resolves.toBe(updated);
    expect(usersService.updateProfile).toHaveBeenCalledWith(caller.id, dto);
  });
});
