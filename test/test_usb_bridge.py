"""No serial port, actual key, family record, or external network is used."""
import copy
import importlib.util
from pathlib import Path
import queue
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("zipon_bridge", Path(__file__).resolve().parents[1] / "hardware/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
SID = "a" * 32
CID = "12345678-1234-1234-1234-123456789abc"
CONFIG = {"revision": "1" * 16, "closedMm": 120, "toleranceMm": 80, "doorHoldMs": 1000, "doorCalibrated": True,
    "doorSignals": True, "gasEnabled": False, "baselineAdc": 100, "riseAdc": 100, "gasHoldMs": 10000}


def report(seq=1, adc=100, mm=120, door="C", gas="0", alarm="0", led="0", buzzer="0", ls="N", bs="N", mute=0, off_l=0, off_b=0, rev="0" * 16):
    return f"R {SID} {seq} {seq*2000} {adc} {mm} {door} {gas} {alarm} {led} {buzzer} {ls} {bs} {mute} {off_l} {off_b} {rev}"


class FakeBoard:
    def __init__(self, log):
        self.log, self.session, self.events, self.board_events, self.connected = log, SID, queue.Queue(), queue.Queue(), True
        self.sample = bridge.sample_payload(report(), SID, 5)

    def fresh(self):
        return (time.monotonic(), self.sample) if self.connected else None

    def send(self, text):
        self.log.append(("usb", text))


class FakeApp:
    def __init__(self, log):
        self.log, self.grant = log, {"ok": True, "alreadyClaimed": False}

    def request(self, path, body=None):
        self.log.append(("app", path, body))
        return self.grant


class UsbBridgeTests(unittest.TestCase):
    def setUp(self):
        self.log = []
        self.board, self.app = FakeBoard(self.log), FakeApp(self.log)
        self.relay = bridge.Relay(self.app, self.board)

    def command(self, **change):
        return {"id": CID, "target": "buzzer", "action": "on", "seconds": 5, "session": SID,
            "expires_at": "2026-11-17T00:00:15+00:00", **change}

    def run_command(self, **change):
        self.relay.command(self.command(**change), "2026-11-17T00:00:00+00:00", time.monotonic())

    def test_https_origin_and_no_embedded_key_paths(self):
        self.assertEqual(bridge.app_origin("https://example.invalid/"), "https://example.invalid")
        for value in ["http://example.invalid", "https://key@example.invalid", "https://example.invalid/devices", "https://example.invalid/?key=a", "https://example.invalid/#key"]:
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                bridge.app_origin(value)

    def test_redirects_are_never_followed(self):
        self.assertIsNone(bridge.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid"))

    def test_raw_voltage_not_density_and_separate_board_state(self):
        sample = bridge.sample_payload(report(adc=512, mm=123), SID, 5)
        self.assertEqual(sample["sampleId"], SID + ":1")
        self.assertEqual(sample["protocol"], bridge.PROTOCOL)
        self.assertEqual(sample["gasAdc"], 512)
        self.assertIsNone(sample["dustUgM3"])
        self.assertAlmostEqual(sample["gasVoltageV"], 2.5024)
        self.assertEqual(sample["distanceCm"], 12.3)
        self.assertEqual(sample["board"]["doorStatus"], "closed")
        self.assertFalse(sample["board"]["ledOn"])

    def test_failed_measurement_is_null_not_normal_or_open(self):
        sample = bridge.sample_payload(report(adc=-1, mm=-1, door="U", gas="4", alarm="1"), SID, 5)
        self.assertIsNone(sample["gasAdc"])
        self.assertIsNone(sample["gasVoltageV"])
        self.assertIsNone(sample["distanceCm"])
        self.assertTrue(sample["board"]["gasAlarm"])
        self.assertEqual(sample["board"]["gasStatus"], "fault")

    def test_endpoints_and_measured_adc_reference_are_preserved(self):
        for adc in [0, 1, 1022, 1023]:
            sample = bridge.sample_payload(report(adc=adc), SID, 4.98)
            self.assertEqual(sample["gasAdc"], adc)
            self.assertAlmostEqual(sample["gasVoltageV"], round(adc * 4.98 / 1023, 4))

    def test_foreign_old_malformed_and_inconsistent_packets_are_ignored(self):
        invalid = [report().replace(SID, "b"*32), report(seq=0), report(adc=-2), report(adc=1024), report(mm=0), report(mm=4001), report()+" extra",
            report(mm=-1, door="O"), report(adc=0, gas="1"), report(gas="3", alarm="0"), report(led="1", ls="N"), report(mute=61),
            report(rev="bad"), f"G {SID} 1 512 120", f"S {SID} 1 512 120"]
        for line in invalid:
            with self.subTest(line=line):
                self.assertIsNone(bridge.sample_payload(line, SID, 5))

    def test_stale_measurement_is_not_fresh(self):
        board = bridge.Board(None)
        board.latest = (time.monotonic() - 4, {"sampleId": "old"})
        self.assertIsNone(board.fresh())
        board.latest = (time.monotonic(), {"sampleId": "new"})
        self.assertEqual(board.fresh()[1]["sampleId"], "new")

    def test_configuration_is_validated_before_serial_send(self):
        self.assertEqual(bridge.configuration_line(CONFIG, SID), f"CFG {SID} {'1'*16} 120 80 1000 1 1 0 100 100 10000")
        for change in [{"doorHoldMs": 999}, {"gasEnabled": 1}, {"riseAdc": 1.5}, {"revision": "bad"}, {"gasEnabled": True, "baselineAdc": 1000}]:
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError):
                bridge.configuration_line({**CONFIG, **change}, SID)

    def test_repeated_applied_configuration_is_not_sent_again(self):
        response = {"ok": True, "protocol": bridge.PROTOCOL, "config": CONFIG, "commands": []}
        self.relay.synchronize(response, time.monotonic())
        self.assertTrue(self.log[0][1].startswith("CFG "))
        self.log.clear()
        self.board.sample["board"]["configRevision"] = CONFIG["revision"]
        self.relay.synchronize(response, time.monotonic())
        self.assertEqual(self.log, [])

    def test_claim_then_usb_but_no_execution_ack_before_board_ack(self):
        self.run_command()
        self.assertEqual(self.log[0], ("app", f"/outputs/{CID}/claim", {"session": SID}))
        self.assertEqual(self.log[1], ("usb", f"SET {SID} {CID} B ON 5"))
        self.relay.collect()
        self.assertEqual(len(self.log), 2)
        self.board.events.put((CID, "APPLIED"))
        self.relay.collect()
        self.assertEqual(self.log[-1], ("app", f"/outputs/{CID}/ack", {"session": SID, "status": "applied"}))

    def test_duplicate_command_never_replays(self):
        self.run_command()
        self.run_command()
        self.assertEqual(len(self.log), 2)

    def test_previously_or_ambiguously_claimed_command_never_activates(self):
        for grant in [{"ok": True, "alreadyClaimed": True}, {"ok": True}, {"ok": False}]:
            self.relay = bridge.Relay(self.app, self.board)
            self.app.grant = grant
            self.run_command()
        self.assertFalse(any(item[0] == "usb" for item in self.log))

    def test_network_failure_after_claim_is_not_retried_for_activation(self):
        with patch.object(self.app, "request", side_effect=bridge.BridgeError("인터넷 실패")):
            with self.assertRaises(bridge.BridgeError):
                self.run_command()
        self.run_command()
        self.assertEqual(self.log, [])

    def test_expired_and_stale_requests_never_claim_or_activate(self):
        self.run_command(expires_at="2026-11-16T23:59:59+00:00")
        self.board.connected = False
        self.run_command()
        self.assertEqual(self.log, [])

    def test_stale_after_network_wait_cancels_manual_not_auto(self):
        def delayed(*args):
            self.board.connected = False
            return {"ok": True, "alreadyClaimed": False}
        with patch.object(self.app, "request", side_effect=delayed):
            self.run_command()
        self.assertEqual(self.log, [("usb", "MANUAL_OFF")])

    def test_duration_target_session_and_identifier_validation(self):
        for change in [{"seconds": 16}, {"seconds": True}, {"seconds": "5"}, {"id": "bad\nSET"}, {"session": "b"*32},
            {"target": "alarm"}, {"action": "off", "seconds": 0}, {"action": "test", "seconds": 3}]:
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError):
                self.run_command(**change)
        self.assertEqual(self.log, [])

    def test_led_buzzer_and_pause_have_distinct_serial_commands(self):
        for target, action, seconds, serial in [("led", "on", 10, "L ON 10"), ("buzzer", "off", 30, "B OFF 30"), ("alarm", "mute", 60, "A MUTE 60"), ("alarm", "resume", 0, "A RESUME 0")]:
            self.relay = bridge.Relay(self.app, self.board)
            self.run_command(target=target, action=action, seconds=seconds)
            self.assertEqual(self.log[-1], ("usb", f"SET {SID} {CID} {serial}"))

    def test_unknown_board_ack_cannot_complete_an_app_request(self):
        self.board.events.put((CID, "APPLIED"))
        self.relay.collect()
        self.assertEqual(self.log, [])

    def test_rejected_board_ack_is_not_success(self):
        self.run_command()
        self.board.events.put((CID, "REJECTED"))
        self.relay.collect()
        self.assertEqual(self.log[-1][2]["status"], "rejected")

    def test_ack_retries_do_not_repeat_usb_and_cancelled_request_cannot_revive(self):
        self.run_command()
        self.board.events.put((CID, "APPLIED"))
        with patch.object(self.app, "request", side_effect=bridge.BridgeError("네트워크 실패")):
            with self.assertRaises(bridge.BridgeError):
                self.relay.collect()
        self.assertIn(CID, self.relay.results)
        with patch.object(self.app, "request", side_effect=bridge.AppRefused(409)):
            self.relay.collect()
        self.assertNotIn(CID, self.relay.results)
        self.assertEqual(sum(item[0] == "usb" for item in self.log), 1)

    def test_events_are_validated_and_future_event_waits_for_next_report(self):
        event = bridge.event_payload(f"E {SID} 1 3000 DOOR_OPEN 100 500", SID)
        self.assertEqual(event["kind"], "door_open")
        self.board.board_events.put(event)
        first = self.relay.prepare()
        self.assertEqual(first["boardEvents"], [])
        self.board.sample = bridge.sample_payload(report(seq=2), SID, 5)
        second = self.relay.prepare()
        self.assertEqual(second["boardEvents"], [event])
        for line in [f"E {SID} 1 3000 DOOR_OPEN 100 -1", f"E {SID} 1 3000 GAS_ALERT 0 120", f"E {SID} 0 3000 GAS_ALERT 200 120"]:
            self.assertIsNone(bridge.event_payload(line, SID))

    def test_retry_body_is_identical_until_new_measurement_and_events_follow(self):
        event = bridge.event_payload(f"E {SID} 1 1000 GAS_ALERT 250 120", SID)
        self.board.board_events.put(event)
        first = self.relay.prepare()
        self.assertIs(first, self.relay.prepare())
        self.board.sample = bridge.sample_payload(report(seq=2), SID, 5)
        second = self.relay.prepare()
        self.assertNotEqual(first["sampleId"], second["sampleId"])
        self.assertEqual(first["boardEvents"], second["boardEvents"])
        self.board.connected = False
        self.assertIsNone(self.relay.prepare())

    def test_reset_and_out_of_order_reports_stop_without_false_freshness(self):
        class Port:
            def __init__(self):
                self.lines = iter([f"READY {SID} {bridge.PROTOCOL}\n", report(seq=2)+"\n", report(seq=1)+"\n", f"BOOT {bridge.PROTOCOL}\n"])
            def read(self, _):
                return next(self.lines).encode()
        board = bridge.Board(Port())
        board.session = SID
        board.read_loop()
        self.assertTrue(board.dead.is_set())
        self.assertEqual(board.last_seq, 2)

    def test_old_firmware_cannot_handshake_or_supply_a_v3_sample(self):
        class Port:
            def __init__(self):
                self.lines = iter([f"READY {SID} ZIPON_MQ135_V2\n", f"G {SID} 1 512 120\n"])
            def read(self, _):
                return next(self.lines).encode()
        board = bridge.Board(Port())
        board.session = SID
        board.read_loop()
        self.assertFalse(board.ready.is_set())
        self.assertIsNone(board.latest)


if __name__ == "__main__":
    unittest.main()
