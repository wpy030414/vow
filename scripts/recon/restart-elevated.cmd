@echo off
rem restart-elevated.cmd — 杀旧的提权采集进程，重新拉起 frida driver（一次 UAC）
rem 全量输出重定向到 driver-out.log，挂了也能看到死因
cd /d "%~dp0..\.."
echo [%date% %time%] restart begin >> scripts\recon\driver-out.log 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*driver.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >> scripts\recon\driver-out.log 2>&1
echo [%date% %time%] old killed, starting driver >> scripts\recon\driver-out.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyPlatform.exe iFlyVoice.exe iFlyInput.exe >> scripts\recon\driver-out.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\driver-out.log 2>&1
