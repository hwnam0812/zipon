"""Zipon V3 USB relay. Python 3.10+, pyserial 3.5; no inbound service.
The device key stays in RAM and is NEVER sent to the UNO or written to a file.
Raw MQ-135 output changes are not gas concentration/fire/safety judgments.
"""
import argparse
import datetime as dt
import getpass
import json
import math
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROTOCOL = "ZIPON_AUTO_V3"
ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z")
DOORS = {"U": "unknown", "C": "closed", "O": "open"}
GAS = {"0": "disabled", "1": "below", "2": "watch", "3": "alert", "4": "fault"}
SOURCES = {"N": "off", "M": "manual", "D": "door", "G": "gas", "P": "paused"}
KINDS = {"DOOR_OPEN": "door_open", "DOOR_CLOSED": "door_closed", "GAS_ALERT": "gas_alert", "GAS_BELOW": "gas_below"}


class BridgeError(Exception):
    pass


class AppRefused(BridgeError):
    def __init__(self, code):
        self.code = code
        super().__init__(f"앱이 요청을 거절했어요({code}). 연결 키·공개 범위·새 USB 코드를 확인해 주세요.")


def app_origin(value):
    u = urllib.parse.urlsplit(value.strip())
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
        raise BridgeError("앱의 https:// 주소만 입력해 주세요. 페이지 경로나 비밀번호를 주소에 넣지 마세요.")
    return urllib.parse.urlunsplit((u.scheme, u.netloc, "", "", ""))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward a key to a redirected address.


class App:
    def __init__(self, origin, key):
        self.origin, self.key = app_origin(origin), key
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def request(self, path, body=None):
        request = urllib.request.Request(self.origin + "/api/device" + path,
            data=None if body is None else json.dumps(body, allow_nan=False).encode(),
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=4) as response:
                raw = response.read(32769)
                if len(raw) > 32768 or "application/json" not in response.headers.get("Content-Type", ""):
                    raise BridgeError("앱의 응답 형식을 확인해 주세요.")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise BridgeError("앱의 응답 형식을 확인해 주세요.")
                return result
        except urllib.error.HTTPError as error:
            raise AppRefused(error.code) from None
        except (OSError, ValueError):
            raise BridgeError("인터넷·인증서·앱 주소를 확인해 주세요. 원격 요청을 실행하지 않아요.") from None


def raw_values(adc, mm, adc_volts):
    if not -1 <= adc <= 1023 or not (mm == -1 or 20 <= mm <= 4000):
        return None
    return {"gasAdc": None if adc == -1 else adc,
        "gasVoltageV": None if adc == -1 else round(adc * adc_volts / 1023, 4),
        "distanceCm": None if mm == -1 else mm / 10}


def sample_payload(line, session, adc_volts):
    p = line.split()
    if len(p) != 17 or p[:2] != ["R", session]:
        return None
    try:
        seq, uptime, adc, mm = map(int, p[2:6])
        mute, led_off, buzzer_off = map(int, p[13:16])
    except ValueError:
        return None
    raw = raw_values(adc, mm, adc_volts)
    if raw is None or not 1 <= seq <= 4294967295 or not 0 <= uptime <= 4294967295:
        return None
    if p[6] not in DOORS or p[7] not in GAS or any(v not in ("0", "1") for v in p[8:11]) or any(v not in SOURCES for v in p[11:13]):
        return None
    if not 0 <= mute <= 60 or not 0 <= led_off <= 30 or not 0 <= buzzer_off <= 30 or not re.fullmatch(r"[a-f0-9]{16}", p[16]):
        return None
    if mm == -1 and p[6] != "U" or adc in (-1, 0) and p[7] not in ("0", "4"):
        return None
    if p[7] == "3" and p[8] != "1" or p[7] in ("1", "2") and p[8] != "0":
        return None
    if p[11] in ("N", "P") and p[9] == "1" or p[12] in ("N", "P") and p[10] == "1":
        return None
    return {"protocol": PROTOCOL, "sampleId": f"{session}:{seq}", "gasSensor": "MQ-135", "dustUgM3": None, **raw,
        "board": {"session": session, "sequence": seq, "uptimeMs": uptime, "configRevision": p[16],
            "doorStatus": DOORS[p[6]], "gasStatus": GAS[p[7]], "gasAlarm": p[8] == "1",
            "ledOn": p[9] == "1", "buzzerOn": p[10] == "1", "ledSource": SOURCES[p[11]], "buzzerSource": SOURCES[p[12]],
            "muteSeconds": mute, "ledOffSeconds": led_off, "buzzerOffSeconds": buzzer_off}, "boardEvents": []}


def event_payload(line, session):
    p = line.split()
    if len(p) != 7 or p[:2] != ["E", session] or p[4] not in KINDS:
        return None
    try:
        seq, uptime, adc, mm = int(p[2]), int(p[3]), int(p[5]), int(p[6])
    except ValueError:
        return None
    raw = raw_values(adc, mm, 5)
    if raw is None or not 1 <= seq <= 4294967295 or not 0 <= uptime <= 4294967295:
        return None
    if p[4].startswith("DOOR") and mm == -1 or p[4].startswith("GAS") and adc <= 0:
        return None
    return {"sequence": seq, "kind": KINDS[p[4]], "uptimeMs": uptime, "gasAdc": raw["gasAdc"], "distanceCm": raw["distanceCm"]}


def configuration_line(config, session):
    if not isinstance(config, dict) or not re.fullmatch(r"[a-f0-9]{16}", str(config.get("revision", ""))):
        raise BridgeError("센서 설정 형식을 확인해 주세요.")
    fields = [("closedMm", 20, 3900), ("toleranceMm", 20, 1000), ("doorHoldMs", 1000, 5000),
        ("doorCalibrated", 0, 1), ("doorSignals", 0, 1), ("gasEnabled", 0, 1),
        ("baselineAdc", 0, 1022), ("riseAdc", 1, 1022), ("gasHoldMs", 5000, 60000)]
    values = []
    for key, low, high in fields:
        value = config.get(key)
        boolean = key in ("doorCalibrated", "doorSignals", "gasEnabled")
        if (type(value) is not bool if boolean else type(value) is not int) or not low <= value <= high:
            raise BridgeError("센서 설정 허용 범위를 확인해 주세요.")
        values.append(str(int(value)))
    if config["gasEnabled"] and (config["baselineAdc"] == 0 or config["baselineAdc"] + config["riseAdc"] > 1023):
        raise BridgeError("가스 기준 ADC와 상승 폭을 확인해 주세요.")
    return f"CFG {session} {config['revision']} " + " ".join(values)


class Board:
    def __init__(self, port, adc_volts=5.0):
        self.port, self.adc_volts = port, adc_volts
        self.session = uuid.uuid4().hex
        self.lock, self.write_lock = threading.Lock(), threading.Lock()
        self.latest = None
        self.events, self.board_events = queue.Queue(maxsize=64), queue.Queue(maxsize=256)
        self.dead, self.ready = threading.Event(), threading.Event()
        self.last_seq, self.last_event_seq = 0, 0

    def send(self, message):
        data = (message + "\n").encode("ascii")
        with self.write_lock:
            if self.port.write(data) != len(data):
                raise BridgeError("USB 명령을 끝까지 보내지 못했어요.")

    def fresh(self):
        with self.lock:
            return self.latest if self.latest and time.monotonic() - self.latest[0] < 3 else None

    def read_loop(self):
        buffer = b""
        try:
            while not self.dead.is_set():
                buffer += self.port.read(128)
                if len(buffer) > 2048:
                    raise BridgeError("USB 응답 형식을 확인해 주세요.")
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.decode("ascii", errors="replace").strip()
                    if line == f"READY {self.session} {PROTOCOL}":
                        self.ready.set()
                    elif line.startswith("BOOT ") and self.ready.is_set():
                        raise BridgeError("보드가 재시작됐어요.")
                    elif self.ready.is_set():
                        sample = sample_payload(line, self.session, self.adc_volts)
                        event = event_payload(line, self.session)
                        if sample and sample["board"]["sequence"] > self.last_seq:
                            self.last_seq = sample["board"]["sequence"]
                            with self.lock:
                                self.latest = (time.monotonic(), sample)
                        elif event and event["sequence"] > self.last_event_seq:
                            self.last_event_seq = event["sequence"]
                            self.board_events.put_nowait(event)
                        else:
                            p = line.split()
                            if len(p) == 4 and p[:2] == ["ACK", self.session] and ID.fullmatch(p[2]) and p[3] in ("APPLIED", "REJECTED"):
                                self.events.put_nowait((p[2], p[3]))
        except Exception:
            self.dead.set()  # Never print raw USB data, keys, or traceback.

    def heartbeat_loop(self):
        try:
            while not self.dead.wait(0.75):
                self.send(f"PING {self.session}")
        except Exception:
            self.dead.set()

    def start(self):
        time.sleep(2)  # Opening an UNO serial port usually resets it.
        self.port.reset_input_buffer()
        threading.Thread(target=self.read_loop, daemon=True).start()
        self.send("MANUAL_OFF")
        self.send(f"HELLO {self.session}")
        if not self.ready.wait(5) or self.dead.is_set():
            raise BridgeError("새 V3 스케치·USB 포트·115200 설정을 확인하고 시리얼 모니터를 닫아 주세요.")
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()

    def close(self):
        self.dead.set()
        try:
            self.send("MANUAL_OFF")
        except Exception:
            pass
        self.port.close()  # Local automatic reactions may CONTINUE while powered.


class Relay:
    def __init__(self, app, board):
        self.app, self.board = app, board
        self.handled, self.allowed, self.results = set(), set(), {}
        self.backlog = []
        self.pending = None

    def prepare(self):
        latest = self.board.fresh()
        if not latest:
            return None
        sample = latest[1]
        if self.pending is None or self.pending["sampleId"] != sample["sampleId"]:
            if self.pending:
                self.backlog = self.pending["boardEvents"] + self.backlog
            self.pending = self.payload(sample)
        return self.pending

    def payload(self, sample):
        while True:
            try:
                self.backlog.append(self.board.board_events.get_nowait())
            except queue.Empty:
                break
        events, future = [], []
        for event in self.backlog:
            age = (sample["board"]["uptimeMs"] - event["uptimeMs"]) & 0xFFFFFFFF
            if age > 0x7FFFFFFF or len(events) >= 24:
                future.append(event)
            elif age <= 30000:
                events.append(event)
            else:
                print("연결이 늦어 일부 과거 감지 기록을 전송하지 못했어요. 현재 상태를 직접 확인해 주세요.")
        self.backlog = future
        return {**sample, "boardEvents": events}

    def synchronize(self, response, received_after):
        if response.get("ok") is not True or response.get("protocol") != PROTOCOL:
            raise BridgeError("앱과 USB 코드의 버전이 달라요.")
        config = response.get("config")
        message = configuration_line(config, self.board.session)
        latest = self.board.fresh()
        if latest and latest[1]["board"]["configRevision"] != config["revision"]:
            self.board.send(message)
        commands = response.get("commands")
        if not isinstance(commands, list) or len(commands) > 3:
            raise BridgeError("앱 제어 요청 형식을 확인해 주세요.")
        for command in commands:
            self.command(command, response.get("serverTime"), received_after)

    def command(self, command, server_time, received_after):
        if not isinstance(command, dict):
            raise BridgeError("앱 제어 요청 형식이 달라요.")
        cid, target, action, seconds = (command.get(k) for k in ("id", "target", "action", "seconds"))
        if not isinstance(cid, str) or not ID.fullmatch(cid) or command.get("session") != self.board.session:
            raise BridgeError("이번 USB 연결의 제어 요청이 아니에요.")
        if target not in ("led", "buzzer", "alarm") or action not in (("mute", "resume") if target == "alarm" else ("on", "off", "test")):
            raise BridgeError("출력 제어 동작을 확인해 주세요.")
        expected = {"off": 30, "test": 2, "mute": 60, "resume": 0}
        if type(seconds) is not int or (not 1 <= seconds <= 15 if action == "on" else seconds != expected[action]):
            raise BridgeError("출력 제어 시간을 확인해 주세요.")
        if cid in self.handled:
            return
        if len(self.handled) >= 10000:
            raise BridgeError("연결 프로그램을 다시 실행해 주세요.")
        try:
            remaining = (dt.datetime.fromisoformat(command["expires_at"].replace("Z", "+00:00")) - dt.datetime.fromisoformat(server_time.replace("Z", "+00:00"))).total_seconds()
        except (KeyError, TypeError, ValueError, AttributeError):
            raise BridgeError("제어 요청 기한을 확인하지 못했어요.") from None
        if not self.board.fresh() or remaining - (time.monotonic() - received_after) <= 1:
            return
        self.handled.add(cid)  # Ambiguous network results NEVER replay activation.
        grant = self.app.request(f"/outputs/{cid}/claim", {"session": self.board.session})
        if grant.get("ok") is not True or grant.get("alreadyClaimed") is not False:
            return
        if not self.board.fresh() or remaining - (time.monotonic() - received_after) <= 1:
            self.board.send("MANUAL_OFF")
            return
        self.allowed.add(cid)
        self.board.send(f"SET {self.board.session} {cid} " + {"led": "L", "buzzer": "B", "alarm": "A"}[target] + f" {action.upper()} {seconds}")

    def collect(self):
        while True:
            try:
                cid, status = self.board.events.get_nowait()
            except queue.Empty:
                break
            if cid in self.allowed:
                self.results[cid] = "applied" if status == "APPLIED" else "rejected"
        for cid, status in list(self.results.items()):
            try:
                result = self.app.request(f"/outputs/{cid}/ack", {"session": self.board.session, "status": status})
            except AppRefused as error:
                if error.code not in (404, 409):
                    raise
                result = {"ok": True}  # Cancelled/expired commands cannot be revived.
            if result.get("ok") is True:
                self.results.pop(cid, None)
                self.allowed.discard(cid)


def main():
    parser = argparse.ArgumentParser(description="집온 자동 감지·독립 출력 제어 USB 연결 프로그램")
    parser.add_argument("--ports", action="store_true", help="USB 포트 목록")
    parser.add_argument("--inspect", action="store_true", help="앱 전송 없이 USB 측정 확인 (자동 감시 설정 안 함)")
    parser.add_argument("--port", help="실제 USB 포트")
    parser.add_argument("--url", help="게시된 앱 HTTPS 주소")
    parser.add_argument("--adc-volts", type=float, default=5.0, help="측정한 UNO AVcc. 기본 5.0은 근삿값")
    args = parser.parse_args()
    try:
        import serial
        from serial.tools import list_ports
    except ImportError:
        raise BridgeError("먼저 설치 안내대로 pyserial을 설치해 주세요.") from None
    if args.ports:
        for port in list_ports.comports():
            print(port.device, port.description)
        return
    if not math.isfinite(args.adc_volts) or not 4.5 <= args.adc_volts <= 5.5:
        raise BridgeError("5V UNO용이에요. 보드와 기준 전압을 확인해 주세요.")
    port = args.port or input("아두이노 USB 포트: ").strip()
    app = None
    if not args.inspect:
        origin = app_origin(args.url or input("게시된 집온 앱 HTTPS 주소: "))
        key = getpass.getpass("기기 연결 키 (가족 비밀번호 아님, 입력은 숨겨져요): ").strip()
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise BridgeError("기기 관리에서 발급한 연결 키를 입력해 주세요.")
        app = App(origin, key)
    try:
        connection = serial.Serial(port, 115200, timeout=0.1, write_timeout=1)
    except (serial.SerialException, ValueError):
        raise BridgeError("USB 포트·케이블을 확인하고 시리얼 모니터를 닫아 주세요.") from None
    board = Board(connection, args.adc_volts)
    try:
        board.start()
        print("V3 USB 연결됨. 가스 감시는 예열·기준 확인 후 이번 연결에서 직접 켜 주세요. Ctrl+C로 종료해요.")
        relay, sent, next_network = Relay(app, board), None, 0
        while not board.dead.wait(0.1):
            latest = board.fresh()
            if not latest:
                board.send("MANUAL_OFF")
                continue
            _, sample = latest
            if sent != sample["sampleId"]:
                sent = sample["sampleId"]
                print(f"MQ-135 ADC {sample['gasAdc']} · {sample['gasVoltageV']} V · 거리 {sample['distanceCm']} cm · 문 {sample['board']['doorStatus']} · 출력 감시 {sample['board']['gasStatus']}")
                if sample["gasAdc"] in (0, 1023):
                    print("ADC 범위 끝값이에요. 배선·전원·센서를 확인해 주세요. 안전하다는 뜻이 아니에요.")
            if not app or time.monotonic() < next_network:
                continue
            next_network = time.monotonic() + 2
            try:
                relay.collect()
                # Completion calls may have waited on the network: select the
                # newest USB measurement AGAIN, never post the old local copy.
                pending = relay.prepare()
                if pending is None:
                    board.send("MANUAL_OFF")
                    continue
                started = time.monotonic()
                response = app.request("/telemetry", pending)
                relay.pending = None
                relay.synchronize(response, started)
            except AppRefused:
                raise
            except BridgeError as error:
                board.send("MANUAL_OFF")
                print(str(error))
                print("원격 제어는 중단돼요. 보드 전원이 남으면 적용된 자동 반응은 계속될 수 있어요. 연결을 재시도해요.")
        raise BridgeError("USB가 끊겼거나 보드가 재시작됐어요. 연결 프로그램을 다시 실행해 주세요.")
    finally:
        board.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("원격 연결을 종료했어요. 보드 전원이 남으면 자동 반응은 계속돼요. 실제 출력을 확인해 주세요.")
    except BridgeError as error:
        print(str(error))
        raise SystemExit(1)
    except Exception:
        print("연결을 중단했어요. USB·인터넷·설치 안내와 실제 출력을 확인해 주세요.")
        raise SystemExit(1)
