import { Repository } from 'typeorm';
import { AuditLogEntry } from './audit-log-entry.entity';
import { AuditLogService, RecordAuditLogInput } from './audit-log.service';

function makeInput(overrides: Partial<RecordAuditLogInput> = {}): RecordAuditLogInput {
  return {
    actorUserId: 'user-1',
    actorEmail: 'admin@example.com',
    method: 'PATCH',
    path: '/servers/1',
    targetId: '1',
    body: {},
    statusCode: 200,
    ipAddress: '127.0.0.1',
    ...overrides,
  };
}

describe('AuditLogService', () => {
  let repository: { create: jest.Mock; save: jest.Mock };
  let service: AuditLogService;

  beforeEach(() => {
    repository = {
      create: jest.fn((entity) => entity as AuditLogEntry),
      save: jest.fn().mockResolvedValue(undefined),
    };
    service = new AuditLogService(repository as unknown as Repository<AuditLogEntry>);
  });

  it('redacts sensitive top-level keys before saving', async () => {
    await service.record(makeInput({ body: { username: 'bob', password: 'hunter2' } }));

    const saved = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect((saved.body as Record<string, unknown>).password).toBe('[скрыто]');
    expect((saved.body as Record<string, unknown>).username).toBe('bob');
  });

  it('redacts sensitive keys nested inside objects and arrays', async () => {
    await service.record(
      makeInput({
        body: { servers: [{ name: 'vps-1', secret: 'ssh-pass' }, { name: 'vps-2', privateKey: 'wg-priv' }] },
      }),
    );

    const saved = repository.create.mock.calls[0][0] as Record<string, unknown>;
    const servers = (saved.body as Record<string, unknown>).servers as Record<string, unknown>[];
    expect(servers[0].secret).toBe('[скрыто]');
    expect(servers[0].name).toBe('vps-1');
    expect(servers[1].privateKey).toBe('[скрыто]');
  });

  it('stores null body when the request body is empty', async () => {
    await service.record(makeInput({ body: {} }));

    const saved = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.body).toBeNull();
  });

  it('does not throw when the repository save fails (best-effort logging)', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));
    await expect(service.record(makeInput())).resolves.toBeUndefined();
  });
});
