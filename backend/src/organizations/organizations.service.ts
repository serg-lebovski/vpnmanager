import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';
import { Role } from '../common/enums';
import { User } from '../users/user.entity';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { Organization } from './organization.entity';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  findAll(): Promise<Organization[]> {
    return this.organizationsRepository.find({ order: { createdAt: 'DESC' } });
  }

  async findOneOrFail(id: string): Promise<Organization> {
    const organization = await this.organizationsRepository.findOne({ where: { id } });
    if (!organization) {
      throw new NotFoundException('Организация не найдена');
    }
    return organization;
  }

  async create(dto: CreateOrganizationDto): Promise<Organization> {
    const existingOrg = await this.organizationsRepository.findOne({ where: { name: dto.name } });
    if (existingOrg) {
      throw new ConflictException('Организация с таким именем уже существует');
    }
    const existingUser = await this.usersRepository.findOne({ where: { email: dto.adminEmail } });
    if (existingUser) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    return this.dataSource.transaction(async (manager) => {
      const organization = await manager.save(manager.create(Organization, { name: dto.name }));
      const passwordHash = await bcrypt.hash(dto.adminPassword, 10);
      await manager.save(
        manager.create(User, {
          email: dto.adminEmail,
          passwordHash,
          role: Role.ORG_ADMIN,
          organizationId: organization.id,
        }),
      );
      return organization;
    });
  }

  async remove(id: string): Promise<void> {
    const organization = await this.findOneOrFail(id);
    await this.organizationsRepository.remove(organization);
  }
}
