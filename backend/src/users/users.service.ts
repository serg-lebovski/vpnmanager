import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsNull, Repository } from 'typeorm';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';
import { CreateUserDto } from './dto/create-user.dto';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly usersRepository: Repository<User>) {}

  async findAllForRequester(requester: AuthenticatedUser): Promise<Omit<User, 'passwordHash'>[]> {
    const where = requester.role === Role.SUPER_ADMIN ? {} : { organizationId: requester.organizationId ?? IsNull() };
    const users = await this.usersRepository.find({ where, order: { createdAt: 'DESC' } });
    return users.map(({ passwordHash, ...rest }) => rest);
  }

  async createForRequester(requester: AuthenticatedUser, dto: CreateUserDto): Promise<Omit<User, 'passwordHash'>> {
    let organizationId: string | null;

    if (requester.role === Role.SUPER_ADMIN) {
      if (dto.role !== Role.SUPER_ADMIN && !dto.organizationId) {
        throw new BadRequestException('Для этой роли обязателен organizationId');
      }
      organizationId = dto.role === Role.SUPER_ADMIN ? null : dto.organizationId!;
    } else if (requester.role === Role.ORG_ADMIN) {
      if (dto.role !== Role.ORG_USER) {
        throw new ForbiddenException('Администратор организации может создавать только пользователей своей организации');
      }
      organizationId = requester.organizationId;
    } else {
      throw new ForbiddenException('Недостаточно прав для создания пользователей');
    }

    const existing = await this.usersRepository.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.usersRepository.create({
      email: dto.email,
      passwordHash,
      role: dto.role,
      organizationId,
    });
    const saved = await this.usersRepository.save(user);
    const { passwordHash: _omit, ...safe } = saved;
    return safe;
  }

  async removeForRequester(requester: AuthenticatedUser, id: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }
    if (requester.role !== Role.SUPER_ADMIN && user.organizationId !== requester.organizationId) {
      throw new ForbiddenException('Недостаточно прав для удаления этого пользователя');
    }
    await this.usersRepository.remove(user);
  }
}
