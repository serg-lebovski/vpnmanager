import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { Role } from '../common/enums';
import { User } from '../users/user.entity';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const existingCount = await this.usersRepository.count();
    if (existingCount > 0) {
      return;
    }

    const email = this.configService.get<string>('SEED_ADMIN_EMAIL', 'admin@example.com');
    const password = this.configService.get<string>('SEED_ADMIN_PASSWORD', 'ChangeMe123!');

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = this.usersRepository.create({
      email,
      passwordHash,
      role: Role.SUPER_ADMIN,
      organizationId: null,
    });
    await this.usersRepository.save(admin);
    this.logger.warn(`Создан суперадмин ${email}. Смените пароль после первого входа.`);
  }
}
