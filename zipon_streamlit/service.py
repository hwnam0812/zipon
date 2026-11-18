"""Authenticated, bounded component actions. The cloud never opens a USB port."""
from __future__ import annotations

import base64
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import re
from zipfile import ZipFile, ZIP_DEFLATED

from .models import ValidationError, numeric, parse_import, utc_now, validate_event, validate_sample, validate_settings

ROOT = Path(__file__).resolve().parent.parent
HARDWARE_FILES = {
    "sketch": ("hardware/zipon_uno_v4/zipon_uno_v4.ino", "zipon_uno_v4.ino", "text/plain"),
    "wiring": ("hardware/zipon-v4-wiring.svg", "zipon-v4-wiring.svg", "image/svg+xml"),
    "guide": ("hardware/V4-USB-설치안내.md", "V4-USB-설치안내.md", "text/markdown"),
    "deployment": ("STREAMLIT-배포안내.md", "STREAMLIT-배포안내.md", "text/markdown"),
}


def hardware_zip():
    out = BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as z:
        for key in ("sketch", "wiring", "guide"):
            source, name, _ = HARDWARE_FILES[key]
            if key == "sketch": name = "zipon_uno_v4/zipon_uno_v4.ino"
            z.writestr("zipon-usb-v4/" + name, (ROOT / source).read_bytes())
    return out.getvalue()


class FamilyService:
    def __init__(self, store, owner):
        self.store, self.owner = store, owner
        self.usb_session = None
        self.responses = OrderedDict()

    def usb_owner(self):
        return self.owner + ":" + self.usb_session if self.usb_session else None

    def snapshot(self):
        settings, revision, rows, total, state = self.store.snapshot()
        return {"settings": settings, "settingsRevision": revision, "events": rows, "eventTotal": total, "lastState": state, "mode": self.store.mode, "durable": self.store.durable, "serverTime": utc_now()}

    @staticmethod
    def filters(p):
        day, kind, offset = p.get("day", ""), p.get("kind", "all"), p.get("offset", 0)
        if not isinstance(day, str) or day and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day): raise ValidationError("조회 날짜를 확인해 주세요.")
        if day:
            try: datetime.fromisoformat(day)
            except ValueError: raise ValidationError("조회 날짜를 확인해 주세요.") from None
        if kind not in ("all", "gas", "intrusion", "door", "usb", "sensor", "led", "buzzer", "command"): raise ValidationError("조회 종류를 확인해 주세요.")
        if not numeric(offset, 0, 1_000_000, True): raise ValidationError("기록 페이지를 확인해 주세요.")
        return day, kind, int(offset)

    def handle(self, request, *, authenticated):
        if not authenticated: return {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": "가족 공간을 먼저 열어 주세요."}
        if not isinstance(request, dict) or not isinstance(request.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", request["id"]):
            return {"id": None, "ok": False, "error": "요청 형식을 확인해 주세요."}
        rid = request["id"]
        if rid in self.responses: return self.responses[rid]
        try:
            if len(json.dumps(request, ensure_ascii=False).encode()) > 2_100_000: raise ValidationError("요청 자료가 너무 커요.")
            p, op = request.get("payload", {}), request.get("op")
            if not isinstance(p, dict): raise ValidationError("요청 내용을 확인해 주세요.")
            result = self.perform(op, p)
            reply = {"id": rid, "ok": True, "result": result}
        except ValidationError as error:
            reply = {"id": rid, "ok": False, "error": str(error)}
        except Exception:
            # Driver exceptions can contain credentials. Do not render or log them.
            reply = {"id": rid, "ok": False, "error": "저장소 또는 파일을 읽지 못했어요. 연결 설정을 확인하고 다시 시도해 주세요."}
        self.responses[rid] = reply
        while len(self.responses) > 50: self.responses.popitem(last=False)
        return reply

    def perform(self, op, p):
        if op == "refresh": return self.snapshot()
        if op == "settings":
            settings = validate_settings(p.get("settings"))
            if not numeric(p.get("revision"), 0, 2_147_483_647, True): raise ValidationError("설정 버전을 다시 불러와 주세요.")
            revision = self.store.save_settings(settings, p["revision"])
            return {"settings": settings, "settingsRevision": revision, "persistent": self.store.durable}
        if op == "claim":
            session = p.get("session")
            if not isinstance(session, str) or not re.fullmatch(r"[a-f0-9]{16}", session): raise ValidationError("USB 연결을 다시 확인해 주세요.")
            owner = self.owner + ":" + session
            if not self.store.claim(owner): raise ValidationError("다른 화면이 이 집의 USB 연결을 사용하고 있어요. 그 화면에서 연결을 해제해 주세요.")
            self.usb_session = session
            return {"claimed": True}
        if op == "release" or op == "logout":
            if self.usb_owner(): self.store.release(self.usb_owner())
            self.usb_session = None
            return {"released": True, "logout": op == "logout"}
        if op == "sync":
            events = p.get("events", [])
            if not isinstance(events, list) or len(events) > 50: raise ValidationError("기록은 한 번에 최대 50개씩 보낼 수 있어요.")
            rows = [validate_event(r) for r in events]
            sample = validate_sample(p["sample"]) if p.get("sample") is not None else None
            if sample:
                if not self.usb_session or sample["session"] != self.usb_session or not numeric(p.get("sampleAgeMs"), 0, 3500, True): raise ValidationError("현재 USB 연결의 새 측정만 보낼 수 있어요.")
                seen_at = (datetime.now(timezone.utc) - timedelta(milliseconds=p["sampleAgeMs"])).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                self.store.write_state(sample, seen_at, self.usb_owner())
            if rows: self.store.add_events(rows)
            return {"acceptedIds": [r["id"] for r in rows], "persistent": self.store.durable}
        if op == "events":
            day, kind, offset = self.filters(p)
            rows, total = self.store.list_events(50, offset, day, kind)
            return {"rows": rows, "total": total}
        if op == "export":
            day, kind, _ = self.filters(p)
            rows, total = self.store.list_events(5001, 0, day, kind)
            if total > 5000: raise ValidationError("내보낼 기록이 5,000건을 넘어요. 출입 기록에서 날짜·종류를 선택해 나누어 받아 주세요.")
            settings, _ = self.store.read_settings()
            return {"format": "zipon-family-v4", "exportedAt": utc_now(), "settings": settings, "events": rows}
        if op in ("inspect_import", "import"):
            settings, rows = parse_import(p.get("data"))
            if op == "inspect_import": return {"records": len(rows), "hasSettings": settings is not None}
            include = p.get("includeSettings", False)
            if type(include) is not bool: raise ValidationError("설정 가져오기 여부를 확인해 주세요.")
            if include and self.usb_session: raise ValidationError("설정을 가져오기 전에 USB 연결을 해제해 주세요.")
            if include and settings:
                if not numeric(p.get("revision"), 0, 2_147_483_647, True): raise ValidationError("현재 설정을 다시 불러와 주세요.")
                settings["gas"]["warmupConfirmed"] = False
                settings["intrusion"]["enabled"] = False
            inserted = self.store.import_family(settings if include else None, p.get("revision"), rows)
            return {"inserted": inserted, "persistent": self.store.durable}
        if op == "download":
            name = p.get("name")
            if name == "kit": content, filename, mime = hardware_zip(), "zipon-usb-v4-kit.zip", "application/zip"
            elif name in HARDWARE_FILES:
                path, filename, mime = HARDWARE_FILES[name]; content = (ROOT / path).read_bytes()
            else: raise ValidationError("받을 파일을 다시 선택해 주세요.")
            return {"filename": filename, "mime": mime, "content": base64.b64encode(content).decode("ascii")}
        raise ValidationError("지원하지 않는 요청이에요.")
