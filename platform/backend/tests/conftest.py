import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import demo  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.ai import AIService  # noqa: E402
from app.services.cache import MemoryCache  # noqa: E402


class CountingTransport(httpx.MockTransport):
    def __init__(self):
        self.urls: list[str] = []
        inner = demo.mock_transport()

        def handler(req):
            self.urls.append(str(req.url))
            return inner.handle_request(req)
        super().__init__(handler)


@pytest.fixture
def settings():
    s = Settings()
    s.database_url = "sqlite://"
    s.per_host_interval_s = 0
    s.hunter_api_key = ""
    s.ai_provider = "none"
    return s


@pytest.fixture
def transport():
    return CountingTransport()


@pytest.fixture
def client(settings, transport):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    app = create_app(settings, engine=engine, http_client=httpx.AsyncClient(transport=transport),
                     resolver=demo.DemoResolver(), search=demo.DemoSearch(), ai=AIService(None, MemoryCache()))
    with TestClient(app) as c:
        yield c
