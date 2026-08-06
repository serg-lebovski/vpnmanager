import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditLogService } from './audit-log.service';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Логин/refresh не проходят сюда вообще — до аутентификации request.user ещё нет, а сам
// факт неудачного логина уже отдельно логируется через Logger в AuthService (см.
// rate-limit/блокировку аккаунта). health — не действие администратора, шумит на каждый
// опрос BackendStatusBanner.
const SKIP_PATH_PREFIXES = ['/auth/', '/health'];

// Экспорт данных (бэкап БД, ключ шифрования) — чувствительные GET-запросы, которые иначе
// прошли бы мимо фильтра "только мутирующие методы" ниже.
const ALWAYS_AUDIT_GET_PATHS = ['/system/backup'];

// Глобальный HTTP-интерцептор вместо ручных вызовов auditLogService.record() в каждом
// сервисе — иначе пришлось бы расставлять их в 20+ местах (servers/peers/bridges/users/
// organizations/system) и неизбежно забыть часть при следующих правках. Ловит POST/PATCH/
// PUT/DELETE на любой защищённый JwtAuthGuard'ом маршрут — заведомо избыточно грубая
// гранулярность (метод+путь+id из params, не "peer.revoke"), но она автоматически
// покрывает и БУДУЩИЕ эндпоинты без отдельной правки этого файла.
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(private readonly auditLogService: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest();
    const method = request.method as string;
    const path: string = request.route?.path ?? request.path ?? request.url;

    if (SKIP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return next.handle();
    }
    const shouldAudit = MUTATING_METHODS.has(method) || (method === 'GET' && ALWAYS_AUDIT_GET_PATHS.some((p) => path.startsWith(p)));
    if (!shouldAudit) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const user = request.user as { userId?: string; email?: string } | undefined;
        void this.auditLogService.record({
          actorUserId: user?.userId ?? null,
          actorEmail: user?.email ?? null,
          method,
          path,
          targetId: typeof request.params?.id === 'string' ? request.params.id : null,
          body: request.body,
          statusCode: response.statusCode,
          ipAddress: request.ip ?? null,
        });
      }),
    );
  }
}
