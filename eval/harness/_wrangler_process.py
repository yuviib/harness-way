"""Generic `wrangler dev` subprocess controller -- shared mechanics behind
both feed_simulator.py (origin-simulator) and run_eval.py's own management
of the gateway process. Not part of the public harness API (leading
underscore): PLAN.md's repo layout names feed_simulator.py as the
origin-specific control surface; this just avoids duplicating the same
tricky Windows process-tree handling for the gateway process too.
"""

from __future__ import annotations

import os
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Self


@dataclass
class WranglerDevConfig:
    project_dir: Path
    port: int
    node_bin_dir: Path | None = None  # see _build_env below
    ready_timeout_s: float = 20.0
    ready_poll_interval_s: float = 0.5


class WranglerDevProcess:
    def __init__(self, config: WranglerDevConfig):
        self._config = config
        self._proc: subprocess.Popen[bytes] | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._config.port}"

    def start(self) -> None:
        if self._proc is not None:
            raise RuntimeError("already running -- call stop() first")
        env = self._build_env()
        # shell=False with an explicit .cmd/.exe would be more direct, but
        # `npx` on Windows is itself a .cmd shim; invoking through the
        # shell is the reliable way to resolve it the same way a real
        # terminal would, confirmed by testing (a direct argv invocation
        # without shell=True failed to resolve npx.cmd on this machine).
        self._proc = subprocess.Popen(
            f"npx wrangler dev --port {self._config.port}",
            cwd=self._config.project_dir,
            env=env,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self._wait_until_ready()

    def stop(self) -> None:
        if self._proc is None:
            return
        # terminate() on Windows with shell=True only kills the shell
        # wrapper, not the actual node child it spawned -- confirmed by
        # testing, not assumed (the port stayed bound after terminate()
        # alone). taskkill /T kills the whole process tree.
        subprocess.run(
            ["taskkill", "/PID", str(self._proc.pid), "/T", "/F"],
            capture_output=True,
            check=False,  # taskkill fails if the process already exited -- fine, that's the goal state
        )
        self._proc.wait(timeout=10)
        self._proc = None

    def restart(self) -> None:
        self.stop()
        self.start()

    def _build_env(self) -> dict[str, str]:
        env = dict(os.environ)
        # Matches PLAN.md's own documented toolchain quirk on this machine:
        # Node 18 (too old for Wrangler) is what's on the default PATH,
        # and `nvm use` needs admin elevation this shell doesn't have --
        # so the versioned nvm install dir is prepended directly rather
        # than relying on the nvm symlink.
        if self._config.node_bin_dir is not None:
            env["PATH"] = f"{self._config.node_bin_dir}{os.pathsep}{env.get('PATH', '')}"
        return env

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + self._config.ready_timeout_s
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(self.base_url, timeout=2)
                return
            except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
                last_error = e
                time.sleep(self._config.ready_poll_interval_s)
        self.stop()
        raise TimeoutError(f"process did not become ready on {self.base_url} within {self._config.ready_timeout_s}s: {last_error}")

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()
