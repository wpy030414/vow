@echo off
rem attach-more.cmd — 不杀旧进程，叠加挂载 v3 脚本（HMAC 钓取 + 帧解掩码）到 iFlyPlatform
rem 输出到全新文件 attach-more.log，避开旧驱动持有的 driver-out.log（重定向撞锁会导致整行静默跳过）
cd /d "%~dp0..\.."
echo [%date% %time%] attach-more begin > scripts\recon\attach-more.log 2>&1
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" scripts\recon\driver.py iFlyPlatform.exe >> scripts\recon\attach-more.log 2>&1
echo [%date% %time%] driver exited %errorlevel% >> scripts\recon\attach-more.log 2>&1
