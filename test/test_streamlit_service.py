"""Isolated tests only: no family secrets, preview rows or real USB devices."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile
from io import BytesIO

from zipon_streamlit.auth import AttemptLimiter, password_matches, proof
from zipon_streamlit.models import DEFAULT_SETTINGS, ValidationError, parse_import, validate_event, validate_sample, validate_settings
from zipon_streamlit.service import FamilyService, hardware_zip
from zipon_streamlit.storage import RevisionConflict, SessionStore, SqlStore


def sample(**changes):
    return {"type": "telemetry", "protocol": "ZIPON_USB_V4", "session": "a" * 16, "seq": 1, "uptimeMs": 1000,
            "gasRaw": 120, "distanceCm": 12, "gasState": "disabled", "gasAlarm": False, "intrusionAlarm": False,
            "led": False, "buzzer": False, "manualLed": False, "manualBuzzer": False,
            "ledSource": "off", "buzzerSource": "off", "config": 0, **changes}


def event(index=0, **changes):
    when = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=index)
    return validate_event({"id": f"isolated-{index}", "kind": "door_open", "created_at": when.isoformat(),
                           "gas_raw": 120, "distance_cm": 25, "led": False, "buzzer": False, "detail": "격리 검사 자료", **changes})


class ValidationTests(unittest.TestCase):
    def test_unicode_password_and_rotation(self):
        key = "격리-검사-비밀번호-" + uuid4().hex
        self.assertTrue(password_matches(key, key))
        self.assertFalse(password_matches(key + " ", key))
        self.assertFalse(password_matches("", ""))
        self.assertNotEqual(proof(key, "one"), proof(key, "two"))
        self.assertNotEqual(proof(key, "one"), proof(key + "changed", "one"))

    def test_rate_limit_five_then_recovers(self):
        limits = AttemptLimiter()
        with patch("zipon_streamlit.auth.time.monotonic", return_value=100):
            for _ in range(5): self.assertTrue(limits.allowed("isolated")); limits.fail("isolated")
            self.assertFalse(limits.allowed("isolated"))
            self.assertTrue(limits.allowed("other"))
        with patch("zipon_streamlit.auth.time.monotonic", return_value=161): self.assertTrue(limits.allowed("isolated"))

    def test_default_and_whitelist(self):
        s = deepcopy(DEFAULT_SETTINGS); s["password"] = "not-a-real-secret"
        self.assertEqual(validate_settings(s), DEFAULT_SETTINGS)
        self.assertFalse(validate_settings(s)["gas"]["warmupConfirmed"])

    def test_numeric_ranges_and_booleans(self):
        for field, value in [("holdSeconds", True), ("holdSeconds", 4), ("holdSeconds", 61), ("baseline", 0), ("threshold", 1023), ("recovery", float("nan"))]:
            with self.subTest(field=field, value=value):
                s = deepcopy(DEFAULT_SETTINGS); s["gas"][field] = value
                with self.assertRaises(ValidationError): validate_settings(s)

    def test_closed_baseline_confirmation_is_explicit_and_legacy_safe(self):
        s = deepcopy(DEFAULT_SETTINGS)
        del s["intrusion"]["baselineConfirmed"]
        normalized = validate_settings(s)
        self.assertFalse(normalized["intrusion"]["baselineConfirmed"])
        self.assertEqual(normalized["intrusion"]["baselineCm"], s["intrusion"]["baselineCm"])
        for value in [True, False]:
            s["intrusion"]["baselineConfirmed"] = value
            self.assertEqual(validate_settings(s)["intrusion"]["baselineConfirmed"], value)
        for value in [1, None, "true"]:
            s["intrusion"]["baselineConfirmed"] = value
            with self.assertRaises(ValidationError): validate_settings(s)

    def test_threshold_order(self):
        for baseline, recovery, threshold in [(300, 250, 400), (200, 400, 400), (400, 400, 300)]:
            s = deepcopy(DEFAULT_SETTINGS); s["gas"].update(baseline=baseline, recovery=recovery, threshold=threshold)
            with self.assertRaises(ValidationError): validate_settings(s)

    def test_window_times_days_and_limits(self):
        for changes in [{"days": []}, {"days": [True]}, {"days": [7]}, {"start": "24:00"}, {"end": "22:00"}, {"enabled": 1}]:
            s = deepcopy(DEFAULT_SETTINGS); s["quietWindows"][0].update(changes)
            with self.assertRaises(ValidationError): validate_settings(s)
        s = deepcopy(DEFAULT_SETTINGS); s["quietWindows"] *= 2
        with self.assertRaises(ValidationError): validate_settings(s)
        s["quietWindows"] = [{**DEFAULT_SETTINGS["quietWindows"][0], "id": f"w-{n}"} for n in range(21)]
        with self.assertRaises(ValidationError): validate_settings(s)

    def test_frame_schema_and_output_consistency(self):
        self.assertEqual(validate_sample(sample()), sample())
        for changes in [{"gasRaw": "120"}, {"gasRaw": True}, {"distanceCm": 0}, {"distanceCm": float("inf")}, {"seq": 0}, {"protocol": "ZIPON_AUTO_V3"}, {"session": "z" * 16}, {"led": True}, {"manualLed": True}, {"buzzerSource": "gas"}, {"gasState": "alert"}, {"intrusionAlarm": True}]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError): validate_sample(sample(**changes))
        self.assertIsNone(validate_sample(sample(gasRaw=None, distanceCm=None))["gasRaw"])
        self.assertTrue(validate_sample(sample(gasRaw=0, gasState="fault", gasAlarm=True, led=True, buzzer=True, ledSource="gas", buzzerSource="gas"))["gasAlarm"])

    def test_event_dates_text_and_title(self):
        self.assertTrue(event()["created_at"].endswith("Z"))
        for changes in [{"created_at": "2026-01-01"}, {"created_at": "not-a-date"}, {"kind": "unknown"}, {"gas_raw": 1024}, {"led": 1}, {"detail": "x" * 1001}, {"id": "<script>"}]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError): event(**changes)
        old = validate_event({**event(), "title": "기존 원시 출력 변화"}, legacy=True)
        self.assertEqual(old["title"], "기존 원시 출력 변화")

    def test_legacy_import_scope_settings_and_no_credentials(self):
        old = deepcopy(DEFAULT_SETTINGS["quietWindows"])
        data = {"home_settings": [{"scope": "family", "value": json.dumps({"homeName": "격리 검사 집", "quietWindows": old, "closedDistance": 15, "doorConfirmSeconds": 3, "gasBaselineAdc": 100, "gasRiseAdc": 100, "gasSustainedSeconds": 15})}],
                "home_events": [{**event(), "scope": "family", "title": "이전 거리 변화"}, {**event(1), "scope": "other"}],
                "home_devices": [{"token": "excluded-test-value"}]}
        s, rows = parse_import(data)
        self.assertEqual(s["homeName"], "격리 검사 집")
        self.assertEqual(s["quietWindows"], old)
        self.assertEqual(s["gas"]["threshold"], 200)
        self.assertEqual(s["gas"]["holdSeconds"], 15)
        self.assertFalse(s["intrusion"]["enabled"])
        self.assertFalse(s["gas"]["warmupConfirmed"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "이전 거리 변화")
        self.assertNotIn("excluded-test-value", json.dumps([s, rows]))

    def test_invalid_import_is_all_or_nothing(self):
        for data in [{}, {"format": "zipon-family-v4", "events": [event(), {"id": "bad"}]}, {"format": "zipon-family-v4", "events": [event()] * 5001}, {"format": "zipon-family-v4", "events": [], "padding": "x" * 2_000_001}]:
            with self.assertRaises(ValidationError): parse_import(data)


class StoreContract:
    def test_settings_conflict_preserves_previous(self):
        s, revision = self.store.read_settings(); s["homeName"] = "격리 변경"
        self.assertEqual(self.store.save_settings(s, revision), 1)
        with self.assertRaises(RevisionConflict): self.store.save_settings(DEFAULT_SETTINGS, revision)
        self.assertEqual(self.store.read_settings()[0]["homeName"], "격리 변경")

    def test_duplicate_record_does_not_overwrite(self):
        first = event(); self.assertEqual(self.store.add_events([first]), 1)
        self.assertEqual(self.store.add_events([{**first, "detail": "바꾸지 않음"}]), 0)
        self.assertEqual(self.store.list_events()[0][0]["detail"], first["detail"])

    def test_event_retention_preserves_imported_history(self):
        old = {**event(-100), "legacy": True}
        self.store.add_events([old] + [event(n) for n in range(2003)])
        rows, total = self.store.list_events(5000)
        self.assertEqual(total, 2001)
        self.assertEqual(rows[-1]["id"], old["id"])
        self.assertNotIn("isolated-0", [r["id"] for r in rows])

    def test_korea_date_filter_and_pagination(self):
        self.store.add_events([event(n, created_at=(datetime(2026, 1, 1, 14, 59, 50, tzinfo=timezone.utc) + timedelta(seconds=n)).isoformat(), kind="gas_alert" if n % 2 else "door_open") for n in range(60)])
        rows, total = self.store.list_events(50)
        self.assertEqual((len(rows), total), (50, 60))
        self.assertEqual(len(self.store.list_events(50, 50)[0]), 10)
        self.assertEqual(self.store.list_events(50, day="2026-01-02")[1], 50)
        self.assertEqual(self.store.list_events(50, day="2026-01-02", kind="gas")[1], 25)

    def test_lease_ownership_sequence_and_expiry(self):
        with patch("zipon_streamlit.storage.time.time", return_value=100):
            self.assertTrue(self.store.claim("first"))
            self.assertFalse(self.store.claim("second"))
            self.store.write_state(sample(seq=2), "2026-01-01T00:00:00.000Z", "first")
            self.store.write_state(sample(seq=1, gasRaw=999), "2026-01-01T00:00:01.000Z", "first")
            self.assertEqual(self.store.read_state()["sample"]["gasRaw"], 120)
            self.store.release("second")
            self.assertFalse(self.store.claim("second"))
        with patch("zipon_streamlit.storage.time.time", return_value=116):
            with self.assertRaises(ValidationError): self.store.write_state(sample(seq=3), "2026-01-01T00:00:02.000Z", "first")
            self.assertTrue(self.store.claim("second"))
            with self.assertRaises(ValidationError): self.store.write_state(sample(seq=4), "2026-01-01T00:00:03.000Z", "first")
            self.store.release("second")
            self.assertTrue(self.store.claim("third"))

    def test_import_conflict_changes_nothing(self):
        self.store.save_settings(DEFAULT_SETTINGS, 0)
        with self.assertRaises(RevisionConflict): self.store.import_family({**DEFAULT_SETTINGS, "homeName": "덮지 않음"}, 0, [event()])
        self.assertEqual(self.store.list_events()[1], 0)
        self.assertEqual(self.store.read_settings()[0]["homeName"], "우리 집")


class MemoryTests(StoreContract, unittest.TestCase):
    def setUp(self): self.store = SessionStore()

    def test_no_claim_means_no_state(self):
        with self.assertRaises(ValidationError): self.store.write_state(sample(), "2026-01-01T00:00:00Z", "unclaimed")
        self.assertIsNone(self.store.read_state())
        self.assertFalse(self.store.durable)


class SqliteTests(StoreContract, unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="zipon-isolated-")
        self.path = str(Path(self.temp.name) / "test.sqlite")
        self.store = SqlStore(sqlite_path=self.path)

    def tearDown(self): self.temp.cleanup()

    def test_reads_back_in_another_store(self):
        self.store.add_events([event()]); self.store.save_settings({**DEFAULT_SETTINGS, "homeName": "다른 접속 검사"}, 0)
        another = SqlStore(sqlite_path=self.path)
        self.assertEqual(another.read_settings()[0]["homeName"], "다른 접속 검사")
        self.assertEqual(another.list_events()[1], 1)
        self.assertFalse(another.durable)

    def test_existing_other_tables_untouched(self):
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE home_events (id TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO home_events VALUES ('isolated', 'preserved')")
        SqlStore(sqlite_path=self.path).add_events([event()])
        with sqlite3.connect(self.path) as db: self.assertEqual(db.execute("SELECT value FROM home_events").fetchone()[0], "preserved")

    def test_import_transaction_rolls_back_on_write_failure(self):
        with patch.object(self.store, "_add_events", side_effect=RuntimeError("isolated failure")):
            with self.assertRaises(RuntimeError): self.store.import_family({**DEFAULT_SETTINGS, "homeName": "되돌릴 검사"}, 0, [event()])
        self.assertEqual(self.store.read_settings()[1], 0)

    def test_reject_insecure_remote_connection_before_connecting(self):
        for url in ("https://invalid.test", "postgresql://example.invalid/test?sslmode=disable", "postgresql://example.invalid/test?sslmode=prefer", "postgresql://example.invalid/test?sslmode=require&sslmode=disable", "postgresql://example.invalid/test?sslmode="):
            with self.assertRaises(ValidationError): SqlStore(url=url)


class ServiceTests(unittest.TestCase):
    def setUp(self): self.store = SessionStore(); self.service = FamilyService(self.store, "isolated-owner")

    def call(self, op, payload=None, rid=None, authenticated=True):
        return self.service.handle({"id": rid or str(uuid4()), "op": op, "payload": payload or {}}, authenticated=authenticated)

    def test_unauthorized_every_action_is_denied(self):
        for op in ("refresh", "sync", "settings", "events", "export", "import", "download", "claim", "logout"):
            self.assertFalse(self.call(op, authenticated=False)["ok"])
        self.assertEqual(self.store.list_events()[1], 0)

    def test_idempotent_settings_retry(self):
        request = {"settings": DEFAULT_SETTINGS, "revision": 0}
        first = self.call("settings", request, rid="same-request")
        self.assertTrue(first["ok"])
        self.assertEqual(self.call("settings", request, rid="same-request"), first)
        self.assertEqual(self.store.read_settings()[1], 1)

    def test_claim_sync_and_old_session_rejection(self):
        self.assertTrue(self.call("claim", {"session": "a" * 16})["ok"])
        payload = {"events": [event()], "sample": sample(), "sampleAgeMs": 100}
        self.assertTrue(self.call("sync", payload)["ok"])
        self.assertEqual(self.store.list_events()[1], 1)
        self.assertTrue(self.call("release")["ok"])
        self.assertFalse(self.call("sync", payload)["ok"])
        self.assertTrue(self.call("claim", {"session": "b" * 16})["ok"])
        self.assertFalse(self.call("sync", payload)["ok"])
        self.assertFalse(self.call("sync", {**payload, "sample": sample(session="b" * 16), "sampleAgeMs": 3501})["ok"])

    def test_invalid_batch_writes_nothing(self):
        self.assertFalse(self.call("sync", {"events": [event(), {"id": "bad"}]})["ok"])
        self.assertFalse(self.call("sync", {"events": [event()] * 51})["ok"])
        self.assertEqual(self.store.list_events()[1], 0)

    def test_import_export_disarms_and_preserves(self):
        s = deepcopy(DEFAULT_SETTINGS); s["gas"].update(warmupConfirmed=True, baseline=100, recovery=150, threshold=200); s["intrusion"]["enabled"] = True
        data = {"format": "zipon-family-v4", "settings": s, "events": [event()]}
        r = self.call("import", {"data": data, "includeSettings": True, "revision": 0})
        self.assertTrue(r["ok"]); self.assertEqual(r["result"]["inserted"], 1)
        stored = self.store.read_settings()[0]
        self.assertFalse(stored["gas"]["warmupConfirmed"]); self.assertFalse(stored["intrusion"]["enabled"])
        exported = self.call("export")["result"]
        self.assertEqual(exported["format"], "zipon-family-v4")
        self.assertEqual(len(exported["events"]), 1)
        self.assertNotIn("password", json.dumps(exported))

    def test_import_settings_requires_disconnected_usb(self):
        self.call("claim", {"session": "a" * 16})
        r = self.call("import", {"data": {"format": "zipon-family-v4", "settings": DEFAULT_SETTINGS, "events": [event()]}, "includeSettings": True, "revision": 0})
        self.assertFalse(r["ok"]); self.assertEqual(self.store.list_events()[1], 0)

    def test_errors_do_not_expose_driver_details(self):
        with patch.object(self.store, "list_events", side_effect=RuntimeError("postgresql://NOT-A-REAL-SECRET")):
            r = self.call("refresh")
        self.assertFalse(r["ok"]); self.assertNotIn("NOT-A-REAL-SECRET", r["error"])

    def test_safe_file_downloads_only(self):
        for name in ("kit", "sketch", "wiring", "guide", "deployment"): self.assertTrue(self.call("download", {"name": name})["ok"])
        self.assertFalse(self.call("download", {"name": "../../.env"})["ok"])
        with ZipFile(BytesIO(hardware_zip())) as z:
            self.assertEqual(len(z.namelist()), 3)
            self.assertTrue(all(".." not in n and not n.endswith(".env") for n in z.namelist()))

    def test_filter_validation(self):
        for p in ({"day": "2026-02-30"}, {"day": "2026-1-1"}, {"kind": "%' OR 1=1"}, {"offset": -1}, {"offset": True}): self.assertFalse(self.call("events", p)["ok"])


if __name__ == "__main__": unittest.main()
