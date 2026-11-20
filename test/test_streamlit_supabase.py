"""No network or actual credential. Exercise the server-only storage adapter."""
from io import BytesIO
import json
from urllib.error import HTTPError
import unittest

from zipon_streamlit.models import ValidationError
from zipon_streamlit.storage import RevisionConflict
from zipon_streamlit.supabase_store import SupabaseStore, SUPABASE_URL


class SupabaseTests(unittest.TestCase):
    def transport(self, request, timeout):
        self.calls.append(json.loads(request.data))
        self.assertEqual(request.get_header("Apikey"), "isolated-key")
        self.assertEqual(timeout, 5)
        return BytesIO(json.dumps(self.result).encode())

    def setUp(self):
        self.calls, self.result = [], True
        self.store = SupabaseStore(SUPABASE_URL, "isolated-key", transport=self.transport)

    def test_no_key_in_snapshot_or_payload(self):
        self.result = [{}, 1, [], 0, None]
        self.assertEqual(self.store.snapshot(), self.result)
        self.assertNotIn("isolated-key", json.dumps(self.calls))
        self.assertTrue(self.store.durable)

    def test_new_secret_key_uses_apikey_without_jwt_authorization(self):
        def transport(request, timeout):
            self.assertEqual(request.get_header("Apikey"), "sb_secret_isolated_example")
            self.assertIsNone(request.get_header("Authorization"))
            self.assertNotIn("sb_secret_isolated_example", request.data.decode())
            return BytesIO(b"true")
        SupabaseStore(SUPABASE_URL, "sb_secret_isolated_example", transport=transport)

    def test_legacy_service_key_keeps_authorization(self):
        def transport(request, timeout):
            self.assertEqual(request.get_header("Authorization"), "Bearer isolated-legacy-example")
            return BytesIO(b"true")
        SupabaseStore(SUPABASE_URL, "isolated-legacy-example", transport=transport)

    def test_reject_other_project_and_non_https(self):
        for url in ("https://ggsafe.supabase.co", "http://nbkhmgrzvtqpgcdetgxt.supabase.co", SUPABASE_URL + "/else", SUPABASE_URL + "?secret=no"):
            with self.assertRaises(ValidationError): SupabaseStore(url, "isolated-key", transport=self.transport)

    def test_all_operations_use_fixed_rpc_not_arbitrary_tables(self):
        self.store.read_settings(); self.store.save_settings({}, 1)
        self.store.add_events([]); self.store.import_family(None, 1, [])
        self.store.list_events(day="2026-11-19", kind="door")
        self.store.claim("one"); self.store.release("one")
        self.store.write_state({}, "now", "one"); self.store.read_state()
        self.assertEqual([r["op"] for r in self.calls], ["init", "settings_read", "settings_save", "events_add", "import", "events", "claim", "release", "state_write", "state_read"])

    def test_known_conflict_and_expiry_are_not_success(self):
        for message, kind in [("ZIPON_REVISION_CONFLICT", RevisionConflict), ("ZIPON_LEASE_EXPIRED", ValidationError)]:
            def fail(request, timeout): raise HTTPError(request.full_url, 400, "isolated", {}, BytesIO(json.dumps({"message": message}).encode()))
            self.store._transport = fail
            with self.assertRaises(kind): self.store.save_settings({}, 1)

    def test_failure_does_not_expose_details_or_retry_unknown_write(self):
        calls = []
        def fail(request, timeout): calls.append(request); raise RuntimeError("private-driver-detail isolated-key")
        self.store._transport = fail
        with self.assertRaises(ValidationError) as error: self.store.save_settings({}, 1)
        self.assertNotIn("private-driver", str(error.exception))
        self.assertNotIn("isolated-key", str(error.exception))
        self.assertEqual(len(calls), 1)
