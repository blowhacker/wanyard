from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    returncode: int


class AdbClient:
    def __init__(self, serial: str, adb_path: str = "adb") -> None:
        self.serial = serial
        self.adb_path = adb_path

    @classmethod
    def connect(
        cls,
        target: str,
        adb_path: str = "adb",
        timeout: float | None = 90,
        retry_interval: float = 2,
    ) -> CommandResult:
        deadline = None if timeout is None else time.monotonic() + timeout
        last_error = ""
        while True:
            proc = subprocess.run(
                [adb_path, "connect", target],
                capture_output=True,
                check=False,
                timeout=10,
                text=True,
            )
            output = f"{proc.stdout}\n{proc.stderr}"
            lowered = output.lower()
            if proc.returncode == 0 and not any(word in lowered for word in ("unable", "failed", "cannot")):
                return CommandResult(stdout=proc.stdout, stderr=proc.stderr, returncode=proc.returncode)

            last_error = output.strip() or f"exit code {proc.returncode}"
            if deadline is not None and time.monotonic() >= deadline:
                raise RuntimeError(f"adb connect {target} failed: {last_error}")
            time.sleep(retry_interval)

    def run(
        self,
        *args: str,
        check: bool = True,
        timeout: float | None = 30,
        text: bool = True,
    ) -> CommandResult:
        cmd = [self.adb_path, "-s", self.serial, *args]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            check=False,
            timeout=timeout,
            text=text,
        )
        stdout = proc.stdout if isinstance(proc.stdout, str) else proc.stdout.decode()
        stderr = proc.stderr if isinstance(proc.stderr, str) else proc.stderr.decode()
        if check and proc.returncode != 0:
            joined = " ".join(cmd)
            raise RuntimeError(f"{joined} failed ({proc.returncode}): {stderr.strip()}")
        return CommandResult(stdout=stdout, stderr=stderr, returncode=proc.returncode)

    def shell(self, command: str, check: bool = True, timeout: float | None = 30) -> str:
        return self.run("shell", command, check=check, timeout=timeout).stdout

    def pull(self, remote_path: str, local_path: str, timeout: float | None = 60) -> None:
        self.run("pull", remote_path, local_path, timeout=timeout)
