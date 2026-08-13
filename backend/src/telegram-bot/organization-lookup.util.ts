import { ILike, Repository } from 'typeorm';
import { Organization } from '../organizations/organization.entity';

// Общий поиск организации по одному введённому значению — пробуем сразу и как ИНН (точное
// совпадение), и как название (без учёта регистра), чтобы пользователю не нужно было
// вводить оба поля подряд (см. TelegramBotService/TelegramPortalService — один и тот же
// матчинг для регистрации через бота и через веб-портал).
export async function findOrganizationByQuery(repository: Repository<Organization>, query: string): Promise<Organization | null> {
  const trimmed = query.trim();
  return (await repository.findOne({ where: { inn: trimmed } })) ?? (await repository.findOne({ where: { name: ILike(trimmed) } }));
}
