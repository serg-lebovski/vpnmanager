import { Controller, Get } from '@nestjs/common';

// Без guard'ов — намеренно публичный, используется фронтендом для индикатора
// "backend недоступен" (например, во время самообновления), когда у клиента может не
// быть валидного токена или сам логин ещё не пройден.
@Controller()
export class AppController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
