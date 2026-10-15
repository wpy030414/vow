@echo off
rem attach-more2.cmd — 叠加挂载 v4 脚本（module observer + HMAC 全 API）到 iFlyPlatform
cd /d "%~dp0..\.."
echo [%date% %time%] attach-more2 begin > scripts\recon\attach-more2.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyPlatform.exe >> scripts\recon\attach-more2.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\attach-more2.log 2>&1
