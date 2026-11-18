"""Browser-test entrypoint: explicitly isolated credentials and storage, never production."""
import os
from pathlib import Path
import runpy
import sys
import time

os.environ["ADMIN_TOKEN"] = os.environ["ZIPON_BROWSER_TEST_PASSWORD"]
os.environ["DATABASE_URL"] = ""
os.environ["ZIPON_DEV_DB"] = os.environ["ZIPON_BROWSER_TEST_DB"]
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from zipon_streamlit.storage import SqlStore
if not hasattr(SqlStore, "_zipon_original_snapshot"):
    SqlStore._zipon_original_snapshot = SqlStore.snapshot
def controlled_snapshot(self):
    path = os.environ.get("ZIPON_BROWSER_TEST_LATENCY")
    state = Path(path).read_text() if path and Path(path).exists() else ""
    if state == "slow": time.sleep(3)
    if state == "fail": raise RuntimeError("isolated-storage-failure")
    return self._zipon_original_snapshot()
SqlStore.snapshot = controlled_snapshot
runpy.run_path(str(root / "streamlit_app.py"), run_name="__main__")
