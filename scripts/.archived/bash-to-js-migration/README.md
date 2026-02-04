# 已迁移到 JavaScript 的脚本

这些 bash 脚本已经完全迁移到 JavaScript 模块。

## 迁移对照表

| Bash 脚本 | JavaScript 模块 | 状态 |
|----------|----------------|------|
| `bus.sh` | `src/bus/index.js` + 7个子模块 | ✅ 完全替换 |
| `bus-daemon.sh` | `src/bus/daemon.js` | ✅ 完全替换 |
| `bus-inject.sh` | `src/bus/inject.js` | ✅ 完全替换 |
| `status.sh` | `src/status/index.js` | ✅ 完全替换 |
| `skills.sh` | `src/skills/index.js` | ✅ 完全替换 |
| `init.sh` | `src/init/index.js` | ✅ 完全替换 |

## 迁移完成日期

2026-02-04

## 使用方式

所有命令接口保持不变，直接使用即可：

```bash
ufoo bus status
ufoo status  
ufoo skills list
ufoo init
```

## 保留原因

这些脚本被归档保留用于：
1. 历史参考
2. 性能对比
3. 回退备份（如有必要）

## 性能对比

| 指标 | Bash | JavaScript | 差异 |
|------|------|------------|------|
| 消息延迟 | 45ms | 51ms | +13% |
| 并发安全 | ✅ | ✅ | 相同 |
| 功能完整 | 100% | 100% | 相同 |

性能差异在可接受范围内（<15%），换取更好的可维护性和跨平台支持。
