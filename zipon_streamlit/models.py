"""Public settings and records only. Never put passwords or device keys here."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import re

PROTOCOL = "ZIPON_USB_V4"
MAX_EVENTS = 2000
DEFAULT_SETTINGS = {
    "homeName": "우리 집", "quietEnabled": True,
    "quietWindows": [{"id": "night", "name": "밤 시간", "enabled": True, "start": "22:00", "end": "07:00", "days": list(range(7))}],
    "gas": {"warmupConfirmed": False, "baseline": None, "threshold": None, "recovery": None, "holdSeconds": 10, "recoverySeconds": 10},
    "intrusion": {"enabled": False, "baselineCm": 12, "baselineConfirmed": False, "deltaCm": 8, "holdSeconds": 2, "recoverySeconds": 2, "cooldownSeconds": 30, "allowedWindows": []},
}
EVENT_KINDS = set("usb_connected usb_disconnected device_boot gas_alert gas_clear intrusion_alert intrusion_clear intrusion_stopped door_open door_closed led_on led_off buzzer_on buzzer_off sensor_error sensor_recovered command_requested command_applied command_rejected command_expired settings_saved quiet_door monitoring_started".split())
LEGACY_KINDS = set("fire_risk fire_clear gas_below siren_requested siren_started siren_stopped output_requested output_applied output_rejected sensor_settings".split())


class ValidationError(ValueError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def numeric(value, minimum, maximum, integer=False):
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum and (not integer or int(value) == value)


def text(value, maximum, minimum=0):
    return isinstance(value, str) and minimum <= len(value) <= maximum and "\x00" not in value


def validate_windows(value):
    if not isinstance(value, list) or len(value) > 20:
        raise ValidationError("시간표는 각각 최대 20개까지 추가할 수 있어요.")
    rows, ids = [], set()
    for w in value:
        if not isinstance(w, dict) or not text(w.get("id"), 64, 1) or not re.fullmatch(r"[a-zA-Z0-9_-]+", w["id"]) or w["id"] in ids or not text(w.get("name"), 24, 1) or not w["name"].strip() or type(w.get("enabled")) is not bool:
            raise ValidationError("시간표 이름과 사용 여부를 확인해 주세요.")
        if any(not isinstance(w.get(key), str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", w[key]) for key in ("start", "end")) or w["start"] == w["end"]:
            raise ValidationError("시간표의 시작과 종료 시간을 서로 다르게 선택해 주세요.")
        if not isinstance(w.get("days"), list) or not w["days"] or any(not numeric(d, 0, 6, True) for d in w["days"]):
            raise ValidationError("반복 요일을 하나 이상 선택해 주세요.")
        ids.add(w["id"])
        rows.append({"id": w["id"], "name": w["name"].strip(), "enabled": w["enabled"], "start": w["start"], "end": w["end"], "days": sorted(set(w["days"]))})
    return rows


def validate_settings(value):
    if not isinstance(value, dict) or not text(value.get("homeName"), 20, 1) or not value["homeName"].strip() or type(value.get("quietEnabled")) is not bool:
        raise ValidationError("집 이름과 안심 시간 사용 여부를 확인해 주세요.")
    g, i = value.get("gas"), value.get("intrusion")
    if not isinstance(g, dict) or type(g.get("warmupConfirmed")) is not bool:
        raise ValidationError("가스 센서 확인 내용을 다시 선택해 주세요.")
    for key in ("baseline", "threshold", "recovery"):
        if g.get(key) is not None and not numeric(g[key], 1, 1022, True):
            raise ValidationError("가스 ADC는 1~1022 사이 정수로 입력해 주세요.")
    for key in ("holdSeconds", "recoverySeconds"):
        if not numeric(g.get(key), 5, 60, True):
            raise ValidationError("가스 지속 시간은 5~60초 정수로 입력해 주세요.")
    b, t, r = (g.get(k) for k in ("baseline", "threshold", "recovery"))
    if b is not None and t is not None and b >= t or r is not None and t is not None and r >= t or r is not None and b is not None and r < b:
        raise ValidationError("가스 기준값 ≤ 복귀 기준 < 경보 기준이 되도록 입력해 주세요.")
    if not isinstance(i, dict) or type(i.get("enabled")) is not bool:
        raise ValidationError("출입 감시 사용 여부를 선택해 주세요.")
    if type(i.get("baselineConfirmed", False)) is not bool:
        raise ValidationError("닫힘 기준을 직접 확인했는지 선택해 주세요.")
    for key, lo, hi, whole in [("baselineCm", 2, 390, False), ("deltaCm", 2, 100, False), ("holdSeconds", 1, 30, True), ("recoverySeconds", 1, 30, True), ("cooldownSeconds", 5, 600, True)]:
        if not numeric(i.get(key), lo, hi, whole):
            raise ValidationError("거리 기준·변화량·지속 시간·반복 방지 시간을 확인해 주세요.")
    return {"homeName": value["homeName"].strip(), "quietEnabled": value["quietEnabled"], "quietWindows": validate_windows(value.get("quietWindows")),
            "gas": {k: g.get(k) for k in DEFAULT_SETTINGS["gas"]},
            "intrusion": {**{k: i[k] for k in DEFAULT_SETTINGS["intrusion"] if k not in ("allowedWindows", "baselineConfirmed")}, "baselineConfirmed": i.get("baselineConfirmed", False), "allowedWindows": validate_windows(i.get("allowedWindows"))}}


def validate_sample(p):
    if not isinstance(p, dict) or p.get("type") != "telemetry" or p.get("protocol") != PROTOCOL or not isinstance(p.get("session"), str) or not re.fullmatch(r"[a-f0-9]{16}", p["session"]):
        raise ValidationError("USB 측정 형식을 확인해 주세요.")
    if not numeric(p.get("seq"), 1, 4294967295, True) or not numeric(p.get("uptimeMs"), 0, 4294967295, True) or not numeric(p.get("config"), 0, 2147483647, True):
        raise ValidationError("측정 순서가 올바르지 않아요.")
    for key, lo, hi, whole in [("gasRaw", 0, 1023, True), ("distanceCm", 2, 400, False)]:
        if key not in p or p[key] is not None and not numeric(p[key], lo, hi, whole):
            raise ValidationError("측정 범위를 벗어난 값이에요.")
    if p.get("gasState") not in ("disabled", "below", "watch", "alert", "fault") or any(type(p.get(k)) is not bool for k in ("gasAlarm", "intrusionAlarm", "led", "buzzer", "manualLed", "manualBuzzer")) or p.get("ledSource") not in ("off", "manual", "gas") or p.get("buzzerSource") not in ("off", "manual", "gas", "intrusion"):
        raise ValidationError("보드 상태 보고를 확인해 주세요.")
    led_source = "gas" if p["gasAlarm"] else "manual" if p["manualLed"] else "off"
    buzzer_source = "gas" if p["gasAlarm"] else "intrusion" if p["intrusionAlarm"] else "manual" if p["manualBuzzer"] else "off"
    if p["gasState"] == "alert" and not p["gasAlarm"] or p["gasState"] == "disabled" and p["gasAlarm"] or p["ledSource"] != led_source or p["buzzerSource"] != buzzer_source or p["led"] != (led_source != "off") or p["buzzer"] != (buzzer_source != "off"):
        raise ValidationError("경보와 출력 보고가 일치하지 않아요.")
    return {k: p[k] for k in ("type", "protocol", "session", "seq", "uptimeMs", "gasRaw", "distanceCm", "gasState", "gasAlarm", "intrusionAlarm", "led", "buzzer", "manualLed", "manualBuzzer", "ledSource", "buzzerSource", "config")}


def validate_event(row, legacy=False):
    if not isinstance(row, dict) or not text(row.get("id"), 100, 1) or not re.fullmatch(r"[a-zA-Z0-9:_-]+", row["id"]):
        raise ValidationError("기록 식별값이 올바르지 않아요.")
    if row.get("kind") not in EVENT_KINDS | (LEGACY_KINDS if legacy else set()):
        raise ValidationError("알 수 없는 기록 종류예요.")
    try:
        dt = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        if dt.tzinfo is None or not 2000 <= dt.year <= 2100:
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValidationError("기록의 날짜와 시간을 확인해 주세요.") from None
    for key, lo, hi, whole in [("gas_raw", 0, 1023, True), ("distance_cm", 2, 400, False)]:
        if row.get(key) is not None and not numeric(row[key], lo, hi, whole):
            raise ValidationError("기록의 센서값을 확인해 주세요.")
    if any(row.get(k) is not None and type(row[k]) is not bool for k in ("led", "buzzer")) or not text(row.get("detail", ""), 1000) or not text(row.get("title", ""), 120):
        raise ValidationError("기록의 출력 상태와 설명을 확인해 주세요.")
    return {"id": row["id"], "kind": row["kind"], "created_at": dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "gas_raw": row.get("gas_raw"), "distance_cm": row.get("distance_cm"), "led": row.get("led"), "buzzer": row.get("buzzer"), "title": row.get("title", "") if legacy else "", "detail": row.get("detail", ""), "legacy": bool(legacy)}


def parse_import(value):
    """Explicit user uploads only; credentials/devices/commands are never imported."""
    if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=False).encode()) > 2_000_000:
        raise ValidationError("가져올 자료는 2MB 이하의 집온 JSON이어야 해요.")
    if value.get("format") == "zipon-family-v4":
        settings = validate_settings(value["settings"]) if value.get("settings") is not None else None
        source = value.get("events", [])
    elif "home_events" in value or "home_settings" in value:
        source = value.get("home_events", [])
        old = value.get("home_settings", [])
        if isinstance(old, list):
            old = next((r.get("value") for r in old if isinstance(r, dict) and r.get("scope") == "family"), None)
        if isinstance(old, str):
            try: old = json.loads(old)
            except ValueError: raise ValidationError("이전 설정 자료를 읽지 못했어요.") from None
        settings = convert_legacy_settings(old) if old else None
    else:
        raise ValidationError("집온에서 내보낸 기록 자료를 선택해 주세요.")
    if not isinstance(source, list) or len(source) > 5000:
        raise ValidationError("이전 기록은 한 번에 최대 5,000건까지 가져올 수 있어요.")
    rows = []
    for row in source:
        if not isinstance(row, dict): raise ValidationError("기록 자료의 형식을 확인해 주세요.")
        if row.get("scope", "family") != "family": continue
        normalized = {**row, "detail": row.get("detail", ""), "gas_raw": row.get("gas_raw"), "distance_cm": row.get("distance_cm"), "led": row.get("led"), "buzzer": row.get("buzzer")}
        rows.append(validate_event(normalized, legacy=True))
    return settings, rows


def convert_legacy_settings(old):
    if not isinstance(old, dict): raise ValidationError("이전 설정 자료를 확인해 주세요.")
    result = deepcopy(DEFAULT_SETTINGS)
    result["homeName"] = old.get("homeName", result["homeName"])
    result["quietEnabled"] = old.get("quietEnabled", True)
    if isinstance(old.get("quietWindows"), list): result["quietWindows"] = old["quietWindows"]
    elif "quietStart" in old:
        result["quietWindows"] = [{"id": "existing", "name": "기존 안심 시간", "enabled": True, "start": old.get("quietStart"), "end": old.get("quietEnd"), "days": old.get("quietDays")}]
    result["intrusion"]["baselineCm"] = old.get("closedDistance", 12)
    result["intrusion"]["deltaCm"] = old.get("doorTolerance", 8)
    result["intrusion"]["holdSeconds"] = old.get("doorConfirmSeconds", 2)
    result["intrusion"]["recoverySeconds"] = old.get("doorConfirmSeconds", 2)
    result["gas"]["holdSeconds"] = old.get("gasSustainedSeconds", 10)
    result["gas"]["recoverySeconds"] = old.get("gasSustainedSeconds", 10)
    b, rise = old.get("gasBaselineAdc"), old.get("gasRiseAdc", 100)
    if numeric(b, 1, 1022, True) and numeric(rise, 1, 1022, True) and b + rise <= 1022:
        result["gas"].update(baseline=b, threshold=b + rise, recovery=b + rise // 2)
    # Import never arms monitoring or asserts a warmup confirmation for this connection.
    return validate_settings(result)
