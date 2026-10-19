from datetime import UTC, datetime

import pytest

from raffleye.config import Settings
from raffleye.models import Post
from raffleye.storage import Store


@pytest.fixture
def now():
    return datetime(2026, 10, 15, 12, 0, tzinfo=UTC)


@pytest.fixture
def store(tmp_path):
    result = Store(tmp_path / "test.sqlite3")
    yield result
    result.close()


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, db_path=tmp_path / "test.sqlite3")


@pytest.fixture
def post(now):
    return Post(
        id="123",
        author="test_host",
        created_at=now,
        source="mock",
        urls=[],
        text="Giveaway! Enter now\nPrize: keyboard\n2 winners\nTo enter: Follow and tag 2 friends.\nDeadline: 2026-10-16T00:00:00Z",
    )
