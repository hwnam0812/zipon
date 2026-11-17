-- 배포 때 BAZE 가 이 파일을 D1 에 적용한다. 바꿀 때는 기존 표를 지우지 말고 더하기만 한다.
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- 소유자가 /admin 에서 바꾸는 값(src/content.ts 의 settings). value 는 JSON. 없으면 content.ts 의 기본값.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

-- _base 의 /admin 견본이 쓰는 문의 표. 새 템플릿은 자기 표로 바꾸거나 지운다(아직 배포 전일 때만).
CREATE TABLE IF NOT EXISTS inquiry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 현재 앱은 family 범위만 사용한다. 과거의 다른 범위 기록은 삭제하거나 옮기지 않는다.
-- home_settings.value 안의 quietWindows에 여러 안심 시간을 저장한다. 기존 단일 시간은 읽을 때 호환한다.
CREATE TABLE IF NOT EXISTS home_settings (
  scope TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS home_state (
  scope TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_packet TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS home_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  emergency INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS home_events_scope_time ON home_events(scope, created_at DESC);
CREATE TABLE IF NOT EXISTS home_alerts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS home_alerts_scope_time ON home_alerts(scope, created_at DESC);
CREATE TABLE IF NOT EXISTS home_devices (
  scope TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS home_commands (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS home_commands_scope_time ON home_commands(scope, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS home_one_active_siren ON home_commands(scope) WHERE action = 'start' AND status IN ('pending', 'acknowledged');

-- V3 독립 출력 제어. 구형 사이렌 요청과 기록은 수정·삭제하지 않는다.
CREATE TABLE IF NOT EXISTS home_output_commands (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  session TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS home_output_scope_time ON home_output_commands(scope, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS home_output_one_pending ON home_output_commands(scope, target) WHERE status IN ('pending', 'claimed');

-- 재시작 전 USB 세션의 늦은 전송을 최신 연결로 되살리지 않는다.
CREATE TABLE IF NOT EXISTS home_device_sessions (
  scope TEXT NOT NULL,
  session TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, session)
);
