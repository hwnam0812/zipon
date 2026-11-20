"""Server-only HTTPS storage. No management credential or key enters the UI."""
import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .models import DEFAULT_SETTINGS, ValidationError, utc_now
from .storage import RevisionConflict

SUPABASE_URL = "https://nbkhmgrzvtqpgcdetgxt.supabase.co"


class SupabaseStore:
    mode = "supabase"
    durable = True

    def __init__(self, url, key, *, transport=urlopen):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != "nbkhmgrzvtqpgcdetgxt.supabase.co" or parsed.username or parsed.port or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValidationError("선택한 zipon 프로젝트의 보관 주소를 확인해 주세요.")
        if not key: raise ValidationError("가족 공간의 보관 연결 정보가 필요해요.")
        self.endpoint, self._key, self._transport = url.rstrip("/") + "/rest/v1/rpc/zipon_store_v1", key, transport
        self._call("init", settings=DEFAULT_SETTINGS)

    def _call(self, op, **payload):
        packet = json.dumps({"op": op, "p": {**payload, "now": utc_now()}}, ensure_ascii=False).encode()
        headers = {"apikey": self._key, "Content-Type": "application/json"}
        # New secret keys are not JWTs and belong only in the apikey header.
        if not self._key.startswith("sb_secret_"):
            headers["Authorization"] = "Bearer " + self._key
        request = Request(self.endpoint, data=packet, headers=headers, method="POST")
        try:
            with self._transport(request, timeout=5) as response:
                return json.loads(response.read(8_000_000))
        except HTTPError as error:
            try: message = json.loads(error.read(4096)).get("message")
            except Exception: message = None
            if message == "ZIPON_REVISION_CONFLICT": raise RevisionConflict("다른 화면에서 설정이 바뀌었어요. 다시 불러온 뒤 저장해 주세요.") from None
            if message == "ZIPON_LEASE_EXPIRED": raise ValidationError("USB 연결의 전송 권한이 끝났어요. 다시 연결해 주세요.") from None
            raise ValidationError("Supabase 보관 연결을 확인하지 못했어요. 저장 완료가 아니에요. 연결 정보를 확인한 뒤 다시 시도해 주세요.") from None
        except Exception:
            # Driver/HTTP diagnostics can contain secrets. Never forward them.
            raise ValidationError("Supabase 응답을 확인하지 못했어요. 저장 여부를 다시 확인해 주세요.") from None

    def snapshot(self): return self._call("snapshot")
    def read_settings(self): return self._call("settings_read")
    def save_settings(self, settings, revision): return self._call("settings_save", settings=settings, revision=revision)
    def add_events(self, rows): return self._call("events_add", rows=rows)
    def import_family(self, settings, revision, rows): return self._call("import", settings=settings, revision=revision, rows=rows)
    def list_events(self, limit=50, offset=0, day="", kind="all"): return self._call("events", limit=limit, offset=offset, day=day, kind=kind)
    def claim(self, owner): return self._call("claim", owner=owner)
    def release(self, owner): return self._call("release", owner=owner)
    def write_state(self, sample, seen_at, owner): return self._call("state_write", sample=sample, seen_at=seen_at, owner=owner)
    def read_state(self): return self._call("state_read")
    def close(self): pass
