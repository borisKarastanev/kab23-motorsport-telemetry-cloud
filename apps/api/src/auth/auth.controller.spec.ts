import { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { CreateUserDto } from '../users/dto/create-user.dto';

const asUser = (id: string) => ({ id, email: `${id}@example.test` }) as User;

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<Partial<AuthService>>;
  let usersService: jest.Mocked<Partial<UsersService>>;

  beforeEach(() => {
    authService = {
      login: jest.fn(),
      logout: jest.fn(),
    };
    usersService = {
      create: jest.fn(),
    };

    controller = new AuthController(
      authService as unknown as AuthService,
      usersService as unknown as UsersService,
    );
  });

  describe('register', () => {
    it('delegates straight to usersService.create', async () => {
      const dto: CreateUserDto = {
        email: 'driver@example.test',
        password: 'test-password-123!A',
      };
      const created = asUser('user-1');
      usersService.create!.mockResolvedValue(created);

      await expect(controller.register(dto)).resolves.toBe(created);
      expect(usersService.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('login', () => {
    it('delegates to authService.login with the authenticated user and response', () => {
      const user = asUser('user-1');
      const response = {} as Response;
      authService.login!.mockReturnValue(user);

      const result = controller.login(user, response);

      expect(authService.login).toHaveBeenCalledWith(user, response);
      expect(result).toBe(user);
    });
  });

  describe('logout', () => {
    it('clears the cookie and reports success', () => {
      const response = {} as Response;

      const result = controller.logout(response);

      expect(authService.logout).toHaveBeenCalledWith(response);
      expect(result).toEqual({ success: true });
    });
  });

  describe('me', () => {
    it('returns the authenticated user as-is', () => {
      const user = asUser('user-1');

      expect(controller.me(user)).toBe(user);
    });
  });
});
