import { inWindows, finite } from "./model.mjs";

// Calendar decisions stay in the browser. The UNO has no wall clock.
export class DistanceAnalysis {
  constructor() { this.reset(); }
  reset() { this.values = []; this.candidate = null; this.since = 0; this.stable = null; this.normalSeen = false; this.alarm = false; this.cooldownUntil = 0; this.allowed = null; }
  update(sample, settings, wallNow, monoNow) {
    const i = settings.intrusion, previousAlarm = this.alarm;
    if (!i.enabled || !finite(sample.distanceCm, 2, 400)) {
      this.values = []; this.candidate = this.stable = null; this.normalSeen = false; this.alarm = false; this.allowed = null;
      return { alarm: false, changed: null, event: previousAlarm ? "intrusion_stopped" : null, valid: false };
    }
    this.values.push(sample.distanceCm); if (this.values.length > 3) this.values.shift();
    const sorted = [...this.values].sort((a, b) => a - b), distance = sorted[Math.floor(sorted.length / 2)];
    const delta = Math.abs(distance - i.baselineCm);
    const changed = delta >= i.deltaCm ? true : delta < i.deltaCm * .6 ? false : this.stable;
    const allowed = inWindows(i.allowedWindows, wallNow);
    if (this.allowed !== allowed) { this.allowed = allowed; this.candidate = null; }
    if (changed === null) { this.candidate = null; return { alarm: false, changed: null, event: null, valid: true, allowed, distance }; }
    if (this.candidate !== changed) { this.candidate = changed; this.since = monoNow; }
    const hold = changed ? i.holdSeconds : i.recoverySeconds;
    let doorEvent = null;
    if (monoNow - this.since >= hold * 1000) {
      const before = this.stable;
      this.stable = changed;
      if (!changed) this.normalSeen = true;
      if (before !== null && before !== changed) doorEvent = changed ? "door_open" : "door_closed";
      if (allowed || !changed) this.alarm = false;
      else if (this.normalSeen && !this.alarm && monoNow >= this.cooldownUntil) { this.alarm = true; this.cooldownUntil = monoNow + i.cooldownSeconds * 1000; }
    }
    if (allowed) this.alarm = false;
    return { alarm: this.alarm, changed: this.stable, event: this.alarm !== previousAlarm ? this.alarm ? "intrusion_alert" : "intrusion_clear" : null, doorEvent, valid: true, allowed, distance };
  }
}
