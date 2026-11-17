"""Durable PostgreSQL, explicit development SQLite, or clearly labelled session memory."""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import json
import sqlite3
from threading import RLock
import time
from urllib.parse import urlsplit, parse_qs, urlencode, urlunsplit

from .models import DEFAULT_SETTINGS, MAX_EVENTS, ValidationError, utc_now


class RevisionConflict(ValidationError):
    pass


class SessionStore:
    mode = "session"
    durable = False

    def __init__(self):
        self.settings = deepcopy(DEFAULT_SETTINGS)
        self.revision = 0
        self.events = {}
        self.last_state = None
        self.lease = None
        self.lock = RLock()

    def read_settings(self):
        with self.lock: return deepcopy(self.settings), self.revision

    def save_settings(self, settings, revision):
        with self.lock:
            if revision != self.revision: raise RevisionConflict("다른 화면에서 설정이 바뀌었어요. 다시 불러온 뒤 저장해 주세요.")
            self.settings, self.revision = deepcopy(settings), self.revision + 1
            return self.revision

    def add_events(self, rows):
        with self.lock:
            inserted = 0
            for row in rows:
                if row["id"] not in self.events: self.events[row["id"]] = deepcopy(row); inserted += 1
            newest = sorted((r for r in self.events.values() if not r["legacy"]), key=lambda r: (r["created_at"], r["id"]), reverse=True)
            for row in newest[MAX_EVENTS:]: self.events.pop(row["id"], None)
            return inserted

    def import_family(self, settings, revision, rows):
        with self.lock:
            if settings is not None and revision != self.revision: raise RevisionConflict("다른 화면에서 설정이 바뀌었어요. 다시 불러온 뒤 저장해 주세요.")
            if settings is not None: self.save_settings(settings, revision)
            return self.add_events(rows)

    def list_events(self, limit=50, offset=0, day="", kind="all"):
        with self.lock:
            rows = sorted(self.events.values(), key=lambda r: (r["created_at"], r["id"]), reverse=True)
            if day:
                from datetime import datetime, timedelta
                rows = [r for r in rows if (datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")) + timedelta(hours=9)).strftime("%Y-%m-%d") == day]
            if kind != "all": rows = [r for r in rows if r["kind"].startswith(kind)]
            return deepcopy(rows[offset:offset + limit]), len(rows)

    def claim(self, owner):
        with self.lock:
            now = time.time()
            if self.lease and self.lease[0] != owner and self.lease[1] > now: return False
            self.lease = (owner, now + 15)
            return True

    def release(self, owner):
        with self.lock:
            if self.lease and self.lease[0] == owner: self.lease = None

    def write_state(self, sample, seen_at, owner):
        with self.lock:
            if not self.lease or self.lease[0] != owner or self.lease[1] <= time.time(): raise ValidationError("USB 연결의 전송 권한이 끝났어요. 다시 연결해 주세요.")
            self.lease = (owner, time.time() + 15)
            old = self.last_state
            if old and old["sample"]["session"] == sample["session"] and old["sample"]["seq"] >= sample["seq"]: return
            self.last_state = {"sample": deepcopy(sample), "last_seen": seen_at}

    def read_state(self):
        with self.lock: return deepcopy(self.last_state)


SCHEMA = [
    "CREATE TABLE IF NOT EXISTS zipon_settings (scope TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS zipon_events (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS zipon_events_time ON zipon_events(scope, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS zipon_state (scope TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS zipon_leases (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL)",
]


class SqlStore:
    def __init__(self, url=None, sqlite_path=None):
        self.postgres = bool(url)
        self.durable = self.postgres
        self.mode = "postgres" if self.postgres else "development"
        self.lock = RLock()
        self.url = None
        if url:
            p = urlsplit(url)
            if p.scheme not in ("postgres", "postgresql") or not p.hostname: raise ValidationError("영구 저장소 연결 주소의 형식을 확인해 주세요.")
            q = parse_qs(p.query, keep_blank_values=True)
            # Hosted connections must use TLS; no insecure silent downgrade.
            if p.hostname not in ("localhost", "127.0.0.1", "::1"):
                modes = q.get("sslmode", ["require"])
                if len(modes) != 1 or modes[0] not in ("require", "verify-ca", "verify-full"): raise ValidationError("외부 저장소는 TLS 보안 연결을 사용해 주세요.")
                q.setdefault("sslmode", ["require"])
            self.url = urlunsplit(("postgresql", p.netloc, p.path, urlencode(q, doseq=True), p.fragment))
        else:
            if not sqlite_path: raise ValueError("explicit development path required")
            self.sqlite_path = str(sqlite_path)
        with self.transaction() as db:
            for statement in SCHEMA: self.execute(db, statement)
            self.execute(db, "INSERT INTO zipon_settings(scope, value, revision, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(scope) DO NOTHING", ("family", json.dumps(DEFAULT_SETTINGS, ensure_ascii=False), utc_now()))

    @contextmanager
    def transaction(self):
        with self.lock:
            if self.postgres:
                import psycopg
                db = psycopg.connect(self.url, connect_timeout=5)
            else:
                db = sqlite3.connect(self.sqlite_path, timeout=5)
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally: db.close()

    def execute(self, db, sql, params=()):
        return db.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    def read_settings(self):
        with self.transaction() as db:
            row = self.execute(db, "SELECT value, revision FROM zipon_settings WHERE scope = ?", ("family",)).fetchone()
            return json.loads(row[0]), row[1]

    def save_settings(self, settings, revision):
        with self.transaction() as db:
            return self._save_settings(db, settings, revision)

    def _save_settings(self, db, settings, revision):
        cur = self.execute(db, "UPDATE zipon_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE scope = ? AND revision = ?", (json.dumps(settings, ensure_ascii=False), utc_now(), "family", revision))
        if cur.rowcount != 1: raise RevisionConflict("다른 화면에서 설정이 바뀌었어요. 다시 불러온 뒤 저장해 주세요.")
        return revision + 1

    def add_events(self, rows):
        with self.transaction() as db:
            return self._add_events(db, rows)

    def _add_events(self, db, rows):
        inserted = 0
        for r in rows:
            cur = self.execute(db, "INSERT INTO zipon_events(id, scope, kind, created_at, value, legacy) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", (r["id"], "family", r["kind"], r["created_at"], json.dumps(r, ensure_ascii=False), int(r["legacy"])))
            inserted += cur.rowcount
        # Only NEW V4 records have a retention cap. Never purge imported history.
        self.execute(db, "DELETE FROM zipon_events WHERE scope = ? AND legacy = 0 AND id NOT IN (SELECT id FROM zipon_events WHERE scope = ? AND legacy = 0 ORDER BY created_at DESC, id DESC LIMIT ?)", ("family", "family", MAX_EVENTS))
        return inserted

    def import_family(self, settings, revision, rows):
        with self.transaction() as db:
            if settings is not None: self._save_settings(db, settings, revision)
            return self._add_events(db, rows)

    def list_events(self, limit=50, offset=0, day="", kind="all"):
        from datetime import datetime, timedelta, timezone
        conditions, params = ["scope = ?"], ["family"]
        if day:
            start = datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=9))).astimezone(timezone.utc)
            conditions += ["created_at >= ?", "created_at < ?"]
            params += [start.isoformat(timespec="milliseconds").replace("+00:00", "Z"), (start + timedelta(days=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")]
        if kind != "all": conditions.append("kind LIKE ?"); params.append(kind + "%")
        where = " AND ".join(conditions)
        with self.transaction() as db:
            count = self.execute(db, "SELECT COUNT(*) FROM zipon_events WHERE " + where, tuple(params)).fetchone()[0]
            rows = self.execute(db, "SELECT value FROM zipon_events WHERE " + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", tuple(params + [limit, offset])).fetchall()
            return [json.loads(r[0]) for r in rows], count

    def _claim(self, db, owner):
        now = time.time()
        cur = self.execute(db, "INSERT INTO zipon_leases(scope, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE zipon_leases.expires_at < ? OR zipon_leases.owner = ?", ("family", owner, now + 15, now, owner))
        return cur.rowcount == 1

    def claim(self, owner):
        with self.transaction() as db: return self._claim(db, owner)

    def release(self, owner):
        with self.transaction() as db: self.execute(db, "DELETE FROM zipon_leases WHERE scope = ? AND owner = ?", ("family", owner))

    def write_state(self, sample, seen_at, owner):
        with self.transaction() as db:
            now = time.time()
            renewed = self.execute(db, "UPDATE zipon_leases SET expires_at = ? WHERE scope = ? AND owner = ? AND expires_at > ?", (now + 15, "family", owner, now))
            if renewed.rowcount != 1: raise ValidationError("USB 연결의 전송 권한이 끝났어요. 다시 연결해 주세요.")
            row = self.execute(db, "SELECT value FROM zipon_state WHERE scope = ?", ("family",)).fetchone()
            if row:
                old = json.loads(row[0])["sample"]
                if old["session"] == sample["session"] and old["seq"] >= sample["seq"]: return
            value = json.dumps({"sample": sample, "last_seen": seen_at}, ensure_ascii=False)
            self.execute(db, "INSERT INTO zipon_state(scope, value) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value", ("family", value))

    def read_state(self):
        with self.transaction() as db:
            row = self.execute(db, "SELECT value FROM zipon_state WHERE scope = ?", ("family",)).fetchone()
            return json.loads(row[0]) if row else None
