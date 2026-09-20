@echo off
REM 只重启：不重新构建。改代码后需要重建时用 start-9router.cmd build
call "%~dp0start-9router.cmd" %*
