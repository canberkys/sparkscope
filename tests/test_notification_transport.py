import json
from types import SimpleNamespace

import httpx
import pytest

from sparkscope import notifications


async def test_webhook_event_id_auth_no_redirect_and_timeout(monkeypatch):
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(302, headers={"Location": "https://different.invalid"})

    original = httpx.AsyncClient

    def client(**kwargs):
        assert kwargs["timeout"] == 10 and kwargs["follow_redirects"] is False and kwargs["trust_env"] is False
        return original(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(notifications.httpx, "AsyncClient", client)
    channel = SimpleNamespace(id="channel", kind="webhook", config={})
    payload = {"event_id": "event-unique", "kind": "alarm.open"}
    with pytest.raises(httpx.HTTPStatusError):
        await notifications.send(channel, {"url": "https://local-test.invalid", "token": "test-token"}, payload)
    assert len(sent) == 1
    assert sent[0].headers["X-SparkScope-Event-ID"] == "event-unique"
    assert sent[0].headers["Authorization"] == "Bearer test-token"
    assert json.loads(sent[0].content) == payload


async def test_email_tls_login_and_stable_message_identity(monkeypatch):
    calls = []

    class SMTP:
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("mail.test", 587, 10)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def starttls(self, context):
            assert context.check_hostname
            calls.append("tls")

        def login(self, username, password):
            assert (username, password) == ("testuser", "testpassword")
            calls.append("login")

        def send_message(self, message):
            calls.append(message)

    monkeypatch.setattr(notifications.smtplib, "SMTP", SMTP)
    channel = SimpleNamespace(
        id="channel",
        kind="email",
        config={
            "host": "mail.test",
            "sender": "sender@test.invalid",
            "recipients": ["recipient@test.invalid"],
            "tls": "starttls",
        },
    )
    await notifications.send(
        channel,
        {"username": "testuser", "password": "testpassword"},
        {"event_id": "event-unique", "kind": "alarm.resolve"},
    )
    assert calls[:2] == ["tls", "login"]
    message = calls[2]
    assert message["Message-ID"] == "<event-unique.channel@sparkscope.local>"
    assert message["To"] == "recipient@test.invalid"
    assert "testpassword" not in str(message)
