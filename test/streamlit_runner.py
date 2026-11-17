"""Browser-test entrypoint: explicitly isolated credentials and storage, never production."""
import os
from pathlib import Path
import runpy
import sys

os.environ["ADMIN_TOKEN"] = os.environ["ZIPON_BROWSER_TEST_PASSWORD"]
os.environ["DATABASE_URL"] = ""
os.environ["ZIPON_DEV_DB"] = os.environ["ZIPON_BROWSER_TEST_DB"]
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
runpy.run_path(str(root / "streamlit_app.py"), run_name="__main__")
