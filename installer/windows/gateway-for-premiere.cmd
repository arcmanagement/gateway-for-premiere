@echo off
setlocal
set "GATEWAY_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "GATEWAY_ARCH=arm64"
"%~dp0..\runtime\%GATEWAY_ARCH%\node.exe" "%~dp0..\app\dist\cli\index.js" %*
exit /b %ERRORLEVEL%
