import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Находит ID запущенного контейнера ПО ИМЕНИ COMPOSE-СЕРВИСА (не по compose-имени
// контейнера, которое зависит от project name) — у любого compose-managed контейнера
// автоматически есть этот label, поэтому не нужно знать точное имя проекта/контейнера.
async function resolveContainerIdByComposeService(serviceName: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.service=${serviceName}`,
    '--format',
    '{{.ID}}',
  ]);
  const id = stdout.trim().split('\n')[0];
  if (!id) {
    throw new Error(`Не найден запущенный контейнер для compose-сервиса "${serviceName}"`);
  }
  return id;
}

// Перезагружает конфиг nginx через docker exec (а НЕ через sibling-container/DooD-паттерн
// update.service.ts — это не self-recreation, backend не пересоздаёт сам себя, здесь
// обычный docker exec из собственного процесса backend — правильный и более простой
// инструмент). Сначала `nginx -t` — если новый конфиг битый, nginx откажется релоадиться
// и продолжит работать со старым, но явная проверка перед reload — дополнительный слой
// безопасности, а не просто расчёт на штатное поведение nginx.
export async function reloadNginx(): Promise<void> {
  const containerId = await resolveContainerIdByComposeService('nginx');
  await execFileAsync('docker', ['exec', containerId, 'nginx', '-t']);
  await execFileAsync('docker', ['exec', containerId, 'nginx', '-s', 'reload']);
}
