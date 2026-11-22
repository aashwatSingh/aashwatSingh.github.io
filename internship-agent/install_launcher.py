"""Put a "SWE Internship Agent" shortcut on your Windows Desktop that opens Mission Control with no
PowerShell or console window, and optionally start the server silently every time you sign in.

    python install_launcher.py             # Desktop shortcut
    python install_launcher.py --startup   # also: a server-only shortcut in the Windows Startup folder,
                                           # so http://127.0.0.1:4760 works right after you log in

Standard library only. The shortcuts run Launch_Mission_Control.vbs through wscript.exe. To undo,
delete the shortcut (the Startup folder is the one that opens with  shell:startup ).
"""
from __future__ import annotations

import argparse
import ntpath
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "Launch_Mission_Control.vbs"
NAME = "SWE Internship Agent"
STARTUP_NAME = "SWE Internship Agent (server)"


def _expand(value: str, env) -> str:
    return re.sub(r"%([^%]+)%", lambda m: env.get(m.group(1), m.group(0)), value)


def _registry_desktop() -> str | None:
    """Where Windows really keeps this user's Desktop (it moves into OneDrive when backup is on)."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
            return winreg.QueryValueEx(key, "Desktop")[0]
    except (ImportError, OSError):
        return None


def desktop_dir(env=None, registry_lookup=None) -> Path:
    env = os.environ if env is None else env
    found = (registry_lookup or _registry_desktop)()
    if found:
        path = Path(_expand(found, env))
        if path.is_dir():
            return path
    home = env.get("USERPROFILE") or str(Path.home())
    candidates = [Path(env[k]) / "Desktop" for k in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial") if env.get(k)]
    candidates += [Path(home) / "OneDrive" / "Desktop", Path(home) / "Desktop"]
    for path in candidates:
        if path.is_dir():
            return path
    return Path(home) / "Desktop"


def startup_dir(env=None) -> Path:
    env = os.environ if env is None else env
    appdata = env.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def _q(text: str) -> str:
    return str(text).replace('"', '""')                    # a quote inside a VBScript string


def shortcut_script(link: str, vbs: str, arguments: str = "") -> str:
    """VBScript that saves a .lnk running `wscript.exe "<vbs>" [arguments]`, minimized, in the launcher's folder."""
    quoted = f'""{_q(vbs)}""' + (f" {_q(arguments)}" if arguments else "")
    return "\r\n".join([
        'Set sh = CreateObject("WScript.Shell")',
        f'Set lnk = sh.CreateShortcut("{_q(link)}")',
        'lnk.TargetPath = "wscript.exe"',
        f'lnk.Arguments = "{quoted}"',
        f'lnk.WorkingDirectory = "{_q(ntpath.dirname(vbs))}"',
        'lnk.Description = "Mission Control for the SWE Internship Agent"',
        "lnk.WindowStyle = 7",
        "lnk.Save",
        "",
    ])


def create_shortcut(link: Path, arguments: str = "") -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "make_shortcut.vbs"
        script.write_text(shortcut_script(str(link), str(LAUNCHER), arguments), encoding="utf-16")
        done = subprocess.run(["cscript.exe", "//nologo", str(script)], capture_output=True, text=True,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if done.returncode != 0 or not link.exists():
        raise RuntimeError((done.stdout + done.stderr).strip() or f"could not create {link}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--startup", action="store_true",
                    help="also start the server silently at every Windows sign-in (no browser opens)")
    args = ap.parse_args(argv)
    if os.name != "nt":
        print("This installer is for Windows (it makes .lnk shortcuts).", file=sys.stderr)
        return 2
    if not LAUNCHER.is_file():
        print(f"Missing {LAUNCHER.name} next to this script.", file=sys.stderr)
        return 1
    try:
        desktop = desktop_dir() / f"{NAME}.lnk"
        create_shortcut(desktop)
        print(f"Desktop shortcut: {desktop}")
        if args.startup:
            startup = startup_dir() / f"{STARTUP_NAME}.lnk"
            create_shortcut(startup, "/server-only")
            print(f"Starts at sign-in: {startup}")
    except (RuntimeError, OSError) as exc:
        print(f"Could not create the shortcut: {exc}", file=sys.stderr)
        return 1
    print("Double-click the shortcut: Mission Control opens in your browser, with no PowerShell.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
