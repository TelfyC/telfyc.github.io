---
title: "用一条蓝牙通道同时说两件事 — 记一次 BLE 多路复用方案"
description: "在 React Native + BLE + KCP 场景下，如何用单条蓝牙连接并发多个逻辑通道"
pubDate: "Apr 28 2026"
tags: ["BLE", "KCP", "React Native", "IoT"]
---

# 用一条蓝牙通道同时说两件事 — 记一次 BLE 多路复用方案

> **适用场景**：React Native + BLE + KCP 协议，需要在单条蓝牙连接上并发多个逻辑通道

---

## 起因：设备很省，但需求不省

做 IoT 项目的时候，经常碰到一种设备：它只开放一个蓝牙服务，写数据只有一个 characteristic，通知也只有一个。厂商的意思大概是——"通道给你了，剩下的你自己想办法。"

而业务上却要求：既要实时同步传感器数据，又要跑固件升级流程或者独立的配置通道。两件事同时进行，互不干扰。

用一个 characteristic 同时做两件事？听起来有点像用一根筷子同时夹豆腐和排骨。

---

## 方案核心：KCP conv — 给每个对话贴个标签

KCP（一种可靠的 UDP 加速协议）本身有一个字段叫 **conv**（conversation ID），它的作用就是区分不同的"会话"。两端约定好，conv = `0xF1F2F3F4` 是通道 A，conv = `0xF1F2F3F5` 是通道 B，数据进来之后按 conv 拆箱、分发，各走各的。

```js
// 初始化两个 KCP 实例，绑定到同一个蓝牙 write 出口
this.convs.forEach((conv) => {
  const kcp = new Kcp(conv, user);
  kcp.setNoDelay(true, 10, 2, true);
  kcp.setOutput((buffer) => {
    this.write(buffer);  // 都走同一个 BLE characteristic 写出去
  });
  this.kcpRef[conv] = kcp;
});
```

物理上只有一条 BLE 信道，逻辑上却是两条相互隔离的会话通道。有点像同一条公路上画了两条车道，大家各走各的，互不堵车（理想情况下）。

---

## 接收端：别急，数据没来齐

蓝牙 MTU 通常在 512 字节左右，但 KCP 包可以比 MTU 大。设备按 MTU 分包发过来，App 端收到的未必是一个完整的包——可能只来了"上半身"。

所以必须有一个 **接收缓冲区** 做分包重组：

```
BLE事件到来 → 数据追加到 receiveBuffer
                ↓
         解析 KCP 包头（24字节）
                ↓
         读取 dataLength 字段（偏移 20 字节）
                ↓
    数据足够？→ 截取完整包 → 投给对应 KCP 实例
    数据不够？→ 继续等待，不冒进
```

```js
// 从包头解析出 payload 长度
const dataLength = new DataView(
  this.receiveBuffer.buffer,
  this.receiveBuffer.byteOffset + 20
).getUint32(0, true);

const totalPacketSize = 24 + dataLength;

if (this.receiveBuffer.length < totalPacketSize) {
  break; // 老实等，不着急
}
```

这里有个细节：每次截取完整包之后，用 `slice` 把缓冲区前移，而不是手动维护指针。代码干净，不容易出 off-by-one 的 bug。

---

## 生命周期：该初始化的时候初始化，该清理的时候清理

这种"有状态的连接"对象最怕的就是生命周期管理混乱——定时器没清、监听器没移、KCP 没释放，然后内存默默地长起来，用户的手机默默地发热。

整个类分了三个层次的清理动作：

| 方法 | 做了什么 |
|------|---------|
| `clearAllIntervals()` | 清掉所有 KCP 轮询定时器 |
| `removeBleListeners()` | 移除所有 BLE 事件监听器 |
| `cleanup()` | 上面两个 + 释放 KCP 实例 + 清空接收缓冲区 |
| `destroyBLETransform()` | `cleanup()` + 检查连接状态 + 断开蓝牙 + 从缓存中移除外设 |

为什么区分 `cleanup` 和 `destroyBLETransform`？因为设备**主动断开**和**App 主动断开**是两回事：

- 设备掉线了 → 蓝牙已经断了，不需要再调断开接口，只做本地资源清理
- App 主动退出 → 需要先断开蓝牙，然后清理本地资源

忽略这个区别的话，会出现一种经典 bug：设备都掉线了，还在疯狂调用 `disconnect`，然后收到各种奇怪的错误回调，再触发各种奇怪的状态更新……死循环的味道就出来了。

---

## 断线重连：一键还原，不用重新注册

设备断开重连之后，之前注册的回调函数应该怎么办？

一种朴素的方式是：断了就断了，外部调用方重新 `getKcpData()` 重新注册。但这对调用方不友好——它需要感知内部的重连事件。

`reinitBLETransform` 的思路是在重新初始化之前，先把 `handleValueFnMap` 里的回调函数全部快照一份，重连成功之后逐一恢复：

```js
// 保存当前所有回调
const savedHandlers = new Map(this.handleValueFnMap);

// 清理 + 重新初始化
await this.initBLETransform();

// 自动恢复
for (const [conv, handler] of savedHandlers) {
  this.getKcpData(handler, conv, 'auto-restore');
}
```

调用方不需要知道发生了重连，世界还是那个世界，通道还是那个通道。

---

## 参数调优：KCP 的那几个旋钮

KCP 本身有几个影响延迟和吞吐量的参数，在这个场景下：

```js
kcp.setNoDelay(true, 10, 2, true);
// nodelay=true  刷新间隔 10ms  快速重传阈值 2  流控关闭
kcp.setWndSize(5, 128);
// 发送窗口 5  接收窗口 128
kcp.setMtu(512);
```

- `setNoDelay` 里的 `true, 10, 2, true`：激进模式，低延迟优先，适合实时数据同步
- `setWndSize(5, 128)`：接收窗口开大，给设备发数据的空间多一些
- MTU 设为 512，比 BLE 协商的 515 略小，留 3 字节给协议头部，稳妥

---

## 小结

这个方案解决的核心问题是：**在单条 BLE 物理通道上，通过 KCP conv 实现多路逻辑并发**，同时妥善处理了：

- BLE 分包的重组问题
- 多 KCP 实例的统一出口问题  
- 连接生命周期的差异化处理
- 断线重连后的回调自动恢复

如果你的项目里也有类似场景——一条通道，多个业务，各不干扰——这个思路应该可以直接借鉴。

---

*如果你看到这里还有精力的话，可以去翻一翻 KCP 的原始论文，作者 skywind3000 写得相当克制，代码也极度精炼——在传输协议这个领域，那叫一个"字字千金"。*
