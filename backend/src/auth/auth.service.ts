import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// После этого числа подряд неудачных попыток — временная блокировка аккаунта. Пороговое
// значение и длительность — компромисс между защитой от перебора и тем, чтобы легитимный
// пользователь, пару раз опечатавшийся, не застревал надолго.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(email: string, password: string, ip?: string): Promise<TokenPair & { user: Omit<User, 'passwordHash'> }> {
    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      // Тот же текст ошибки, что и при неверном пароле — не даём понять по ответу,
      // существует ли такой email вообще (user enumeration).
      this.logger.warn(`Неудачный вход: email "${email}" не найден (ip: ${ip ?? 'неизвестен'})`);
      throw new UnauthorizedException('Неверный email или пароль');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      this.logger.warn(`Вход отклонён — аккаунт "${email}" временно заблокирован ещё на ${minutesLeft} мин (ip: ${ip ?? 'неизвестен'})`);
      throw new UnauthorizedException(`Слишком много неудачных попыток входа — аккаунт временно заблокирован (ещё ~${minutesLeft} мин)`);
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        this.logger.warn(`Аккаунт "${email}" заблокирован на ${LOCKOUT_DURATION_MS / 60000} мин после ${user.failedLoginAttempts} неудачных попыток (ip: ${ip ?? 'неизвестен'})`);
      } else {
        this.logger.warn(`Неудачный вход: неверный пароль для "${email}", попытка ${user.failedLoginAttempts}/${MAX_FAILED_ATTEMPTS} (ip: ${ip ?? 'неизвестен'})`);
      }
      await this.usersRepository.save(user);
      throw new UnauthorizedException('Неверный email или пароль');
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      await this.usersRepository.save(user);
    }

    const tokens = this.issueTokens(user);
    const { passwordHash, ...safeUser } = user;
    return { ...tokens, user: safeUser };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh-токен недействителен или истёк');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Ожидается refresh-токен');
    }
    const user = await this.usersRepository.findOne({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('Пользователь не найден');
    }
    // tv (tokenVersion) в payload должен совпадать с текущим значением у пользователя —
    // не совпадает после смены пароля/"выйти со всех устройств" (см. bumpTokenVersion),
    // тогда все ранее выданные refresh-токены перестают приниматься немедленно, а не ждут
    // естественного истечения JWT_REFRESH_TTL.
    if (payload.tv !== user.tokenVersion) {
      throw new UnauthorizedException('Refresh-токен отозван');
    }
    return this.issueTokens(user);
  }

  private issueTokens(user: User): TokenPair {
    const basePayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      tv: user.tokenVersion,
    };
    const accessToken = this.jwtService.sign(
      { ...basePayload, type: 'access' },
      { expiresIn: this.configService.get<string>('JWT_ACCESS_TTL', '15m') },
    );
    const refreshToken = this.jwtService.sign(
      { ...basePayload, type: 'refresh' },
      { expiresIn: this.configService.get<string>('JWT_REFRESH_TTL', '7d') },
    );
    return { accessToken, refreshToken };
  }
}
