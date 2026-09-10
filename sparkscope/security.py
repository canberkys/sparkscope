import hashlib
import json
import os
import secrets
import stat
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet, MultiFernet

hasher = PasswordHasher()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def token():
    return secrets.token_urlsafe(32)


def verify_password(value, encoded):
    try:
        return hasher.verify(encoded, value)
    except (VerificationError, InvalidHashError):
        return False


def private_file(path, content=None):
    if not path.exists():
        if content is None:
            raise RuntimeError("Secret file is missing")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise RuntimeError(f"Secret file permissions must be 0600: {path}")
    return path.read_text().strip()


class Vault:
    def __init__(self, path):
        raw = private_file(path, Fernet.generate_key().decode())
        self.fernet = MultiFernet([Fernet(key.strip()) for key in raw.splitlines() if key.strip()])

    def seal(self, data):
        return self.fernet.encrypt(json.dumps(data).encode()).decode()

    def open(self, data):
        return json.loads(self.fernet.decrypt(data.encode())) if data else {}

    def rotate(self, data):
        return self.fernet.rotate(data.encode()).decode() if data else ""


class RateLimit:
    def __init__(self):
        self.hits = defaultdict(deque)

    def allow(self, key, limit=10, seconds=60):
        now = time.monotonic()
        queue = self.hits[key]
        while queue and queue[0] < now - seconds:
            queue.popleft()
        if len(queue) >= limit:
            return False
        queue.append(now)
        if len(self.hits) > 10000:
            self.hits = defaultdict(deque, {k: v for k, v in self.hits.items() if v and v[-1] > now - seconds})
        return True
