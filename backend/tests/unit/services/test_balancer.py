import uuid

import pytest

from app.core.exceptions import NoAvailableServerError
from app.models.server import Server
from app.services.balancer import select_best_server


def make_server(weight: int = 1) -> Server:
    return Server(id=uuid.uuid4(), weight=weight)


def test_picks_minimal_score():
    low = make_server(weight=1)
    high = make_server(weight=1)
    result = select_best_server([(low, 2), (high, 5)])
    assert result is low


def test_weight_influences_score():
    heavy = make_server(weight=10)  # score = 5/10 = 0.5
    light = make_server(weight=1)  # score = 1/1 = 1.0
    result = select_best_server([(heavy, 5), (light, 1)])
    assert result is heavy


def test_tie_breaks_by_smaller_active_count():
    # Обе score равны 1.0 (2/2 и 1/1), должен победить сервер с меньшим active
    a = make_server(weight=2)
    b = make_server(weight=1)
    result = select_best_server([(a, 2), (b, 1)])
    assert result is b


def test_no_candidates_raises():
    with pytest.raises(NoAvailableServerError):
        select_best_server([])


def test_full_tie_returns_one_of_them():
    a = make_server(weight=1)
    b = make_server(weight=1)
    result = select_best_server([(a, 3), (b, 3)])
    assert result in (a, b)
