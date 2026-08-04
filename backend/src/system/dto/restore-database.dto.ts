import { Equals } from 'class-validator';

// Восстановление необратимо стирает текущую БД — фраза-подтверждение проверяется на
// сервере (не только диалогом на фронте) как defense-in-depth для максимально
// разрушительного эндпоинта.
export const RESTORE_CONFIRMATION_PHRASE = 'ВОССТАНОВИТЬ';

export class RestoreDatabaseDto {
  @Equals(RESTORE_CONFIRMATION_PHRASE)
  confirmationPhrase: string;
}
