import random

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NoAvailableServerError
from app.models.server import Server
from app.repositories.servers import ServerRepository


class Balancer:
    """Выбирает сервер организации под новый конфиг (раздел 8.2)."""

    def __init__(self, session: AsyncSession) -> None:
        self.servers = ServerRepository(session)

    async def pick_server(self, candidate_servers: list[Server]) -> Server:
        eligible: list[tuple[Server, int]] = []
        for server in candidate_servers:
            if server.status != "ONLINE" or not server.is_active:
                continue
            active = await self.servers.active_configs_count(server.id)
            if server.max_peers is not None and active >= server.max_peers:
                continue
            eligible.append((server, active))
        return select_best_server(eligible)


def select_best_server(eligible: list[tuple[Server, int]]) -> Server:
    """Чистая функция выбора: score = active/weight, минимальный score,
    при равенстве — меньший active, затем случайный (раздел 8.2)."""
    if not eligible:
        raise NoAvailableServerError("No server available for this organization")

    min_score = min(active / server.weight for server, active in eligible)
    best = [
        (server, active) for server, active in eligible if active / server.weight == min_score
    ]
    min_active = min(active for _, active in best)
    best = [(server, active) for server, active in best if active == min_active]
    return random.choice(best)[0]
