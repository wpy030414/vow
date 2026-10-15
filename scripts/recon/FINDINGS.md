# iflytek-api 侦察结论（讯飞输入法私有 ASR 协议）

> 侦察日期：2026-10-15 ｜ 工具链：frida 17.23（提权附加 iFlyVoice.exe，libssl-3/libcrypto-3 双钩 + 内存扫描）
> 状态：**协议完全逆向 + 自建客户端回放验证通过。** 引擎可直接开建，无剩余未知数。

## 一、端点与鉴权（已实证）

| 项 | 值 |
|----|-----|
| 端点 | `wss://100ime-iat-api.xfyun.cn/v2/iat` |
| 鉴权位置 | Query 参数 `authorization`（Base64 的 `hmac username="…", algorithm="hmac-sha256", headers="host date request-line", signature="…"`）|
| api_key | `15461402826c8360ebcf1270cbba88e5`（输入法内置，内存中随 `que_user` 键存储）|
| api_secret | `sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB`（同址内存提取，**已用真实会话签名验证**）|
| 签名算法 | `base64(HMAC-SHA256(secret, "host: 100ime-iat-api.xfyun.cn\ndate: <RFC1123 GMT>\nGET /v2/iat HTTP/1.1"))`（无尾换行；已验证复现真实会话签名）|
| WS 子协议 | 客户端发 `dumb-increment-protocol` 头，**服务端不回显**（不可走严格协商，ws 包需手动发头）|
| 网关 | Kong 1.3.0 |

## 二、WebSocket 帧协议（已 100% 明文验证）

### 客户端 → 服务端（JSON 文本帧）

**首帧**（business + common + 首块音频，合并一帧，`status:1`；**无独立 status:0 帧**）：

```json
{
  "business": {"aue": "opus-wb", "ent": "sms16k", "eos": 4000, "vad_enable": true, "vad_speech_tail": 4000, "vad_timeout": 4000},
  "common": {"app_id": "100IME", "app.ver": "3.0.1750", "device.imei": "…", "device.imsi": "…", "device_id": "…", "uid": "261015230534696411"},
  "data": {"audio": "<base64>", "encoding": "opus-wb", "format": "audio/L16;rate=16000", "status": 1}
}
```

**后续帧**：仅 `{"data": {audio, encoding, format, status:1}}`；**尾帧** `status:2`（携末块音频）。
共 96 帧 ≈ 7.7 秒语音（帧间隔 ~80ms）。

> **音频容器结构（实证）**：`data.audio` 解码后为 `[2B BE 长度][opus 包]` 循环（残余 0），
> 每包 40ms@16k（640 样本），每 JSON 块 ≈ 2 包 = 80ms。**且实测 `encoding:"raw"` 直发
> PCM16LE@16k 被服务端接受（回放转写逐字一致）→ vow 引擎无需 opus 编码器。**

### 服务端 → 客户端（JSON 文本帧）

**流式**：`{"code":0,"message":"success","sid":"iat…","data":{"result":{"sn":N,"ls":false,"ws":[{"cw":[{"w":"字",…}]}]},"status":0}}`
**终止**：`{"…","data":{"result":{"sn":N+1,"ls":true,"ws":[{"cw":[{"w":"。"}],"ver":"1.3.2.9.6.52\r"}]},"status":2}}`

- `ws[].cw[].w` = 逐字识别；`lg` = 口音识别；`ls:true` + `status:2` = 结束

## 三、验证记录

- **签名验证**：`verify-secret.mjs` 用提取的 secret 精确复现真实会话签名（32 字节 base64 全等）
- **回放验证**：`iflytek-probe.mjs` 自建 WebSocket 客户端（ws 包 + 手动子协议头），重放捕获的 96 帧真实音频 → 服务端返回转写「好的，我又说了一句话。」与实况逐字一致 ✅

## 四、vow `iflytek-api` 引擎实现要点（已落地，见 apps/server/src/services/iflytek-asr.ts）

1. **凭证明文入 .env**（`VOW_IFLYTEK_API_KEY` / `VOW_IFLYTEK_API_SECRET`），零输入法依赖
2. 服务端消费 vow PCM（44100 base64）→ 16k 线性重采样 → 80ms 分帧 → raw JSON 帧推流（背压保护 512KB）
3. ✅ 已实证：`encoding:"raw"` PCM16 直发被接受——免 Opus 依赖
4. 转写文本：终稿经 SendInput（`KEYEVENTF_UNICODE`）打入焦点窗口（不回显手机端）
5. `uid` 生成复刻实况样式（`YYMMDDhhmmss`+序列）；device_id 进程内随机生成
6. 单测含签名 golden 向量（真实会话复现）、重采样/分帧/类型转换、会话状态机（假 ws）

## 五、合规备注

以上凭据源自对用户本机已安装软件的互操作分析，仅供本机个人使用；源客户端升级可能更换凭据或协议（用户已知悉并接受该维护成本）。
