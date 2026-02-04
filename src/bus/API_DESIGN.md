# Event Bus JavaScript API 设计

## 概述

已将 Event Bus 从 bash 迁移到 JavaScript，核心能力由 `src/bus` 模块提供。

## 核心类设计

```javascript
class EventBus {
  constructor(projectRoot);

  // 初始化
  async init();

  // 订阅者管理
  async join(sessionId, agentType, nickname);
  async leave(subscriber);
  async rename(subscriber, nickname);
  async whoami(); // 获取当前订阅者 ID

  // 消息发送
  async send(target, message, publisher);
  async broadcast(message, publisher);

  // 消息接收
  async check(subscriber, autoAck);
  async ack(subscriber);
  async consume(subscriber, fromBeginning);

  // 查询与路由
  async status();
  async resolve(myId, targetType);

  // 后台监听
  async alert(subscriber, interval, options);
  async listen(subscriber, options);
}
```

## 文件结构

```
src/bus/
├── index.js           # EventBus 主类
├── subscriber.js      # 订阅者管理
├── message.js         # 消息发送/接收
├── queue.js           # 队列管理（offset, pending）
├── nickname.js        # 昵称解析
├── daemon.js          # bus daemon（自动注入 /ubus）
├── utils.js           # 工具函数
└── API_DESIGN.md      # 本文件
```

## 数据结构

### bus.json
```json
{
  "created_at": "2026-01-29T...",
  "subscribers": {
    "claude-code:abc123": {
      "agent_type": "claude-code",
      "nickname": "architect",
      "status": "active",
      "joined_at": "...",
      "last_seen": "...",
      "pid": 12345,
      "tty": "/dev/ttys001"
    }
  }
}
```

### events/YYYY-MM-DD.jsonl
```json
{"seq":1,"timestamp":"...","type":"message/targeted","event":"message","publisher":"...","target":"...","data":{...}}
```

### queues/{subscriber}/pending.jsonl
```json
{"seq":1,"timestamp":"...","type":"message/targeted","event":"message","publisher":"...","data":{...}}
```

### queues/{subscriber}/offset
```
5
```

## 关键功能实现

### 1. 消息路由（支持昵称）

```javascript
async resolveTarget(target) {
  // 优先级：
  // 1. 精确订阅者 ID (claude-code:abc123)
  // 2. 昵称匹配 (architect -> claude-code:abc123)
  // 3. 代理类型 (codex -> 所有 codex 代理)
  // 4. 通配符 (* -> 所有代理)
}
```

### 2. 队列管理

```javascript
class QueueManager {
  async getOffset(subscriber);
  async setOffset(subscriber, seq);
  async appendPending(subscriber, event);
  async readPending(subscriber);
  async clearPending(subscriber);
}
```

### 3. 序号生成（全局唯一）

```javascript
async getNextSeq() {
  // 读取所有 events/*.jsonl 文件的最后一行
  // 返回 max(seq) + 1
  // 保证全局唯一、单调递增
}
```

### 4. 昵称冲突检测

```javascript
async ensureUniqueNickname(nickname, excludeSubscriber) {
  // 检查 bus.json 中是否已存在该昵称
  // 返回是否唯一
}
```

## 向后兼容性

### CLI 接口保持不变

```bash
ufoo bus init
ufoo bus join [session] [type] [nick]
ufoo bus send <target> <message>
# ... 所有命令保持原样
```

### 环境变量支持

- `AI_BUS_PUBLISHER` - 发送者 ID
- `CLAUDE_SESSION_ID` / `CODEX_SESSION_ID` - 会话 ID
- `UFOO_NICKNAME` - 昵称

## 错误处理

```javascript
class BusError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 错误码：
// BUS_NOT_INITIALIZED
// SUBSCRIBER_NOT_FOUND
// NICKNAME_CONFLICT
// INVALID_TARGET
// ...
```

## 测试策略

### 单元测试
- 每个模块独立测试
- Mock 文件系统操作

### 集成测试
- 完整消息流测试（send -> check -> ack）
- 多订阅者场景
- 昵称冲突处理

### 性能测试
- 消息发送延迟 < 50ms
- 序号生成 < 10ms
- 状态查询 < 100ms

## 迁移检查清单

- [ ] init 命令
- [ ] join/leave 命令
- [ ] send/broadcast 命令
- [ ] check/ack 命令
- [ ] status 命令
- [ ] resolve 命令
- [ ] rename 命令（支持昵称）
- [ ] consume 命令
- [ ] alert 后台监听
- [ ] listen 前台监听
- [ ] autotrigger 自动触发
- [ ] 昵称解析（send 支持昵称）
- [ ] 全局序号唯一性
- [ ] 文件并发安全
- [ ] 错误处理和日志
- [ ] CLI 向后兼容
