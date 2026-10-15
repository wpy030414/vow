@echo off
rem attach-more3.cmd — 叠加挂载 v4 脚本到全部三个讯飞进程
rem 关键：libssl/libcrypto 在 iFlyVoice 里惰性加载，module observer 负责载入瞬间挂钩
cd /d "%~dp0..\.."
echo [%date% %time%] attach-more3 begin > scripts\recon\attach-more3.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyPlatform.exe iFlyVoice.exe iFlyInput.exe >> scripts\recon\attach-more3.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\attach-more3.log 2>&1
