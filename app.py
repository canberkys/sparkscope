"""Compatibility entry point: uvicorn app:app --host 127.0.0.1 --port 8010."""

from sparkscope.api import create_app

app = create_app()
