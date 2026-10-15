@echo off
rem attach-more4.cmd — v5 脚本（内存扫 api_key 现场 + EVP_MAC 钩子）挂 iFlyVoice
cd /d "%~dp0..\.."
echo [%date% %time%] attach-more4 begin > scripts\recon\attach-more4.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyVoice.exe >> scripts\recon\attach-more4.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\attach-more4.log 2>&1
