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
    it("revokes the caller's own token and reports success", async () => {
      // The payload, not just the response: revocation is per token, so that
      // signing out here leaves the same user's other devices alone.
      const response = {} as Response;
      const payload = { userId: 'user-1', jti: 'token-1', exp: 9999 };

      await expect(controller.logout(payload, response)).resolves.toEqual({
        success: true,
      });
      expect(authService.logout).toHaveBeenCalledWith(response, payload);
    });

    it('still clears the cookie for a token minted before jti existed', async () => {
      const response = {} as Response;

      await expect(controller.logout(undefined, response)).resolves.toEqual({
        success: true,
      });
      expect(authService.logout).toHaveBeenCalledWith(response, undefined);
    });
  });

  describe('me', () => {
    it('returns the authenticated user as-is', () => {
      const user = asUser('user-1');

      expect(controller.me(user)).toBe(user);
    });
  });
});
