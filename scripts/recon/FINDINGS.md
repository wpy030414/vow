# iflytek-api 侦察结论（讯飞输入法私有 ASR 协议）

> 侦察日期：2026-10-15 ｜ 工具链：frida 17.23（提权附加 iFlyVoice.exe，libssl-3/libcrypto-3 双钩 + 内存扫描）
> 结论：**协议完全逆向完成，credentials 已提取并验证。** iflytek-api 引擎可直接开建。

## 一、端点与鉴权（已实证）

| 项 | 值 |
|----|-----|
| 端点 | `wss://100ime-iat-api.xfyun.cn/v2/iat` |
| 鉴权位置 | Query 参数 `authorization`（Base64 的 `hmac username="…", algorithm="hmac-sha256", headers="host date request-line", signature="…"`）|
| api_key | `15461402826c8360ebcf1270cbba88e5`（输入法内置，内存中随 `que_user` 键存储）|
| api_secret | `sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB`（同址内存提取，**已用真实会话签名验证**）|
| 签名算法 | `base64(HMAC-SHA256(secret, "host: 100ime-iat-api.xfyun.cn\ndate: <RFC1123 GMT>\nGET /v2/iat HTTP/1.1"))`（无尾换行；已验证复现 2026-10-15 15:28:44 会话签名）|
| WS 子协议 | `dumb-increment-protocol` |
| 网关 | Kong 1.3.0（`X-Kong-Upstream-Latency` 等回包头）|
| 服务端版本指纹 | 客户端 `1.3.2.9.6.52`；识别引擎 `SLSpeechRecognizeCellEngine3`；`ver` 字段回显 |

## 二、WebSocket 帧协议（TLS 明文捕获）

### 客户端 → 服务端（JSON 文本帧）

```json
{"data": {"audio": "<base64>", "encoding": "opus-wb", "format": "audio/L16;rate=16000", "status": 0|1|2}}
```

- 音频编码：**Opus 宽频**（opus-wb），采样率基准 16000
- `status`：0=首帧(携带 common/business)、1=传输中、2=结束
- 首帧的 common/business 体（app_id 等）尚未捕获明文（缓冲粘连）→ **下一次会话补齐**

### 服务端 → 客户端（JSON 文本帧）

```json
{"code":0,"message":"success","sid":"iat…","data":{"status":0|1|2,"result":{"sn":N,"ls":bool,"bg":0,"ed":0,"ws":[{"cw":[{"w":"字","wc":1,"wp":"n","lg":"tianjin",…}]}]}}}
```

- `ws[].cw[].w` = 逐字识别结果；`sn` 递增序号；`ls:true` + `status:2` = 结束帧

## 三、宿主进程架构

- **iFlyVoice.exe**：语音引擎 + TLS 出口（libssl-3/libcrypto-3 惰性加载），会随语音面板启停而重启（PID 漂移）
- iFlyPlatform.exe：网络聚合器（与 Voice 走 loopback），本连接不涉及 libssl
- 配置记忆区含：`que_user`(api_key)、secret、设备指纹 `LRPC-fafa9621935f1a7cd0`

## 四、vow `iflytek-api` 引擎实现要点

1. **凭证明文入 .env**（`VOW_IFLYTEK_API_KEY` / `VOW_IFLYTEK_API_SECRET`），不再依赖输入法运行时
2. 服务端直接消费 vow 的 PCM 流（16k 重采样）→ Opus 编码（推荐 `opusscript`，纯 JS 免编译）→ WS 推送
3. 转写文本 → SendInput（`KEYEVENTF_UNICODE` 逐字符）打入焦点窗口；或先打到 vow 前端预览
4. 待办：首帧 common/business 结构（下次真实会话抓明文）；`encoding:"raw"`(PCM) 是否也被接受（若可，直接省掉 Opus）

## 五、合规备注

以上凭据源自对用户本机已安装软件的互操作分析，仅供本机个人使用；源客户端升级可能更换凭据或协议（用户已知悉并接受该维护成本）。
