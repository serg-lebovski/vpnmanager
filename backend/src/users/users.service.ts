import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsNull, Repository } from 'typeorm';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Role } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
  ) {}

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

  // Ограничено суперадмином на уровне контроллера (@Roles(Role.SUPER_ADMIN)) — org_admin
  // не может ни менять роли/организации, ни сбрасывать чужие пароли, только создавать
  // org_user своей организации (см. createForRequester) и удалять их же.
  async updateForRequester(id: string, dto: UpdateUserDto): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    if (dto.email !== undefined && dto.email !== user.email) {
      const existing = await this.usersRepository.findOne({ where: { email: dto.email } });
      if (existing) {
        throw new ConflictException('Пользователь с таким email уже существует');
      }
      user.email = dto.email;
    }

    if (dto.password !== undefined) {
      user.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    const nextRole = dto.role ?? user.role;
    const nextOrganizationId = dto.organizationId !== undefined ? dto.organizationId : user.organizationId;

    if (nextRole !== Role.SUPER_ADMIN) {
      if (!nextOrganizationId) {
        throw new BadRequestException('Для этой роли обязателен organizationId');
      }
      const organization = await this.organizationsRepository.findOne({ where: { id: nextOrganizationId } });
      if (!organization) {
        throw new NotFoundException('Организация не найдена');
      }
    }

    user.role = nextRole;
    // super_admin организационно ничей — иначе он попал бы в org-скоуп наравне с
    // org_admin/org_user (см. resolveOrganizationId в peers.service.ts и аналогичные места).
    user.organizationId = nextRole === Role.SUPER_ADMIN ? null : nextOrganizationId;

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
