import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Organization } from './organization.entity';

@Injectable()
export class OrganizationsService {
  constructor(@InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>) {}

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

  // Организация создаётся сама по себе, без пользователя — администраторов/пользователей
  // для неё создают отдельно на вкладке «Пользователи» (суперадмин указывает организацию
  // явно, org_admin, создавая org_user, привязывает его к своей же организации автоматически
  // — см. UsersService.createForRequester).
  async create(dto: CreateOrganizationDto): Promise<Organization> {
    const existingOrg = await this.organizationsRepository.findOne({ where: { name: dto.name } });
    if (existingOrg) {
      throw new ConflictException('Организация с таким именем уже существует');
    }
    if (dto.inn) {
      const existingInn = await this.organizationsRepository.findOne({ where: { inn: dto.inn } });
      if (existingInn) {
        throw new ConflictException('Организация с таким ИНН уже существует');
      }
    }
    return this.organizationsRepository.save(this.organizationsRepository.create({ name: dto.name, inn: dto.inn ?? null }));
  }

  async update(id: string, dto: UpdateOrganizationDto): Promise<Organization> {
    const organization = await this.findOneOrFail(id);
    if (dto.name !== undefined && dto.name !== organization.name) {
      const existing = await this.organizationsRepository.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new ConflictException('Организация с таким именем уже существует');
      }
      organization.name = dto.name;
    }
    if (dto.inn !== undefined && dto.inn !== organization.inn) {
      const existingInn = await this.organizationsRepository.findOne({ where: { inn: dto.inn } });
      if (existingInn) {
        throw new ConflictException('Организация с таким ИНН уже существует');
      }
      organization.inn = dto.inn;
    }
    if (dto.allowedServerIds !== undefined) {
      organization.allowedServerIds = dto.allowedServerIds;
    }
    if (dto.blockedBridgeIds !== undefined) {
      organization.blockedBridgeIds = dto.blockedBridgeIds;
    }
    return this.organizationsRepository.save(organization);
  }

  async remove(id: string): Promise<void> {
    const organization = await this.findOneOrFail(id);
    await this.organizationsRepository.remove(organization);
  }
}
