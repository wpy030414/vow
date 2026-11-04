# QwenNote Eva 内部实现逆向调研

> **结论先行**：Eva 的眼睛不是 Lottie / Canvas / 运行时绘制的矢量图形，而是**预渲染视频**；手机端只负责编排与通过 BLE 把视频帧推给机器人屏幕。
>
> 同时，**官方资源确认不可得**：二维码、H5 落地页、钉钉 UA 伪装、OAuth 授权、公开网关、桌面端数据目录、CDN 探测共七条路全部走完。其中 UA 伪装一度看起来打开了局面（暴露出 `meeting.dingtalk.com/fireeye/*`），但完成 OAuth 授权后发现那是「钉钉会议」的撞名路由，与 SharpEyes 无关。故 `vow` 采用参数化重绘（详见第 5 节）。
>
> - 调研时间：2026-11
> - 分析对象：
>   - 钉钉 Android `com.alibaba.android.rimet`（v9.x，34 个 dex，APK ≈ 366 MB）
> - 取证范围：APK 内的 dex 字符串表、`assets/`、`res/`；**未调用任何需登录态的云端接口**
> - 方法与边界：静态反编译 + 字符串/资源分析；不涉及抓包、不解密、不模拟登录

---

## 1. 为什么值得调研

`vow` 的 `qwennote-eva` 形态（见 [DECISIONS.md A24](../DECISIONS.md)）要还原 Eva 的屏幕观感。凭想象画眼睛会反复返工（事实也确实返工了三轮），因此先确定「真机到底怎么画的」，再决定实现路径。

调研要回答三个问题：

1. Eva 的眼睛用什么技术渲染？
2. 眼睛的几何、颜色、动画节奏是什么？
3. 能不能直接复用官方资源？

---

## 2. 命名地图：Eva 在代码里叫什么

Eva 在钉钉内部有多层代号，理解它们是继续追溯的前提。

| 层 | 代号 | 代码位置 | 说明 |
|---|---|---|---|
| 上层业务 | **SharpEyes** | `com.alibaba.android.sharpeyes.*` | 300+ 类，主业务入口 |
| 机器人底座 | **dock / idock** | `com.alibaba.dingtalk.dock.*` | 240 类，BLE 设备控制 |
| 视频渲染 | SharpEyesVideoView | `dock/video/SharpEyesVideoView` | 眼睛实际显示的位置 |
| 动画编排 | **animv2** | `sharpeyes/manager/animv2/*` | 动作序列播放 |
| 服务端资源 | **Fireeye**（火眼） | `sharpeyes/idl/model/GetFireeyeModelResource*` | 资源包下发 |
| 情绪推送 | **FieryGoldenEyes** | `idl/sync/model/FieryGoldenEyesPushMessage` | 服务端推送表情 |
| 编码内部名 | **Mozi**（墨子） | `MoziCallFieryGoldenEyesAgentModel` | 疑似会议场景分支 |
| 皮肤体系 | **skin / ThemeMatrix** | `SharpEyesSkinManager`、`sharp_eyes_theme_matrix_*` | 3 种眼睛样式 |

> 关键词：搜索 `sharpeyes`、`SharpEyes`、`fieryGoldenEyes`、`fieryeyes`、`idock`。

---

## 3. 核心结论：眼睛是预渲染视频

### 3.1 证据链

| 证据 | 出处 |
|---|---|
| 存在专用视频视图 `SharpEyesVideoView`，带 `OnFirstFrameRenderedListener` | `com/alibaba/dingtalk/dock/video/` |
| 基类 `SharpEyesBaseAnimator` 内嵌 `VideoPlaybackListener` | `sharpeyes/manager/animv2/` |
| 动作装载器叫 `ActionSequenceLoader`，单元为 `ActionSequence{name=...}` | `sharpeyes/manager/` |
| 日志：`[ACTION_PLAY][doExecute] executing frameCount=` | dex 字符串 |
| 视频路径：`AnimActionBinding{videoPath='`、`[ACTION_START] videoPath=` | dex 字符串 |
| 完成策略 `CompletionPolicy`：动作播完才释放 | `animv2/action/AnimActionBinding` |

### 3.2 播放链路

```
服务端推送表情指令
   ↓ (FieryGoldenEyesPushMessage / AgentMessage)
session/handler/*Handler（EmotionAnimConfig / ExpressionState / TransientExpression）
   ↓
ActionSequenceLoader        装载动作序列（每个动作 = 一段视频）
   ↓
ActionPlayManager           编排、调度、完成策略
   ↓
BLE 帧传输
   ├─ CMD_0x13  传输动作组（带 frameCount）
   └─ CMD_0x14  执行 / 停止动作组
   ↓
机器人屏幕（IDLE ⇄ ACTION_PLAYING，ActionGroupRunningState）
```

**关键推论**：手机端的 `SharpEyesVideoView` 是「预览/本地渲染」路径，真机屏幕上的画面是**手机把视频帧经 BLE 推过去**再显示的。所以「3 种眼睛样式」本质是**3 套预渲染视频资源包**。

### 3.3 荧光绿的出处

Eva 的主色是这支荧光绿，同样取自钉钉包内的 AI 系资产：

| 色值 | 出处（均在钉钉 APK 内） |
|---|---|
| `#63ffb4` | `assets/celebrate.json` 眼部填充 |
| `#02ffb7` | `assets/lottie_voip_minutes_animation.json`（AI 通话） |
| `#35e6c0` | 同族青绿，用于辉光过渡 |

> 钉钉基础包内**不含** Eva 眼睛的矢量图形——渲染资源在运行时下发的动态模块中（`sharpeyes/skins/`、`sharpeyes/models/`，清单 `sharpeyes/manifest.json`），基础包里只留得下加载器与云台指令日志。

---

## 4. 表达模型：基底 + 瞬时

这是对 `vow` 最有价值的一条结论。

```
[AmbianceLight][EmotionBridge] base expression=<...>
[AmbianceLight][EmotionBridge] transient expression=<...>
```

| 概念 | 含义 |
|---|---|
| **base expression** | 基底表情，常驻，表达当前会话状态 |
| **transient expression** | 瞬时表情，短暂叠加，播完自动回落到基底 |
| **CompletionPolicy** | 单活跃位 + 优先级抢占（高优先级可打断低优先级） |

### 4.1 动作词表（`ACTION_NAME_*`，仅 5 个）

`EYE_WINK` · `EYEBROW_RAISE` · `HEAD_NOD` · `MOUTH_OPEN` · `NONE`

### 4.2 细粒度动作（`ACTION_TYPE_*`，与面部相关）

`BLINK` · `BOOT` · `OPEN_MOUTH` · `SHAKE_HEAD` · `KEEP_STILL` · `FACE_AVAILABLE` · `RAISE_HEAD_DOWN`

### 4.3 其它行为细节

| 行为 | 证据 | 语义 |
|---|---|---|
| 盯人 / 环顾 | `LookAroundHandler`，日志 `[LookAround] silence_timeout elapsedMs=10000` | 云台 pan/tilt 追随；**静默 10s 回正**，检测到人脸时不回正 |
| 氛围灯 | `[AmbianceLight][Protocol] enqueue atomic request= cmd=0x..` | BLE 原子请求/场景请求，与表情联动 |
| 屏幕四周亮起 | 产品文案 + `AmbianceLightManager` | 「亮起 = 正在聆听」 |
| 皮肤主题 | `SharpEyesThemeMatrix_{MatrixSrc, MatrixBackground, MatrixView}` | 每个皮肤配素材与背景 |

---

## 5. 资源获取探测记录（2026-11）

目标：不依赖「已绑定真机 + 登录态」，直接拉到 `sharpeyes/skins/` 的资源包。所有尝试与结果如下——这部分记录下来，是为了让后来者**不要重复踩**。

### 5.1 二维码入口

从闲鱼获取的 Eva 设备二维码（图片 `IMG_7263.JPG`，900×1200 JPEG）解码结果：

```
https://n.dingtalk.com/dingding/qwhw/index.html?sn=2310K1E263803N000184
```

> 解码方法：本机无 Python，用 Node + `jsqr` + `sharp`。整图直接解码失败（二维码在照片中占比小），需**分块 + 多尺度 + 灰度归一化**才能解出：`grid=1` 即全图放大 1.6 倍时成功。

**关键观察**：二维码里的 SN 是 `...000184`，而实际持有的设备是 `...000362`——**任意 SN 都能打开这个页面**，SN 不参与鉴权，只用于选择设备。

### 5.2 H5 落地页（无头浏览器实测）

用 Puppeteer + 本机 Edge 以 iPhone UA 加载页面，共捕获 40+ 请求：

| 请求 | 结论 |
|---|---|
| `qwhw/1.0.0/{chunk,commons,index}/*.js` | React 打包产物，318KB + 20KB + 20KB |
| `o.alicdn.com/dingding/bird/index.js` | 钉钉埋点/上报 SDK，**不是渲染引擎** |
| `csp.dingtalk.com/csp` | 风控 |
| `log...track.gif?...__topic__=sharpeyes_landing` | 埋点，三个事件即全部业务逻辑 |
| `dingtalk://dingtalkclient/page/qwhw?sn=...` | 唤起 App（浏览器环境下必然失败） |

页面业务逻辑只有三件事：

```
version_check      → platform: notInDingTalk
auto_launch_app    → 唤起 dingtalk:// 深链
auto_launch_failed → 提示下载钉钉
```

**结论：H5 落地页只负责「把人送回 App」，不渲染眼睛、不取资源。**

### 5.3 换钉钉 UA：页面走入了全新分支（**突破口**）

**关键发现**：页面通过 `getENV()` 判断运行环境，逻辑是：

```js
/DingTalk/i.test(ua)                                  // 是否在钉钉内
/AliApp\(\w+\/([a-zA-Z0-9.-]+)\)/                     // 版本号
```

只要 UA 里含 `DingTalk` 字样，页面就不再走 `notInDingTalk` 分支。用真实钉钉 UA 重放：

```
Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15
(KHTML, like Gecko) Mobile/15E148
AliApp(DingTalk/8.1.0) com.alibaba.aliworklaput/47393449 Channel/417200 language/en
DingTalk/8.1.0
```

结果捕获到一个**此前完全没出现过的接口**：

```
GET https://meeting.dingtalk.com/fireeye/info?token=fire_eye
→ {"aliding":{"android":"8.5.5","ohos":"9.0.0","ios":"8.5.5"},
   "android":"9.0.0","ohos":"9.0.5","ios":"9.0.0"}
```

这正是 Fireeye 资源体系的**版本信息接口**，token 就明文写在页面源码里：`fire_eye`。

### 5.4 借用本机已登录的 Edge 会话（实测走通 OAuth，仍无资源）

钉钉桌面端的登录态不适用于 Web，但 Edge 里存在 `login.dingtalk.com` 的凭据。用同一 Windows 用户复制的 profile（Cookies 为 DPAPI 加密，同用户可直接解密）拉起 Edge，访问 `/fireeye/resource`：

**第一次**：被拦到 `/oauth2/challenge.htm`，页面显示已识别账号与「继续使用钉钉会议」按钮——说明**登录态有效，只差一次显式授权**。

**手动完成授权后**，用 Puppeteer 监听全量响应，抓到完整链路：

```
[REQ ] https://meeting.dingtalk.com/dingtalk_sso_call_back?continue=...&code=
[RESP 302] → ...sso_call_back?code=fb48589f625c3488815c491072b84b07&authCode=fb48589f...
[REQ ] https://meeting.dingtalk.com/fireeye/resource?sn=2310K1E263803N000362
[RESP 200] → <title>加入钉钉会议</title>
```

**关键结论：`/fireeye/resource` 返回的是一个「加入钉钉会议」的 HTML 落地页，不是资源 API。**

### 5.5 Fireeye 是撞名，不是同一条链

多路径实测（均需登录）：

| 路径 | 返回 |
|---|---|
| `/fireeye/info?token=fire_eye` | 版本号 JSON（会议客户端门槛检查） |
| `/fireeye/resource?sn=...` | 「加入钉钉会议」HTML |
| `/fireeye/resource/list`、`/fireeye/resource/info` | 同上（同一落地页） |
| 未登录访问任意 `/fireeye/*`（除 info） | 302 → `login.dingtalk.com/oauth2/auth?...client_id=ding8x0qvdl1g7fuykg1&scope=openid` |

**`meeting.dingtalk.com/fireeye/*` 是「钉钉会议」的子路由**，与 SharpEyes 的 Fireeye 资源服务只是命名相撞。`token=fire_eye` 是被忽略的占位参数（任意值返回相同结果）。

> 顺带发现：钉钉内部 `fireeye` 一词至少复用三处——会议路由、供应链安全 SDK（`AWSC/fireeyejs`）、SharpEyes 资源服务。按名字检索时极易误判。

### 5.6 公开 REST 网关

```
GET/POST https://api.dingtalk.com/r/SharpEyes/getFireeyeModelResource
→ {"errcode":404,"errmsg":"请求的URI地址不存在"}
```

⚠ **陷阱**：`https://api.dingtalk.com/v1.0/<任意路径>` 都返回

```json
{"code":"InvalidVersion","message":"Specified parameter Version is not valid."}
```

这是网关的**统一兜底**，把它当作「路由存在」会误导判断（本次曾一度误判）。

### 5.7 钉钉桌面端（已登录）

本机已登录钉钉桌面端（Electron，`DingDing\main\current`），数据目录 `%APPDATA%\DingTalk`（1.2 GB）实查：

| 目录 | 结果 |
|---|---|
| `e574790c0a14456c4615_v3/`（用户数据） | 全是聊天/头像/表情缓存，无 Eva |
| `globalStorage/resource_cache/` | 143 个文件，全是 jpg/png |
| `config/module_cache.dat` | 模块清单里**不含** sharpeyes / fireeye / dock |
| `config/dingtalk_protect.dat` | 反注入/反调试配置：`antiRemoteThreadSwitch=1` 等 |

**结论：Eva 模块不在桌面端，桌面端登录态与 SharpEyes 的 RPC 域不同。**

### 5.8 CDN 路径探测

`cdn.dingtalkapps.com/dingding/{qwhw,sharpeyes}/*` 全部返回 **302**——该 CDN 对不存在的路径统一重定向，无目录列举能力，无法枚举资源。

### 5.9 结论

**已取得、但被证伪的线索**：伪造钉钉 UA 暴露了 `/fireeye/info`，但进一步授权发现整条 `meeting.dingtalk.com/fireeye/*` 路由属于「钉钉会议」而非 SharpEyes。命名撞车导致误判——`fireeye` 一词在钉钉内部至少复用三处。

**最终结论**：SharpEyes 资源确认只能从 App 进程内的私有 RPC 获取（`LWP_GATE` →登录态 →设备绑定）。Web 侧无论走 UA 伪装还是 OAuth 授权，都拿不到。投入产出比已到临界点。

相关日志：
```
[LWP_GATE] getFireeyeModelResource auth not ready, wait and retry=
[LWP_GATE] account token required, keep waiting
[LWP_GATE] LWP authenticated, generation=
[LWP_GATE] dispatch request=
```

---

## 6. 为什么不能直接搬官方资源

| 理由 | 说明 |
|---|---|
| **获取门槛** | `GetFireeyeModelResource` 需钉钉登录态 + 已绑定设备 SN（`SharpEyesTarget` 要求登录且已绑定），非公开可拉 |
| **版权** | 资源是受版权保护的视频素材 |
| **技术相悖** | `vow` 跑在浏览器里，播放视频等于把项目退化成播放器，失去 Expressiveness |
| **不必要** | 观感所需要素（几何、配色、节奏、语义）已完整掌握 |

> 补充：资源 CDN `file.dingtalk.com` / `dingapp-resource.dingtalk.com` 可匿名 HEAD，但需要正确的资源路径与版本哈希，无法枚举。

---

## 7. 对 vow 的落地映射

| 官方概念 | `vow` 实现（`apps/web/src/components/EvaScreen.tsx`） |
|---|---|
| 基底表情 | `Base`：`idle` / `listening` / `connecting` / `offline` |
| 瞬时表情 | `Transient`：`blink` / `wink` / `eyebrowRaise` / `headNod` / `mouthOpen` / `happy` / `sad` |
| CompletionPolicy | `useTransient`：单活跃位 + 优先级抢占（微动作 1 / 动作 2 / 情绪 3）+ 定时回落 |
| 自主微动作 | `useIdleBehavior`：2.6–5.2s 随机，70% 眨眼，其余穿插挑眉/点头/张嘴 |
| 氛围灯 | 聆听时屏幕边缘向内发散辉光（`inset` box-shadow 多层衰减） |
| LookAround | 以 `connecting` 基底整层扫视近似（浏览器无云台） |
| 摇晃交互 | `> <` 挤眼（`useShake`，DeviceMotion） |

---

## 8. 本次调研踩过的坑（供后来者）

| 坑 | 教训 |
|---|---|
| `strings` 命令在本机不存在，前几轮 dex 搜索全是**假阴性** | Windows 无 `strings`，改用 `tr -c '[:print:]' '\n' < file` 提取 |
| 只搜 `eva` 找不到任何东西 | Eva 的代码名是 **SharpEyes / dock / Fireeye**，按代号搜 |
| `api.dingtalk.com/v1.0/<任意路径>` 都返回 `InvalidVersion` | 这是钉钉网关的**统一兜底**，不代表路由存在。曾被误判为「路由存在但差参数」 |
| `motor_temperature_face_follow.json` 看似关键 | 实为**云台指令回放日志**，可证明功能存在但无图形 |
| headless Edge 对 90° 旋转不渲染（45° 正常） | 不要用无头浏览器验证大角度旋转；改读 `getBoundingClientRect` |
| JSQR `Malformed data passed to binarizer` | 传给 jsQR 的缓冲区必须是 `Uint8ClampedArray` 包装的 **RGBA** 四通道数据；灰度单通道 raw data 会导致此异常 |
| H5 落地页没有眼睛渲染 | `sharpeyes_landing` 只是埋点名，页面逻辑只有「唤起 App + 下载引导」，不渲染也不取资源 |
| 桌面端 `module_cache.dat` 是二进制 | `strings` 抽不出内容，其中不含 Eva 模块——Eva 是移动端独占 |
| **`fireeye` 是撞名** | 钉钉内部至少三处复用：会议路由（`meeting.dingtalk.com/fireeye/*`）、供应链安全 SDK（`AWSC/fireeyejs`）、SharpEyes 资源服务。看到同名就以为同源，会白走一整个下午 |
| 登录墙容易误判为「就差一步」 | `/fireeye/resource` 未登录时 302 到 OAuth，登录后 200 返回 HTML——**200 不代表拿到资源**，要看 body 内容 |
| Edge 用户目录被运行中实例占用 | Puppeteer 报 `browser is already running` 时，先 `Stop-Process -Name msedge`，再用**复制出的 profile**（同 Windows 用户可解密 DPAPI，无需额外凭据） |

---

## 9. 复现步骤

```bash
# 1. 取钉钉 APK（境内源）
curl -sIL 'https://www.wandoujia.com/apps/6565746/download'   # 跟随重定向得到 CDN 直链

# 2. 解包
unzip -q dingtalk.apk -d unpack

# 3. 提取 dex 字符串（本机无 strings 命令）
for f in unpack/classes*.dex; do
  tr -c '[:print:]' '\n' < "$f" | awk 'length >= 8'
done | sort -u > allstrings.txt

# 4. 按代号检索
grep -i 'sharpeyes' allstrings.txt | head -50
grep -oE 'Lcom/alibaba/android/sharpeyes/[A-Za-z0-9/$]*;' allstrings.txt | sort -u
grep -oE 'Lcom/alibaba/dingtalk/dock/[A-Za-z0-9/$]*;' allstrings.txt | sort -u
```

### 9.1 解码设备二维码

```bash
# 依赖（境内镜像）
npm i --registry=https://registry.npmmirror.com jsqr sharp
```

```js
// 分块 + 多尺度 + 灰度归一化：整图直接解码会因二维码占比小而失败
import sharp from 'sharp'
import jsQR from 'jsqr'
import { readFileSync } from 'node:fs'

const buf = readFileSync('IMG_7263.JPG')
const { width: W, height: H } = await sharp(buf).metadata()

for (const g of [1, 2, 3, 4]) {
  const tw = Math.floor(W / g), th = Math.floor(H / g)
  for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) {
    for (const s of [1, 1.6, 2.4]) {
      const { data, info } = await sharp(buf)
        .extract({ left: gx * tw, top: gy * th, width: tw, height: th })
        .resize(Math.round(tw * s), Math.round(th * s), { fit: 'fill' })
        .grayscale().normalise().raw()
        .toBuffer({ resolveWithObject: true })
      // jsQR 要求 RGBA 四通道
      const rgba = Buffer.alloc(info.width * info.height * 4)
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i]
        rgba[j + 3] = 255
      }
      const code = jsQR(new Uint8ClampedArray(rgba), info.width, info.height, {
        inversionAttempts: 'attemptBoth',
      })
      if (code) { console.log(code.data); process.exit(0) }
    }
  }
}
```

### 9.2 抓取 H5 落地页的完整请求

```bash
npm i --registry=https://registry.npmmirror.com puppeteer-core
```

以 iPhone UA 打开 `https://n.dingtalk.com/dingding/qwhw/index.html?sn=<SN>`，监听 `request` / `response` / `console` 事件即可复现第 5.2 节的结果（页面只会尝试唤起 `dingtalk://` 并上报埋点）。

### 9.3 用钉钉 UA 进入 App 内分支

把 UA 换成含 `DingTalk` 字样的真实值即可（第 5.3 节），页面会请求 `meeting.dingtalk.com/fireeye/info?token=fire_eye`：

```js
await page.setUserAgent(
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 ' +
  'AliApp(DingTalk/8.1.0) com.alibaba.aliworklaput/47393449 Channel/417200 language/en ' +
  'DingTalk/8.1.0'
)
```

判断逻辑在 `getENV()` 里：`/DingTalk/i.test(ua)` 决定走 `ios`/`android` 还是 `notInDingTalk` 分支。

> ⚠ 由此拿到的 `/fireeye/*` 属于「钉钉会议」，**不是** SharpEyes 资源（见 5.5）。这一步的价值仅在于证明外层校验是 UA 判断，不代表能取到眼睛素材。

### 9.4 借用本机已登录会话（如需复现授权流程）

Cookies 为 DPAPI 加密、绑定 Windows 用户，因此**同用户复制 profile 即可直接解密**，无需额外取凭据：

```bash
# 1. 关掉占用用户目录的 Edge
powershell -NoProfile -Command "Stop-Process -Name msedge -Force"

# 2. 复制最小可行 profile
mkdir -p /c/tmp/ep/Default/Network
cp "…/Edge/User Data/Local State" /c/tmp/ep/
cp "…/Edge/User Data/Default/Preferences" /c/tmp/ep/Default/
cp "…/Edge/User Data/Default/Network/Cookies" /c/tmp/ep/Default/Network/
```

然后以 `userDataDir: 'C:/tmp/ep'` 启动 Puppeteer，访问目标页；若被拦到 `oauth2/challenge.htm`，需**本人在窗口内**点击授权。监听 `page.on('response')` 可抓到完整的 `sso_call_back → fireeye/resource` 链路。

---

## 10. 参考

- 产品信息：[凤凰科技 · QwenNote Eva 发布](https://tech.ifeng.com/c/8wd5N8CLLFg)、[什么值得买 · 深度评测](https://post.smzdm.com/p/a950rz60)、[新浪财经](https://finance.sina.com.cn/tech/digi/2026-09-22/doc-inissuii2109224.shtml)
- 钉钉应用：[豌豆荚 · 钉钉](https://m.wandoujia.com/apps/6565746)
- 相关决策：[DECISIONS.md · A24](../DECISIONS.md)
