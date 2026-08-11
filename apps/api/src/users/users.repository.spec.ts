import { UserRole } from '@app/common';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { EntityManager, Repository } from 'typeorm';
import { UsersRepository } from './users.repository';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

describe('UsersRepository', () => {
  let typeormRepository: jest.Mocked<Partial<Repository<User>>>;
  let entityManager: jest.Mocked<Partial<EntityManager>>;
  let repository: UsersRepository;

  beforeEach(() => {
    typeormRepository = { findOne: jest.fn() };
    entityManager = { save: jest.fn() };
    repository = new UsersRepository(
      typeormRepository as unknown as Repository<User>,
      entityManager as unknown as EntityManager,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createUser', () => {
    it('lowercases the email and stores a bcrypt hash rather than the raw password', async () => {
      (entityManager.save as jest.Mock).mockImplementation(
        (user: User) => user,
      );

      const dto: CreateUserDto = {
        email: 'Driver@Example.TEST',
        password: 'super-secret',
        displayName: 'Driver',
        role: UserRole.DRIVER,
      } as CreateUserDto;

      const created = await repository.createUser(dto);

      expect(created.email).toBe('driver@example.test');
      expect(created.password).not.toBe('super-secret');
      await expect(
        bcrypt.compare('super-secret', created.password),
      ).resolves.toBe(true);
    });

    it('reports a duplicate email as a conflict without naming the address', async () => {
      (entityManager.save as jest.Mock).mockRejectedValue({ code: '23505' });

      const promise = repository.createUser({
        email: 'driver@example.test',
        password: 'super-secret',
        displayName: 'Driver',
        role: UserRole.DRIVER,
      } as CreateUserDto);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      await promise.catch((error: ConflictException) => {
        expect(JSON.stringify(error.getResponse())).not.toContain(
          'driver@example.test',
        );
      });
    });
  });

  describe('validateUser', () => {
    it('resolves the user when the password matches', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      const user = {
        id: '1',
        email: 'driver@example.test',
        password: hashed,
      } as User;
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(user);

      await expect(
        repository.validateUser('driver@example.test', 'correct-password'),
      ).resolves.toBe(user);
    });

    it('normalizes the email before lookup', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      (typeormRepository.findOne as jest.Mock).mockResolvedValue({
        id: '1',
        email: 'driver@example.test',
        password: hashed,
      } as User);

      await repository.validateUser('Driver@Example.TEST', 'correct-password');

      expect(typeormRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'driver@example.test' },
      });
    });

    it('rejects an unknown email with a generic message, never a 404', async () => {
      (typeormRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        repository.validateUser('nobody@example.test', 'whatever'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password with the same generic message as an unknown email', async () => {
      const hashed = await bcrypt.hash('correct-password', 10);
      (typeormRepository.findOne as jest.Mock).mockResolvedValue({
        id: '1',
        email: 'driver@example.test',
        password: hashed,
      } as User);

      const unknownEmailError = await repository
        .validateUser('nobody@example.test', 'whatever')
        .catch((error) => error);
      const wrongPasswordError = await repository
        .validateUser('driver@example.test', 'wrong-password')
        .catch((error) => error);

      expect(wrongPasswordError).toBeInstanceOf(UnauthorizedException);
      expect(wrongPasswordError.message).toBe(unknownEmailError.message);
    });
  });
});
