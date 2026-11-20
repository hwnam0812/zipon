"""Slow/failing storage checks: no real family credentials, records or network."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from unittest.mock import MagicMock, patch
import time
import types
import unittest

from zipon_streamlit.screen import ScreenSession, open_service
from zipon_streamlit.service import FamilyService
from zipon_streamlit.storage import SessionStore, SqlStore


class ScreenTests(unittest.TestCase):
    def setUp(self):
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.now = 0
        self.service = FamilyService(SessionStore(), "isolated-owner")
        self.screen = ScreenSession(lambda: (self.service, self.service.snapshot(), ""), executor=self.executor, clock=lambda: self.now)
        self.screen.future.result(timeout=2)
        self.screen.poll()

    def tearDown(self): self.executor.shutdown(wait=True)

    def test_slow_load_does_not_block_screen(self):
        release = Event()
        def load():
            release.wait(timeout=2)
            return self.service, self.service.snapshot(), ""
        screen = ScreenSession(load, executor=self.executor)
        try:
            start = time.monotonic()
            for _ in range(100): self.assertIsNone(screen.poll())
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 0.1)
            print(f"측정 · 대기 중 화면 확인 100회 {elapsed * 1000:.2f}ms")
        finally: release.set(); screen.future.result(timeout=2)

    def test_failed_refresh_keeps_last_data_and_time(self):
        before = self.screen.poll()
        self.now = 4
        with patch.object(self.service, "snapshot", side_effect=RuntimeError("private-driver-detail")):
            self.screen.poll()
            try: self.screen.future.result(timeout=2)
            except RuntimeError: pass
            after = self.screen.poll()
        self.assertEqual(after["serverTime"], before["serverTime"])
        self.assertEqual(after["settings"], before["settings"])
        self.assertIn("저장 연결", after["storageError"])
        self.assertNotIn("private-driver-detail", str(after))

    def test_request_once_and_no_flood_of_jobs(self):
        request = {"id": "isolated-once", "op": "settings", "payload": {"settings": self.service.store.read_settings()[0], "revision": 0}}
        for _ in range(20): self.screen.enqueue(request)
        self.screen.poll(); self.screen.future.result(timeout=2)
        self.screen.poll()
        for _ in range(20): self.screen.enqueue(request); self.screen.poll()
        self.assertEqual(self.service.store.read_settings()[1], 1)
        self.assertEqual(self.screen.reply["id"], request["id"])
        self.assertIsNone(self.screen.queued)

    def test_unrelated_or_failed_request_does_not_clear_storage_failure(self):
        self.screen.error = "저장 연결 실패"
        for number, response in enumerate(({"ok": True, "result": {}}, {"ok": False, "error": "잘못된 입력"})):
            request = {"id": f"isolated-failure-{number}", "op": "inspect_import", "payload": {}}
            self.screen.enqueue(request)
            with patch.object(self.service, "handle", return_value={"id": request["id"], **response}):
                self.screen.poll(); self.screen.future.result(timeout=2)
                self.assertEqual(self.screen.poll()["storageError"], "저장 연결 실패")
        self.now = 4
        self.screen.poll(); self.screen.future.result(timeout=2)
        self.assertEqual(self.screen.poll()["storageError"], "")

    def test_queue_delay_is_included_in_sample_age(self):
        request = {"id": "isolated-age", "op": "sync", "payload": {"sample": {"test": True}, "sampleAgeMs": 200}}
        self.screen.enqueue(request); self.now = 2
        with patch.object(self.service, "handle", return_value={"ok": False}) as handle:
            self.screen.poll(); self.screen.future.result(timeout=2)
            self.assertEqual(handle.call_args.args[0]["payload"]["sampleAgeMs"], 2200)
        self.assertEqual(request["payload"]["sampleAgeMs"], 200)

    def test_failed_initial_connection_never_falls_back_to_memory(self):
        with patch("zipon_streamlit.screen.SqlStore", side_effect=RuntimeError("private-url")):
            with self.assertRaises(RuntimeError) as error:
                open_service("isolated-invalid", "", "owner")
        self.assertIn("제어를 시작하지", str(error.exception))
        self.assertNotIn("private-url", str(error.exception))

    def test_missing_connection_never_opens_family_controls(self):
        with self.assertRaises(RuntimeError): open_service("", "", "owner")

    def test_supabase_connection_is_selected_without_bad_database_url(self):
        with patch("zipon_streamlit.screen.SupabaseStore", return_value=self.service.store) as store:
            service, data, warning = open_service("isolated-invalid", "", "owner", supabase_key="isolated-key")
        store.assert_called_once()
        self.assertEqual(warning, "")


class PostgresConnectionTests(unittest.TestCase):
    def fake_connection(self):
        db = MagicMock()
        db.closed = db.broken = False
        return db

    def test_connection_reuse_timeouts_and_row_security(self):
        db = self.fake_connection()
        connect = MagicMock(return_value=db)
        with patch.dict("sys.modules", {"psycopg": types.SimpleNamespace(connect=connect)}):
            store = SqlStore(url="postgresql://example.invalid/isolated")
            for _ in range(3):
                with store.transaction() as acquired: self.assertIs(acquired, db)
        self.assertEqual(connect.call_count, 1)
        self.assertIsNone(connect.call_args.kwargs["prepare_threshold"])
        self.assertIn("statement_timeout=3000", connect.call_args.kwargs["options"])
        statements = [call.args[0] for call in db.execute.call_args_list]
        for name in ("settings", "events", "state", "leases"):
            self.assertIn(f"ALTER TABLE zipon_{name} ENABLE ROW LEVEL SECURITY", statements)

    def test_unknown_write_is_not_replayed(self):
        db, other = self.fake_connection(), self.fake_connection()
        connect = MagicMock(side_effect=[db, other])
        with patch.dict("sys.modules", {"psycopg": types.SimpleNamespace(connect=connect)}):
            store = SqlStore(url="postgresql://example.invalid/isolated")
            with self.assertRaises(RuntimeError):
                with store.transaction(): raise RuntimeError("unknown outcome")
            self.assertEqual(connect.call_count, 1)
            db.close.assert_called_once()
            with store.transaction() as acquired: self.assertIs(acquired, other)
        self.assertEqual(connect.call_count, 2)

    def test_snapshot_uses_one_transaction(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        with TemporaryDirectory() as folder:
            store = SqlStore(sqlite_path=str(Path(folder) / "isolated.sqlite"))
            with patch.object(store, "transaction", wraps=store.transaction) as transaction:
                data = FamilyService(store, "owner").snapshot()
            self.assertEqual(transaction.call_count, 1)
            self.assertEqual(data["eventTotal"], 0)


if __name__ == "__main__": unittest.main()
