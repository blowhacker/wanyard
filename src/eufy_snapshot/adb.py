from __future__ import annotations

import subprocess
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
