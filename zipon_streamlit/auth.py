"""Server-only family password checks; no password in browser component data."""
from __future__ import annotations
from collections import OrderedDict
import hashlib
import hmac
from threading import Lock
import time


def proof(secret, session_id):
    return hmac.new(secret.encode("utf-8"), ("zipon-family:" + session_id).encode(), hashlib.sha256).hexdigest()


def password_matches(candidate, secret):
    return isinstance(candidate, str) and bool(secret) and hmac.compare_digest(candidate.encode("utf-8"), secret.encode("utf-8"))


class AttemptLimiter:
    """Bounded, per-process IP cooldown. Not a replacement for an identity provider."""
    def __init__(self): self.attempts, self.lock = OrderedDict(), Lock()

    def allowed(self, key):
        with self.lock:
            now = time.monotonic()
            values = [t for t in self.attempts.get(key, []) if now - t < 60]
            self.attempts[key] = values
            self.attempts.move_to_end(key)
            while len(self.attempts) > 2048: self.attempts.popitem(last=False)
            return len(values) < 5

    def fail(self, key):
        with self.lock: self.attempts.setdefault(key, []).append(time.monotonic())
