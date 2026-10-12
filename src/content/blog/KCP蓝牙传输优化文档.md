---
title: "KCP over BLE：把一根不保证送达的蓝牙通道，改造成可靠、可复用、可对账的通道"
description: "在 React Native + BLE 之上引入 KCP 会话层，用重传、按需 ACK、分片重组和会话号复用，让一条蓝牙通道可靠承载多路业务，并补上接收重同步、写失败重试、死链上报与全链路丢包对账。"
pubDate: "Oct 12 2026"
tags: ["BLE", "KCP", "React Native", "IoT"]
---

# KCP over BLE：把一根不保证送达的蓝牙通道，改造成可靠、可复用、可对账的通道

> 环境：React Native + BLE。
> 涉及代码：`src/utils/kcp.js`、`src/utils/MultiBLETransform.js`、`src/utils/kcpDebug.js`、`src/services/DeviceControlService.js`

---

## 先说这份文档要说明的判断

BLE 硬件只给我们一条通道，而这条通道本身不保证把数据送到：写入没有回执，通知会按 MTU 分包，中间还可能丢掉字节。在这个前提上，KCP 提供了一层会话——丢了会重传，乱了会排序，切片会拼回，不同业务用会话号分开，互不干扰。改造完成后，同一条物理通道能同时承载几路业务；而当一条命令没有回来时，我们能判断出是链路把包丢了，还是设备根本没有回复。

下面按 S / T / A / R 四段展开，并用同一个真实事故贯穿：G 级设备上点"刷新"，一次下发几条蓝牙命令，其中一条的响应始终不回来，界面停在转圈。

---

## S — 问题：命令没回来时，说不清是谁的责任

### 硬件只给一条通道

目标设备的 BLE 配置被厂商压到了最小：一个服务 `fff0`，一个写特征 `fff2`，一个通知特征 `fff1`。物理上只有这一条通道。

业务这边的需求并不小，需要同时做三件事：实时状态同步（频繁、怕延迟）、固件升级 OTA（流量大、占用久）、配置与调试指令（随时插入）。三件事共用一条通道，还要互不阻塞。

### 这条通道不保证送达

上层代码习惯上假定：发出去就到了，收齐了才是一条完整命令。BLE 的真实情况是：

- **写入没有 GATT 层确认。** `writeWithoutResponse` 失败只表现为 promise 被 reject，调用方不处理，这一帧就等于没发生过。
- **通知会分包。** App 收到的可能只是半个包，需要自己拼。
- **空口会丢字节。** 一旦中间掉一个字节，后面所有字节的边界都对不上。
- **单个包有大小上限。** 本项目向系统申请 515 字节，命令一长就得切开。

### 真正麻烦的地方

"刷新不回来"这件事，本身并不难复现，难的是**在它发生时，无法判断包死在哪一层**。可能的当事人有四个：KCP 自己丢了；App 拼字节点错了；`writeWithoutResponse` 被系统蓝牙栈吞了；硬件蓝牙模块或空口丢了。

四个都说得通，谁也没有证据。结果是排查只能靠反复重连碰运气，也没法给嵌入式同事一个能核对的结论。

---

## T — 目标

把上面两个问题一起解决，拆成四条：

1. **可靠**：在 BLE 之上建立会话层，让丢帧能重传、分片能重组、乱序能缓冲重排。
2. **复用**：在单条写出口上并发承载多路互相隔离的逻辑通道。
3. **可查**：能判断丢包发生在哪一层，并给出可供设备端逐条核对的证据。
4. **不漏**：重连、断链、清理都不留资源泄漏；链路彻底失活时快速失败，而不是静默等待。

---

## A — 方案

### 用 KCP 承担可靠传输

KCP 原本用来给 UDP 加速，核心思路是拿带宽换延迟。它提供的能力，恰好对应 BLE 的几个毛病：

- **重传**：发出的分段没有在 RTO 内被确认，就重发，抵消空口丢帧。
- **按需 ACK**：接收方回确认，让发送方知道哪些到了。
- **分片与重组**：`send()` 按 `mss` 切段（用 `frg` 标记），接收侧 `recv()` 按 `frg` 拼回完整消息。
- **乱序缓冲**：乱序到达的分段先存进 `rcv_buf`，等序号连续了再交给应用层。

每个会话一个实例，共同接到同一个 BLE 写出口：

```js
// src/utils/MultiBLETransform.js — initKcp()
that.convs.forEach((conv) => {
  const kcp = new Kcp(conv, user);
  kcp.setNoDelay(true, 10, 2, true);
  kcp.setWndSize(5, 128);
  kcp.setMtu(512);
  kcp.setOutput((buffer) => { that.write(buffer); }); // 所有会话共用一个 write
  that.kcpRef[conv] = kcp;
});
```

### 用会话号在一条通道上分开几路业务

KCP 头部有一个 32 位的 `conv`（会话号），作用是区分不同的会话。`MultiBLETransform` 默认建立两个：

```js
constructor(currentPeripheral, convs = [0xf1f2f3f4, 0xf1f2f3f5])
```

| conv | 现状 |
|------|------|
| `0xf1f2f3f4` | 主通道（默认）。目前所有业务——状态同步、配置、OTA——都走它 |
| `0xf1f2f3f5` | 第二通道。实例已建好，作为并发隔离的预留，页面暂未接入 |

物理上仍是一条 characteristic，逻辑上各路 `conv` 互相独立：发送时按 `conv` 选实例（`kcpSend(bytes, conv)`），接收时按包头 `conv` 分发（`kcpRef[conv].input()`）。复用的能力已经就位——`conv` 就是通道号，要加一路业务，开一个 `conv` 并绑一个回调即可，物理通道不用改。

### 接收端：拼包，以及拼歪之后怎么办

通知到达的是一段裸字节流，包与包之间没有平台层边界，只能自己按 KCP 头（24 字节）切开。`processCompletePackets()` 的循环是：

```
notify 到达 → 追加到 receiveBuffer
                ↓
   偏移 0 处是不是一个合法 KCP 帧头？（conv 命中 + 长度可信）
        ├─ 不是 → 错位。向前找下一个合法帧头，重新对齐
        ↓ 是
   读出 dataLength（偏移 20，小端 u32）
        ↓
   receiveBuffer 凑够一个整包了吗？
        ├─ 不够 → break，等下一条 notify
        ↓ 够
   slice 出整包 → 按 conv 分发 → kcp.input()
```

其中两处细节来自真实缺陷（对应下面 A6 的 #1、#2）：

- **帧头校验由 `&&` 改成命中判定。** 旧代码用 `&&` 连接几个条件，意思是"全都对不上才算错"，几乎不会判错。新代码要求偏移 0 处**必须命中本实例的 `conv`，且长度不超过单段上限**（`_matchHeaderAt`），任一条不满足就当错位。
- **错位之后是重新对齐，不是清空。** 旧代码一校验失败就清空整个 `receiveBuffer`。问题在于，字节流错位后不会自己复位，清空只会把"丢了一个字节"放大成"整条通道长期安静"。新实现 `_resyncReceiveBuffer()` 向前找到下一个合法帧头，**只丢掉它前面那段垃圾**；找不到就只保留末尾 ≤3 字节（可能是被截断的帧头），不误伤后面的好帧。

### 参数

针对 BLE 的带宽与延迟特点，调三个参数：

```js
kcp.setNoDelay(true, 10, 2, true); // 激进：无延迟 + 10ms 刷新 + 快速重传阈值 2 + 关流控
kcp.setWndSize(5, 128);            // 发送窗口 5 / 接收窗口 128（接收开大，给设备下发留空间）
kcp.setMtu(512);                   // KCP 单段 MTU 512，比 BLE 申请的 515 小 3 字节，留余量
```

相关常量：

| 常量 | 值 | 含义 |
|------|-----|------|
| `BLE_CONFIG.MTU_SIZE` | 515 | 向系统申请的 BLE MTU |
| KCP `setMtu` | 512 | KCP 层 MTU，于是 `mss = 512 - 24 = 488` |
| `KCP_UPDATE_INTERVAL` | 50ms | KCP `update()` 轮询周期，驱动 flush 与重传 |
| `RECV_BUFFER_SIZE` | 10241 | 单次 `recv()` 读出的应用层消息上限 |
| `WRITE_MAX_RETRY` / `WRITE_RETRY_DELAY` | 2 / 80ms | 写失败的重试次数与间隔 |

### 发送、清理与重连

`kcpSend()` 在发送后立刻调一次 `flush(false)`。`kcp.send()` 只是把数据放进 `snd_queue`，真正发出依赖轮询 `update()→flush()`。如果调用方发完命令就离开页面，轮询会被 `useFocusEffect` 清掉，队列里的帧就永远发不出去。典型例子是 IO 监测点"停止"：指令卡在队列里，设备收不到。发送后同步 flush 一次，命令就不再看轮询的脸色。

清理分成四层，各自职责不同：

| 方法 | 职责 |
|------|------|
| `clearAllIntervals()` | 清掉所有 KCP 轮询定时器 |
| `removeBleListeners()` | 移除所有 BLE 事件监听器 |
| `cleanup(shouldDisconnect)` | 以上两者 + 释放 KCP 实例 + 清空接收缓冲 |
| `destroyBLETransform()` | `cleanup()` + 检查连接 + 断开蓝牙 + 移除外设缓存 |

要区分 `cleanup` 和 `destroyBLETransform`，是因为"设备自己掉线"和"App 主动断开"是两件事：设备掉线时蓝牙已经断了，只需本地清理；App 主动退出时，要先断蓝牙再清理。把两者混在一起，就会出现设备已经掉线、代码还在反复调 `disconnect` 的情况，进而触发一串错误回调和状态更新。

断线重连则不需要调用方操心。`reinitBLETransform()` 在重连前先把 `handleValueFnMap` 和 `extraHandlersMap` 拍个快照，`initBLETransform()` 成功后逐一恢复。调用方不必知道中间断过一次。

### 修掉的四处缺陷

排查过程中发现四个"看着合理、细看有问题"的历史写法：

| # | 缺陷 | 后果 | 修法 |
|---|------|------|------|
| #1 | 包头校验用 `&&`（各条件全不符才算错） | 错位检测形同失效，垃圾长度被当真 | `_matchHeaderAt`：conv 命中 + 长度 ≤ mss 才算合法 |
| #2 | 校验失败清空整个 `receiveBuffer`，没有重同步 | 一次丢字节被放大成整条通道安静 | `_resyncReceiveBuffer` / `_findNextHeaderStart`：向前扫帧头，只丢垃圾前缀 |
| #3 | `writeWithoutResponse` 失败被静默吞掉 | 该帧静默丢失，只能等 KCP RTO（约 1s）重传 | `_writeWithRetry`：有限重试（2 次 / 80ms）。重发同一帧对 KCP 安全（PUSH 按 sn 去重，ACK 幂等） |
| #4 | `dead_link` 标了 `state=0xffffffff` 后无人处理 | 上层继续静默重传，逐条卡到 8s 超时 | KCP 新增 `onDeadLink` 边沿回调与 `isDead()`；`kcpSend` 死链早退；`DeviceControlService._sendOnce` 快速失败，省掉 8s 空等 |

第 4 处的一段代码：

```js
// src/utils/kcp.js — 死链只上报一次
if (segment.xmit >= this.dead_link) {
  this.state = 0xffffffff;
  if (!this._deadLinkNotified) {
    this._deadLinkNotified = true;
    if (typeof this.onDeadLink === 'function') this.onDeadLink(this.conv, segment.sn, segment.xmit);
  }
}
```

### 全链路对账

"包丢在哪一层"无法靠改代码解决，得能看见。`src/utils/kcpDebug.js` 做的就是在各层记账，收工时对账：

- **分层埋点**：`kcpSend`（应用层命令）→ `flush` / `input`（KCP 分段、ACK、重传、死链）→ `write` / `notify`（BLE 读与写）。
- **一条原则**：高频事件只进环形缓冲和计数器，不 `console.log`。高频打印本身会拖慢 JS 线程、加剧丢包、污染实验。只在会话结束 `end()` 或手动 `dump()` 时集中输出，统一带 `[KCPDBG]` 前缀，便于 `adb logcat -s ReactNativeJS | grep KCPDBG` 过滤。
- **报告内容**：命令 key 对账（含 RTT）、响应流 `rxSn` 的空洞与边界时刻、对端重传的到达间隔、`txSn` 的未确认 / 高重传 / DEADLINK、App 发出的 ACK 数（可交设备端核对）、notify 是否断流。
- **自动结论**（`diagnose()`）：

  | 现象 | 说明 |
  |------|------|
  | `rxSn` 有空洞且未补齐 | 设备→App 链路丢字节，疑硬件蓝牙模块或空口 |
  | sn 无空洞但命令 key 缺失 | KCP 层从未收到，说明设备应用层没发响应（查固件） |
  | `reasmDrop` 且伴随空洞 | 重组错位是后果，根因是链路丢字节 |
  | `bleTxErr` / `deadLink` | 发送方向丢包，或链路半死 |
  | 各层账目平齐 | 不在这条链路上丢，应查响应解析或 key 匹配 |

回到开头那条"没回来的命令"：有了这份报告，它要么对应一个 `rxSn` 空洞（链路丢了），要么对应一个从未出现的命令 key（设备没发）。一次会话就能定位到层，并留下可与设备端日志逐 sn 比对的证据。

---

## R — 结果

**可靠性。** 丢帧会自动恢复：KCP 重传兜底，单帧丢失在 RTO（`IKCP_RTO_NDL = 1000ms`）内补回，写失败再叠一层 2×80ms 的即时重试。错位之后只丢垃圾前缀，好帧继续处理，丢一个字节不再演变成整条通道安静。死链（重传 20 次无 ACK，`IKCP_DEADLINK = 20`）被边沿上报，`kcpSend` 早退、`_sendOnce` 立即报错，每条省下 8 秒空等。

**复用。** 在单条 BLE characteristic 上按 `conv` 复用多路会话的能力已经具备，各路的状态、窗口、重传序列彼此独立。当前业务全部集中在主通道 `0xf1f2f3f4`，第二通道作为并发预留；需要并发时按 `conv` 增开即可，物理通道不用动。

**可查。** "丢在 KCP 层还是硬件蓝牙层"由一次对账报告判定，并附有可交嵌入式的逐 sn 证据。排查从经验猜测变成了分层证据。

**验证。** 补了 `src/utils/__tests__/MultiBLETransform.reasm.test.js`（9 例），覆盖对齐切包、连续包、错位前缀重同步、长度不可信判错、跨通知重同步、死链早退与转发，为这次改动提供回归保护。本轮只撰写文档、未现场复跑测试，用例是否全绿以仓库 CI 或本地实跑为准。

**尚未解决。** KCP `flush()` 的 ACK 过滤条件 `ack.sn >= rcv_nxt || last` 是非标准改法（标准 KCP 会全部 ACK 发出），乱序场景下可能吞掉中间 sn 的 ACK，目前仍未改动，保留观察。本次重同步处理的是丢字节导致的错位；如果设备端往同一条 characteristic 里混入非 KCP 帧，还需要另约一个帧同步字才更稳。

## 
