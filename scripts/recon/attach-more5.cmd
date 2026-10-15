@echo off
rem attach-more5.cmd — v6 脚本（全量 hex 吐流）挂 iFlyVoice，供离线帧解析
cd /d "%~dp0..\.."
echo [%date% %time%] attach-more5 begin > scripts\recon\attach-more5.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyVoice.exe >> scripts\recon\attach-more5.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\attach-more5.log 2>&1
