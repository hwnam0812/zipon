# 집온 · GitHub와 Streamlit 실행 안내

## 어떤 코드인가요?

`streamlit_app.py`가 새 실행 파일이에요. `zipon_streamlit/`는 비밀번호 확인·설정·기록 보관을 담당하고, `streamlit_ui/`는 브라우저의 USB 통신·시간표 판정·Chart.js 그래프·화면을 담당해요. 화면은 iframe 없는 Streamlit v2 사용자 정의 화면으로 실행돼요. npm 개발 서버나 현재 BAZE 미리보기 주소에 의존하지 않아요. Chart.js 공개 배포본은 함께 포함돼 있어 외부 그래프 CDN에 의존하지 않아요.

기존 `src/`, `worker/`, `schema.sql`, V3 스케치·Python 중계는 보존했어요. 새 Streamlit이 기존 Worker를 자동 실행하거나 기존 기록을 자동 이전하지는 않아요. 새 직접 USB 연결에는 반드시 V4 스케치를 함께 사용해요.

## 1. GitHub에 등록해요

사용자가 지정한 저장소는 [hwnam0812/zipon](https://github.com/hwnam0812/zipon)이에요. 공개 저장소이므로 코드만 등록하고 실제 비밀번호·측정·가족 기록은 넣지 않아요. Streamlit에서 실행할 코드는 `main`에서 선택해요.

파일 탭의 `zipon-streamlit-source.zip`은 공개 소스·안내·검사 코드만 담도록 명시적인 허용 목록으로 만들어요. 압축을 풀어 원하는 GitHub 저장소에 등록할 수 있어요. 기존 저장소라면 기본 브랜치를 직접 덮지 말고 별도 브랜치에서 변경을 검토해요.

다음은 등록하지 않아요: 실제 가족 기록·내보낸 자료·업로드, 비밀번호·기기 키, `.env*` 비밀 파일, `.dev.vars`, `.streamlit/secrets.toml`, `.venv`, `.wrangler`, 실행 중 만든 저장 파일, `node_modules`, 앱 빌드 결과. 비밀값은 코드에 쓰지 않아요. `.gitignore`도 확인해요. ZIP의 안내용 이름과 변수 이름은 실제 비밀값이 아니에요.

GitHub 자체를 이벤트 저장소로 사용하거나 측정을 자동 커밋하지 않아요.

## 2. Streamlit에서 실행해요

Streamlit Community Cloud에서 **Create app → GitHub 저장소·브랜치·실행 파일 선택**으로 진행해요. 실행 파일은 루트의 `streamlit_app.py`예요. Python 3.12를 권장하며, 확인한 Streamlit 버전은 `requirements.txt`에 고정했어요.

Advanced settings의 Secrets에 다음 **변수 이름에 해당하는 실제 값**을 설정해요. 값은 저장소나 채팅에 붙이지 않아요.

| 이름 | 용도 |
|---|---|
| `ADMIN_TOKEN` | 가족 비밀번호. 없으면 가족 공간을 열지 않음 |
| `DATABASE_URL` | 외부 PostgreSQL 연결 주소. 외부 연결은 TLS 필수 |

현재 BAZE 프로젝트에 설정한 값은 Streamlit으로 자동 복사되지 않아요. Streamlit의 관리 화면에서 직접 설정해야 해요. 가족 비밀번호를 바꾸면 열려 있던 가족 공간도 다음 연결 확인 때 다시 잠가요. 임시 접속과 코드는 실제 비밀번호·연결 주소를 브라우저의 사용자 정의 화면이나 UNO로 보내지 않아요.

`DATABASE_URL`이 없으면 **접속별 임시 보관**으로 실행해요. 화면에 영구 보관이 준비되지 않았다고 표시하고 저장 버튼도 `이번 접속에 적용`으로 구분해요. 새로고침·재접속 시 남는다고 약속하지 않아요. 저장소 연결이 실패해도 영구 저장 완료로 처리하지 않아요. 개발 미리보기의 임시 저장은 Streamlit의 영구 저장이 아니에요.

접속 가능한 PostgreSQL을 준비한 경우 연결 계정에 집온 전용 표를 만들고 읽고 쓸 권한이 필요해요. 기존 다른 표를 삭제하거나 바꾸지 않고 `zipon_`으로 시작하는 새 표만 사용해요. 원래 앱의 기록은 별도로 유지돼요. 가족 비밀번호를 공유한 사람들은 같은 저장 기록을 조회할 수 있어요. 개별 가족 계정·권한 등급은 없어요.

GitHub 코드 등록과 Streamlit 게시는 별개예요. 이 안내만으로 앱이 게시되지는 않으며 사용자의 Streamlit 계정에서 아래 실행 파일과 비밀 설정을 직접 선택해야 해요. 여기서는 사용자의 Streamlit 계정을 대신 조작하지 않아요.

## 3. 실제 UNO를 연결해요

UNO가 꽂힌 컴퓨터의 데스크톱 Chrome·Edge 계열에서 배포된 HTTPS 앱을 **직접 열고**, 가족 비밀번호를 입력해요. USB는 브라우저가 열며 Streamlit 쪽에서 `COM3` 같은 포트를 열지 않아요. 휴대폰 직접 USB나 다른 컴퓨터의 USB 원격 제어는 보장하지 않아요.

`hardware/V4-USB-설치안내.md`에 따라 스케치를 업로드하고 시리얼 모니터·기존 중계를 닫아요. 모니터링에서 USB 연결 후 실제 측정과 설정을 확인하고 감시를 각각 시작해요. 같은 집의 측정 전송은 한 화면만 맡도록 연결 소유권을 확인해요. 소유권이나 화면 연결을 잃으면 제어를 계속하지 않아요.

앱 종료·절전·통신 단절 중 출입 감시·기록·알림은 보장되지 않아요. 보드 전원이 남으면 자체 가스 경보는 지속될 수 있어요. 인증 경보기를 대체하지 않아요.

## 4. 기존 기록 이전

기기 관리에서 집온 JSON을 선택하고 **이전 기록 가져오기**를 눌러 확인해요. 한 번에 2MB·5,000건 이하여야 해요. 기존 `home_events`·`home_settings` 자료 또는 새 `zipon-family-v4` 내보내기 형식을 지원해요. 다른 범위의 기록, 연결 키·기기 정보·출력 대기 명령은 가져오지 않아요. 식별값이 같은 기록은 건너뛰며 덮어쓰지 않아요.

설정 가져오기는 별도로 선택·확인해야 하고 USB 연결을 먼저 해제해야 해요. 가져온 설정으로 감시나 예열 확인을 자동 시작하지 않아요. 새 이벤트만 최근 2,000건으로 제한하고 가져온 이전 기록은 그 제한으로 지우지 않아요. 날짜와 종류를 골라 한 번에 최대 5,000건씩 내보낼 수 있어요.

## 5. 개발 환경에서 확인

Python 환경·캐시·실행 자료는 프로젝트 밖에 둬요. `uv`를 사용할 때 예를 들면 다음과 같이 실행할 수 있어요. 아래는 **실제 비밀값을 포함하지 않은 명령 형식**이에요. 비밀번호와 연결 정보는 실행 환경이나 Git에서 제외된 비밀 설정으로 준비해요.

```sh
UV_PROJECT_ENVIRONMENT="$HOME/.cache/zipon-streamlit-venv" uv sync --frozen
UV_PROJECT_ENVIRONMENT="$HOME/.cache/zipon-streamlit-venv" uv run streamlit run streamlit_app.py
```

기존 개발 화면은 `npm run dev`가 기존 앱·기록 수신과 Streamlit 미리보기를 함께 시작해요. 원래 화면의 실시간 모니터링 메뉴에서 새 화면을 열 수 있어요. `ZIPON_DEV_DB`는 명시적인 개발용 임시 저장 경로이며, Streamlit 배포에서는 설정하지 않아요. 임시 자료를 프로젝트 안에 만들지 않아요.

## 검사와 남은 실물 확인

검사 파일은 임시 저장 공간과 임시 비밀번호·가상 USB만 사용해요. 실제 가족 기록과 실제 장치를 자동 변경하지 않아요. 검사에서 사용하는 수치는 실물 센서 측정이나 현장 검증이 아니에요. 최종 검사 개수와 실제 확인 결과는 작업 결과에 따로 명시해요.

Streamlit은 Python 격리 검사 36개, USB·감지 모델 검사 22개, V4 펌웨어 격리 검사 21개, 브라우저 검사 22개를 통과했어요. 기존 앱·USB 중계·V3 펌웨어·브라우저 회귀 검사도 유지했어요. 데스크톱과 휴대폰 폭·터치 화면, 연결 유지·재연결·제어·기록·내려받기·이전 기록·설정 충돌·잠금을 확인했어요. V4 스케치는 Arduino Uno 대상으로 컴파일했어요.

실물 USB·센서 반응·NO ECHO 원인·전원 안정성·실제 빛과 소리, 사용자의 Streamlit 계정에서 최종 배포와 USB 권한은 사용자 환경에서 확인해야 해요.

근거: [Streamlit v2 사용자 정의 화면](https://docs.streamlit.io/develop/api-reference/custom-components), [로컬 파일 보관 한계](https://docs.streamlit.io/develop/concepts/connections/connecting-to-data), [Community Cloud 배포](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy), [Secrets](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/secrets-management).
