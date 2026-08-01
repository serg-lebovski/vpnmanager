import { Injectable, Logger } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import { SshAuthType } from '../common/enums';

export interface SshConnectionParams {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  secret: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

@Injectable()
export class SshService {
  private readonly logger = new Logger(SshService.name);

  // На части хостинг-провайдеров SSH-демон под нагрузкой (сканирующие боты, ограничение
  // MaxStartups) изредка обрывает соединение ещё до завершения авторизации даже при
  // верных учётных данных — повторная попытка почти всегда проходит. Поэтому подключение
  // ретраится отдельно от самой полезной нагрузки fn (её не имеет смысла повторять при
  // ошибке — она может быть не идемпотентна).
  private async connectWithRetry(params: SshConnectionParams, attempts = 3): Promise<NodeSSH> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host: params.host,
          port: params.port,
          username: params.username,
          password: params.authType === SshAuthType.PASSWORD ? params.secret : undefined,
          privateKey: params.authType === SshAuthType.PRIVATE_KEY ? params.secret : undefined,
          readyTimeout: 15000,
        });
        return ssh;
      } catch (error) {
        lastError = error as Error;
        ssh.dispose();
        if (attempt < attempts) {
          this.logger.warn(`SSH-подключение к ${params.host} не удалось (попытка ${attempt}/${attempts}): ${lastError.message}`);
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    }
    throw lastError;
  }

  async withConnection<T>(params: SshConnectionParams, fn: (ssh: NodeSSH) => Promise<T>): Promise<T> {
    const ssh = await this.connectWithRetry(params);
    try {
      return await fn(ssh);
    } finally {
      ssh.dispose();
    }
  }

  async exec(ssh: NodeSSH, command: string): Promise<ExecResult> {
    this.logger.debug(`exec: ${command}`);
    const result = await ssh.execCommand(command, { execOptions: { pty: false } });
    if (result.code !== 0) {
      this.logger.warn(`Команда завершилась с кодом ${result.code}: ${command}\n${result.stderr}`);
    }
    return result;
  }

  async execOrThrow(ssh: NodeSSH, command: string): Promise<string> {
    const result = await this.exec(ssh, command);
    if (result.code !== 0) {
      throw new Error(`Команда "${command}" завершилась с ошибкой (code ${result.code}): ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }

  async testConnection(params: SshConnectionParams): Promise<{ ok: boolean; info?: string; error?: string }> {
    try {
      const info = await this.withConnection(params, (ssh) => this.execOrThrow(ssh, 'uname -a'));
      return { ok: true, info };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
}
