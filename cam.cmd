@echo off
rem Purpose: the tool's command line without a separate Node install: runs plugin\src\cam.ts with the same Node the
rem plugin uses (the one Codex ships, else node on PATH). Usage: cam install ^| uninstall ^| status ^| list ^<thread id^>
call "%~dp0plugin\scripts\launch.cmd" "%~dp0plugin\src\cam.ts" %*
