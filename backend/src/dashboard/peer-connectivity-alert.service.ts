import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PeerSource } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { DashboardService } from './dashboard.service';

// Раз в CHECK_INTERVAL_MS проверяет живой снапшот дашборда (см. DashboardService,
// опрашивается там же раз в 7с — здесь дополнительный SSH-запрос не нужен) на peers,
// которые созданы больше GRACE_PERIOD_MS назад, но ни разу не сделали handshake
// (obfuscation/routing/сеть могут не совпасть с сервером — характерный симптом реального
// пойманного вживую инцидента с AmneziaWG 3.0, см. историю коммитов amnezia-config.util.ts:
// peer создаётся, конфиг выдаётся, но клиент физически не может подключиться, и без
// проактивного сигнала это можно узнать только когда клиент сам пожалуется).
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const GRACE_PERIOD_MS = 15 * 60 * 1000;

@Injectable()
export class PeerConnectivityAlertService {
  private readonly logger = new Logger(PeerConnectivityAlertService.name);
  // peerId -> уже отправлено предупреждение — не шлём повторно на каждый тик, пока peer
  // остаётся в том же "ни разу не подключился" состоянии. Чистится, когда peer пропадает
  // из снапшота (отозван/удалён/протокол сейчас недоступен) ИЛИ у него наконец появляется
  // handshake — на случай, если тот же id позже переиспользуется другим реальным peer'ом
  // (пересоздание после revoke) с чистого листа.
  private readonly alertedPeerIds = new Set<string>();

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Interval(CHECK_INTERVAL_MS)
  private async checkNeverConnected(): Promise<void> {
    const snapshot = this.dashboardService.getLastSnapshot();
    if (!snapshot) {
      return;
    }
    const now = Date.now();
    const presentIds = new Set<string>();
    // Сервер офлайн (SSH недоступен) — снапшот вообще не смог получить handshake-данные,
    // latestHandshake==0 в этом случае означает "не удалось узнать", а не "не подключался".
    // Без этой проверки peer, который РАНЬШЕ успешно подключался, ловил бы ложное
    // предупреждение при первой же временной недоступности сервера дольше 15 минут.
    const onlineServerIds = new Set(snapshot.servers.filter((s) => s.online).map((s) => s.serverId));

    for (const peer of snapshot.peers) {
      // Системный upstream-peer моста — не настоящий клиент, ему некому пожаловаться на
      // проблему (см. PeersService/DashboardService — та же граница, что и у трафика).
      if (peer.source === PeerSource.BRIDGE_UPSTREAM) {
        continue;
      }
      presentIds.add(peer.peerId);
      if (!onlineServerIds.has(peer.serverId)) {
        continue;
      }

      if (peer.latestHandshake > 0) {
        // Дождался хендшейка — забываем, если раньше уже алертили (см. комментарий у поля).
        this.alertedPeerIds.delete(peer.peerId);
        continue;
      }

      const ageMs = now - new Date(peer.createdAt).getTime();
      if (ageMs < GRACE_PERIOD_MS || this.alertedPeerIds.has(peer.peerId)) {
        continue;
      }
      this.alertedPeerIds.add(peer.peerId);
      void this.notificationsService.sendMessage(
        `⚠️ Peer «${peer.name}» (${peer.serverName}) создан более ${Math.round(GRACE_PERIOD_MS / 60000)} мин назад, но ни разу не подключился — возможна проблема с конфигом, сетью или обфускацией на клиенте.`,
      );
    }

    for (const peerId of this.alertedPeerIds) {
      if (!presentIds.has(peerId)) {
        this.alertedPeerIds.delete(peerId);
      }
    }
  }
}
