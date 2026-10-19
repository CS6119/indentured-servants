import os
import subprocess
import sys

from filelock import FileLock


def test_demo_ignores_live_mode_and_is_idempotent(tmp_path):
    env = dict(os.environ, RAFFLEYE_SOURCE="x", RAFFLEYE_EXTRACTOR="openai", RAFFLEYE_APIFY_FALLBACK="true")
    for _ in range(2):
        result = subprocess.run(
            [sys.executable, "-m", "raffleye.cli", "demo"],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert '"giveaways": 4' in result.stdout
        assert '"usage_today": {}' in result.stdout
    assert (tmp_path / "data/demo-embeds.json").exists()


def test_second_writer_is_rejected(tmp_path):
    target = tmp_path / "data/demo.sqlite3"
    target.parent.mkdir()
    with FileLock(str(target) + ".lock"):
        result = subprocess.run(
            [sys.executable, "-m", "raffleye.cli", "demo"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert result.returncode == 1
        assert "Another RAFFLEYE process" in result.stderr
