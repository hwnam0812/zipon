"""Explicit remote schema check: synthetic data only, always rolled back.

Uses the owner's connected CLI credential only for management. Runtime uses a
separate service key, retrieved in memory for this check and never saved/logged.
Pass --apply to install the additive migration after its isolated check passes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from zipon_streamlit.models import DEFAULT_SETTINGS
from zipon_streamlit.supabase_store import SupabaseStore, SUPABASE_URL

REF = "nbkhmgrzvtqpgcdetgxt"


def query(sql):
    packet = json.dumps({"query": sql}).encode()
    request = Request(f"https://api.supabase.com/v1/projects/{REF}/database/query", data=packet,
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"], "Content-Type": "application/json"})
    with urlopen(request, timeout=40) as response: return json.load(response)


def literal(value): return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def run():
    migration = Path("supabase/migrations/20261119090000_zipon_store.sql").read_text()
    schema = "zipon_check_" + uuid4().hex[:12]
    rpc = schema + ".zipon_store_v1"
    # Never select, copy, update or delete existing family rows in this test.
    sql = f"BEGIN; CREATE SCHEMA {schema}; GRANT USAGE ON SCHEMA {schema} TO service_role;\n" + migration.replace("public.", schema + ".")
    defaults = literal({"settings": DEFAULT_SETTINGS, "now": "2026-11-19T00:00:00.000Z"})
    sample = {"session": "a" * 16, "seq": 1, "gasRaw": 120, "distanceCm": 12}
    event = {"id": "isolated-event", "kind": "door_open", "created_at": "2026-11-18T15:00:00.000Z", "legacy": False}
    sql += f"""
    SET LOCAL ROLE service_role;
    SELECT {rpc}('init', {defaults});
    DO $test$ DECLARE v jsonb; BEGIN
      IF ({rpc}('snapshot')->>3)::integer <> 0 THEN RAISE EXCEPTION 'not empty'; END IF;
      IF {rpc}('settings_save', {literal({'settings': DEFAULT_SETTINGS, 'revision': 0, 'now': '2026-11-19T00:00:00.000Z'})}) <> '1'::jsonb THEN RAISE EXCEPTION 'revision'; END IF;
      BEGIN
        PERFORM {rpc}('settings_save', {literal({'settings': DEFAULT_SETTINGS, 'revision': 0})});
        RAISE EXCEPTION 'missing conflict';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'ZIPON_REVISION_CONFLICT' THEN RAISE; END IF; END;
      IF {rpc}('claim', '{{"owner":"isolated-one"}}') <> 'true'::jsonb THEN RAISE EXCEPTION 'claim'; END IF;
      IF {rpc}('claim', '{{"owner":"isolated-two"}}') <> 'false'::jsonb THEN RAISE EXCEPTION 'ownership'; END IF;
      PERFORM {rpc}('state_write', {literal({'sample': sample, 'owner': 'isolated-one', 'seen_at': '2026-11-19T00:00:00.000Z'})});
      PERFORM {rpc}('state_write', {literal({'sample': {**sample, 'gasRaw': 999}, 'owner': 'isolated-one', 'seen_at': '2026-11-19T00:00:01.000Z'})});
      IF {rpc}('state_read')->'sample'->>'gasRaw' <> '120' THEN RAISE EXCEPTION 'duplicate sample'; END IF;
      IF {rpc}('events_add', {literal({'rows': [event]})}) <> '1'::jsonb THEN RAISE EXCEPTION 'event'; END IF;
      IF {rpc}('events_add', {literal({'rows': [event]})}) <> '0'::jsonb THEN RAISE EXCEPTION 'duplicate event'; END IF;
      v := {rpc}('events', '{{"day":"2026-11-19","kind":"door","offset":0,"limit":50}}');
      IF v->>1 <> '1' THEN RAISE EXCEPTION 'KST filter'; END IF;
      v := {rpc}('events', '{{"day":"2026-11-18","kind":"all","offset":0,"limit":50}}');
      IF v->>1 <> '0' THEN RAISE EXCEPTION 'KST boundary'; END IF;
      IF has_function_privilege('anon', '{rpc}(text,jsonb)', 'EXECUTE') OR has_function_privilege('authenticated', '{rpc}(text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'public RPC'; END IF;
      IF has_table_privilege('anon', '{schema}.zipon_events', 'SELECT') THEN RAISE EXCEPTION 'public table'; END IF;
      PERFORM {rpc}('release', '{{"owner":"isolated-one"}}');
      BEGIN
        PERFORM {rpc}('state_write', {literal({'sample': sample, 'owner': 'isolated-one'})});
        RAISE EXCEPTION 'missing expiry';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'ZIPON_LEASE_EXPIRED' THEN RAISE; END IF; END;
    END $test$;
    RESET ROLE;
    SELECT true AS isolated_checks_passed;
    ROLLBACK;
    """
    result = query(sql)
    assert any(row.get("isolated_checks_passed") is True for row in result)
    print("통과 · zipon 격리 저장·재조회·중복·동시 설정 충돌·소유권·한국 시간·접근 차단. 검사 자료는 되돌렸어요.")
    if "--apply" not in sys.argv: return
    query("BEGIN;\n" + migration + "\nCOMMIT;")
    print("완료 · 집온 전용 보관 기능 추가. 기존 기록·설정은 덮어쓰지 않았어요.")
    keys = json.loads(subprocess.check_output(["supabase", "projects", "api-keys", "--project-ref", REF, "--reveal", "--output", "json"], stderr=subprocess.DEVNULL))
    key = next(row["api_key"] for row in keys if row.get("name") == "service_role")
    store = SupabaseStore(SUPABASE_URL, key)
    snapshot = store.snapshot()
    assert len(snapshot) == 5 and isinstance(snapshot[0], dict)
    # No row content or key is printed or written into a file.
    print("통과 · 앱과 동일한 보안 연결로 저장된 설정·기록·마지막 보고 조회.")
    anon = next(row["api_key"] for row in keys if row.get("name") == "anon")
    try:
        request = Request(SUPABASE_URL + "/rest/v1/rpc/zipon_store_v1", data=b'{"op":"snapshot"}', headers={"apikey": anon, "Authorization": "Bearer " + anon, "Content-Type": "application/json"})
        with urlopen(request, timeout=8): raise RuntimeError("anonymous access unexpectedly allowed")
    except HTTPError as error:
        assert error.code in (401, 403, 404)
    print("통과 · 공개 연결로 가족 자료 조회 불가.")


if __name__ == "__main__":
    try: run()
    except Exception as error:
        # Never print exception strings, response bodies or credentials.
        print("Supabase 확인 중단 · " + type(error).__name__)
        sys.exit(1)
