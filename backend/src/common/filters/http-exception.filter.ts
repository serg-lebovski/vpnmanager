import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : { message: (exception as Error)?.message || 'Внутренняя ошибка сервера' };

    if (!isHttp) {
      this.logger.error((exception as Error)?.stack || exception);
    }

    response.status(status).json(
      typeof body === 'string' ? { message: body, statusCode: status } : { statusCode: status, ...(body as object) },
    );
  }
}
