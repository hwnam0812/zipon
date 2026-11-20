"""GitHub → Streamlit entrypoint. This process NEVER opens a user's USB port."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import uuid

import streamlit as st

from zipon_streamlit.auth import AttemptLimiter, password_matches, proof
from zipon_streamlit.screen import ScreenSession, open_service

ROOT = Path(__file__).resolve().parent
st.set_page_config(page_title="집온 · 우리 집 USB 모니터", page_icon="🏡", layout="wide", initial_sidebar_state="collapsed")
st.html("""<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');
html,body,[data-testid="stApp"] {font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif;word-break:keep-all;background:#f5f7f8;}
[data-testid="stHeader"] {display:none;}
[data-testid="stMainBlockContainer"] {padding:0!important;max-width:none!important;}
[data-testid="stVerticalBlock"] {gap:0;}
.zipon-gate {max-width:410px;margin:12vh auto 20px;text-align:left;padding:0 24px;color:#294235;}
.zipon-gate h1 {font-size:29px;font-weight:650;letter-spacing:normal;margin:15px 0 12px;}
.zipon-gate p {font-size:13px;line-height:1.9;color:#5e7258;}
[data-testid="stForm"] {max-width:410px;margin:0 auto 30px;border:1px solid #dce6d7;background:#fff;border-radius:14px;padding:24px;}
[data-testid="stForm"] label {font-size:13px;}
[data-testid="stFormSubmitButton"] button {background:#527b4c!important;color:#fff!important;border-color:#527b4c!important;min-height:44px;}
[data-testid="stFormSubmitButton"] button:hover {background:#446f40!important;}
[data-testid="stFormSubmitButton"] {margin-top:12px;}
[data-testid="stAlert"] {max-width:620px;margin:12px auto;}
[data-testid="stAlert"] p {word-break:keep-all;line-height:1.8;}
</style>""")


def setting(name):
    value = os.environ.get(name)
    if value: return value
    try: return str(st.secrets.get(name, ""))
    except Exception: return ""


@st.cache_resource(show_spinner=False)
def limiter(): return AttemptLimiter()


def component_source():
    sources = []
    for name in ("model.mjs", "analysis.mjs", "serial.mjs", "app.mjs", "entry.mjs"):
        code = (ROOT / "streamlit_ui" / name).read_text()
        code = re.sub(r"^import .+?;\s*$", "", code, flags=re.M)
        code = re.sub(r"\bexport (?=(?:const|function|class)\b)", "", code)
        sources.append(code)
    vendor = (ROOT / "streamlit_ui/vendor/chart.umd.min.js").read_text()
    return vendor + "\n" + "\n".join(sources)


@st.cache_resource(show_spinner=False)
def register_component(digest):
    return st.components.v2.component("zipon_monitor_v4", html='<div data-zipon-bootstrap role="status" style="padding:32px;color:#294235">집온 화면을 준비하고 있어요. 오래 멈춰 있다면 페이지를 새로고침해 주세요.</div>', js=component_source(), css=(ROOT / "streamlit_ui/style.css").read_text(), isolate_styles=True)


if "zipon_session_id" not in st.session_state: st.session_state.zipon_session_id = uuid.uuid4().hex
secret = setting("ADMIN_TOKEN")
expected = proof(secret, st.session_state.zipon_session_id) if secret else None
authenticated = bool(expected and st.session_state.get("zipon_proof") == expected)

if not authenticated:
    # No family data, component state, or store reads happen before this gate.
    st.html('<div class="zipon-gate" lang="ko"><span style="color:#527b4c;font-size:30px;font-weight:650">⌂ 집온</span><h1>우리 가족의 공간이에요</h1><p>가족 비밀번호로 우리 집 센서와 기록을 열어 주세요.<br>비밀번호는 UNO에 전달하지 않아요.</p></div>')
    if not secret:
        st.error("가족 비밀번호가 아직 설정되지 않았어요. Streamlit의 Secrets에 ADMIN_TOKEN을 설정한 뒤 다시 열어 주세요.")
        st.stop()
    try: address = str(st.context.ip_address or "unknown")
    except Exception: address = "unknown"
    rate_key = hashlib.sha256(address.encode()).hexdigest()
    with st.form("zipon_family_unlock", clear_on_submit=True):
        candidate = st.text_input("가족 비밀번호", type="password", key="zipon_password_input", max_chars=256)
        submitted = st.form_submit_button("가족 공간 열기", width="stretch")
        if submitted:
            if not limiter().allowed(rate_key): st.error("잠시 입력을 쉬어 주세요. 1분 뒤 다시 시도할 수 있어요.")
            elif password_matches(candidate, secret):
                st.session_state.zipon_proof = expected
                candidate = ""
                st.rerun()
            else:
                limiter().fail(rate_key)
                st.error("가족 비밀번호가 맞지 않아요. 다시 확인해 주세요.")
    st.stop()

if "zipon_screen" not in st.session_state:
    url, path, owner = setting("DATABASE_URL"), os.environ.get("ZIPON_DEV_DB", ""), st.session_state.zipon_session_id
    supabase_key = setting("SUPABASE_SERVICE_ROLE_KEY")
    st.session_state.zipon_screen = ScreenSession(lambda: open_service(url, path, owner, supabase_key=supabase_key))
screen = st.session_state.zipon_screen
digest = hashlib.sha256(b"".join(p.read_bytes() for p in sorted((ROOT / "streamlit_ui").glob("*.mjs"))) + (ROOT / "streamlit_ui/style.css").read_bytes()).hexdigest()
monitor = register_component(digest)


@st.fragment(run_every=1)
def family_screen():
    # Re-check on periodic reruns too, so a changed/removed secret revokes access.
    current = setting("ADMIN_TOKEN")
    if not current or st.session_state.get("zipon_proof") != proof(current, st.session_state.zipon_session_id):
        st.session_state.pop("zipon_proof", None)
        screen.close()
        st.session_state.pop("zipon_screen", None)
        st.rerun()
    notice = st.empty()
    data = screen.poll()
    if data is None:
        if screen.error:
            notice.error("가족 공간의 보관 연결을 확인하지 못했어요. 저장이나 제어를 시작하지 않았어요. 보관 연결 정보를 확인한 뒤 다시 시도해 주세요.")
            if st.button("보관 연결 다시 시도", key="zipon_storage_retry"):
                screen.close()
                st.session_state.pop("zipon_screen", None)
                st.rerun()
        else: notice.info("집온 · 저장된 설정과 기록을 불러오고 있어요. 연결이 느려도 화면을 닫을 필요는 없어요.")
        return
    if screen.reply and screen.reply.get("ok") and screen.reply.get("result", {}).get("logout"):
        screen.close()
        for key in ("zipon_proof", "zipon_screen", "zipon_password_input"):
            st.session_state.pop(key, None)
        st.rerun()
    page = st.query_params.get("page", "home")
    data["initialPage"] = page if page in ("home", "monitor", "history", "settings", "devices", "quiet-time", "gas-status", "door-status") else "home"
    result = monitor(data=data, key="zipon_family_monitor", on_request_change=lambda: None, width="stretch")
    request = result.request
    screen.enqueue(request)
    screen.poll()


family_screen()
