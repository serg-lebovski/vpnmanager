"""Провайдер plain WireGuard: как amnezia_wg, но без обфускации и с бинарём wg/wg-quick."""

import uuid
from datetime import UTC, datetime

from app.providers.base import (
    PeerResult,
    PeerSpec,
    PeerStat,
    ProviderError,
    ProviderUnreachable,
    VPNProvider,
)
from app.providers.ssh_utils import SSHClient, SSHCredentials
from app.providers.wg_utils import (
    generate_keypair,
    generate_preshared_key,
    next_free_ip,
    render_client_config,
)


class WireGuardProvider(VPNProvider):
    provider_type = "wireguard"

    def __init__(
        self,
        creds: SSHCredentials,
        *,
        wg_interface: str,
        server_public_key: str,
        subnet: str,
        endpoint: str,
        wg_port: int,
        ssh_client: SSHClient | None = None,
    ) -> None:
        self._ssh = ssh_client or SSHClient(creds)
        self.wg_interface = wg_interface
        self.server_public_key = server_public_key
        self.subnet = subnet
        self.endpoint = endpoint
        self.wg_port = wg_port

    async def health_check(self) -> bool:
        try:
            result = await self._ssh.run_simple(["wg", "show", self.wg_interface])
            return result.ok
        except ProviderUnreachable:
            return False

    async def create_peer(self, spec: PeerSpec, used_ips: set[str] | None = None) -> PeerResult:
        private_key, public_key = generate_keypair()
        preshared_key = generate_preshared_key()
        vpn_ip = next_free_ip(self.subnet, used_ips or set())

        psk_path = f"/tmp/psk_{uuid.uuid4().hex}"
        async with self._ssh.connect() as conn:
            await conn.run(f"umask 077 && cat > {psk_path}", input=preshared_key, check=True)
            try:
                add_cmd = (
                    f"wg set {self.wg_interface} peer {public_key} "
                    f"preshared-key {psk_path} allowed-ips {vpn_ip}/32"
                )
                add_result = await conn.run(add_cmd, check=False)
                if add_result.exit_status != 0:
                    raise ProviderError(f"wg set peer failed: {add_result.stderr}")
                await conn.run(f"wg-quick save {self.wg_interface}", check=False)
            finally:
                await conn.run(f"rm -f {psk_path}", check=False)

        config_text = render_client_config(
            private_key=private_key,
            address=vpn_ip,
            dns="1.1.1.1",
            server_public_key=self.server_public_key,
            preshared_key=preshared_key,
            endpoint=self.endpoint,
            endpoint_port=self.wg_port,
            obfuscation=None,
        )
        return PeerResult(
            peer_id=public_key,
            vpn_ip=vpn_ip,
            config_text=config_text,
            qr_payload=config_text,
            private_key=private_key,
        )

    async def delete_peer(self, peer_id: str) -> None:
        async with self._ssh.connect() as conn:
            await conn.run(f"wg set {self.wg_interface} peer {peer_id} remove", check=False)
            await conn.run(f"wg-quick save {self.wg_interface}", check=False)

    async def list_peers(self) -> list[PeerStat]:
        return await self.get_stats()

    async def get_stats(self) -> list[PeerStat]:
        result = await self._ssh.run_simple(["wg", "show", self.wg_interface, "dump"])
        if not result.ok:
            return []
        stats = []
        lines = result.stdout.strip().splitlines()
        for line in lines[1:]:
            fields = line.split("\t")
            if len(fields) < 8:
                continue
            latest_handshake = int(fields[4]) if fields[4].isdigit() else 0
            rx_bytes = int(fields[5]) if fields[5].isdigit() else 0
            tx_bytes = int(fields[6]) if fields[6].isdigit() else 0
            stats.append(
                PeerStat(
                    peer_id=fields[0],
                    last_handshake=(
                        datetime.fromtimestamp(latest_handshake, tz=UTC)
                        if latest_handshake > 0
                        else None
                    ),
                    rx_bytes=rx_bytes,
                    tx_bytes=tx_bytes,
                )
            )
        return stats

    async def rotate_keys(self) -> None:
        private_key, public_key = generate_keypair()
        psk_path = f"/tmp/rotate_{uuid.uuid4().hex}"
        async with self._ssh.connect() as conn:
            await conn.run(f"umask 077 && cat > {psk_path}", input=private_key, check=True)
            try:
                cmd = f"cat {psk_path} | wg set {self.wg_interface} private-key /dev/stdin"
                result = await conn.run(cmd, check=False)
                if result.exit_status != 0:
                    raise ProviderError(f"key rotation failed: {result.stderr}")
                await conn.run(f"wg-quick save {self.wg_interface}", check=False)
            finally:
                await conn.run(f"rm -f {psk_path}", check=False)
        self.server_public_key = public_key
