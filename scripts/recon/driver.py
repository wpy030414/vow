# driver.py v2 — frida 采集驱动
# - send()/log/error 全类型消息转发
# - 自动重挂线：目标进程重启（PID 变化）后自动重新 attach
import sys
import time

import frida

names = sys.argv[1:] or ['iFlyPlatform.exe']
with open('scripts/recon/ifly-ssl-hook.js', encoding='utf-8') as f:
    HOOK_SRC = f.read()

LOG = open('scripts/recon/capture.log', 'a', encoding='utf-8', buffering=1)
LOG.write(f'\n===== session start {time.strftime("%Y-%m-%d %H:%M:%S")} =====\n')


def log(msg: str) -> None:
    print(msg, flush=True)
    LOG.write(str(msg) + '\n')


def fmt(payload):
    if isinstance(payload, dict):
        return f"[{payload.get('tag', '?')}] {payload.get('text', '')}"
    return str(payload)


def on_message(m, _data, name=''):
    t = m.get('type')
    if t in ('log', 'send'):
        log(f'[{name}] {fmt(m.get("payload"))}')
    elif t == 'error':
        log(f'[{name}] ERROR {m.get("description")}\n{m.get("stack", "")}')
    else:
        log(f'[{name}] {m}')


device = frida.get_local_device()
attached_pid = {}


def try_attach(name):
    try:
        pid = device.get_process(name).pid
    except Exception:
        if attached_pid.pop(name, None) is not None:
            log(f'[driver] {name} 已退出，等待重启……')
        return
    if attached_pid.get(name) == pid:
        return
    try:
        session = device.attach(pid)
        script = session.create_script(HOOK_SRC)
        script.on('message', lambda m, d, n=name: on_message(m, d, n))
        script.load()
        attached_pid[name] = pid
        log(f'[driver] attached: {name} (pid {pid})')
    except Exception as e:  # noqa: BLE001
        log(f'[driver] attach failed {name} (pid {pid}): {e}')


for n in names:
    try_attach(n)

log('[driver] 采集中（进程重启自动重挂）——现在用讯飞语音说一句话……')
while True:
    time.sleep(2)
    for n in names:
        try_attach(n)
