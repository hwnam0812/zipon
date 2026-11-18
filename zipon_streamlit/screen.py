"""Non-blocking, session-private screen bridge. No Streamlit calls in IO jobs."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import time

from .service import FamilyService
from .storage import SessionStore, SqlStore
from .models import utc_now

_IO = ThreadPoolExecutor(max_workers=4, thread_name_prefix="zipon-storage")
STORAGE_ERROR = "저장 연결을 확인하지 못했어요. 마지막으로 읽은 내용을 표시하고 있어요. 새 기록의 저장 완료를 뜻하지 않아요."
TEMPORARY_WARNING = "영구 저장소에 연결하지 못했어요. 이번 접속은 임시 기록만 사용해요. Streamlit Secrets의 DATABASE_URL을 확인한 뒤 다시 열어 주세요."


def open_service(url, path, owner):
    warning = ""
    if url or path:
        store = None
        try:
            store = SqlStore(url=url or None, sqlite_path=path or None)
            service = FamilyService(store, owner)
            return service, service.snapshot(), warning
        except Exception:
            if store is not None: store.close()
            warning = TEMPORARY_WARNING
    service = FamilyService(SessionStore(), owner)
    return service, service.snapshot(), warning


class ScreenSession:
    """At most one queued browser request and one IO job per family session."""
    def __init__(self, loader, *, executor=None, clock=time.monotonic):
        self.executor, self.clock = executor or _IO, clock
        self.service = self.data = self.reply = self.queued = None
        self.warning = self.error = ""
        self.next_refresh = 0
        self.kind, self.active_request = "open", None
        self.future = self.executor.submit(loader)

    def enqueue(self, request):
        if not isinstance(request, dict) or not isinstance(request.get("id"), str): return
        rid = request["id"]
        if rid == (self.reply or {}).get("id") or rid == (self.active_request or {}).get("id"): return
        if self.queued is None:
            self.queued = deepcopy(request)
            self.received_at = self.clock()

    def _handle(self, request, received_at):
        # Queue time is part of measurement age, not a fresh sensor observation.
        if request.get("op") == "sync":
            payload = request.get("payload")
            if isinstance(payload, dict) and payload.get("sample") is not None:
                age = payload.get("sampleAgeMs")
                if type(age) is int: payload["sampleAgeMs"] += max(0, int((self.clock() - received_at) * 1000))
        return self.service.handle(request, authenticated=True)

    def poll(self):
        if self.future is not None and self.future.done():
            try:
                value = self.future.result()
                if self.kind == "open": self.service, self.data, self.warning = value
                elif self.kind == "snapshot": self.data = value
                else:
                    self.reply = value
                    if value.get("ok"):
                        op, result = self.active_request.get("op"), value.get("result", {})
                        if op == "refresh": self.data = result
                        elif op == "settings": self.data.update(settings=result["settings"], settingsRevision=result["settingsRevision"])
                        if op not in ("download", "inspect_import", "logout", "release"):
                            self.data["serverTime"] = utc_now()
                        if op in ("settings", "import"): self.next_refresh = 0
                self.error = ""
            except Exception:
                # Never expose or log driver exceptions, even when parsing a bad URI.
                self.error = STORAGE_ERROR
            finally:
                if self.kind in ("open", "snapshot"): self.next_refresh = self.clock() + (5 if self.error else 3)
                self.future, self.active_request = None, None
        if self.future is None and self.service is not None:
            if self.queued is not None:
                self.active_request, self.queued = self.queued, None
                self.kind = "request"
                self.future = self.executor.submit(self._handle, self.active_request, self.received_at)
            elif self.clock() >= self.next_refresh:
                self.kind = "snapshot"
                self.future = self.executor.submit(self.service.snapshot)
        if self.data is None: return None
        return {**self.data, "reply": self.reply, "storageError": self.error or self.warning}

    def close(self):
        if self.future is not None: self.future.cancel()
        if self.service is not None and hasattr(self.service.store, "close"):
            self.executor.submit(self.service.store.close)
