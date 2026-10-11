# ufoo agent 表现观测

观测用于定位行为、建立基线和比较优化前后的表现。执行完成、worker 报告完成和主 agent 验收通过是三个不同的事实，不合并成一个“成功率”。指标不自动判断代码质量，也不触发重试、投递、消费消息或验收。

## 使用

```sh
# 当前项目汇总；完全本地查询，无模型请求，也不启动 daemon
ufoo metrics

# 查一个任务及其子任务，或一个 agent
ufoo metrics <task-id> --json
ufoo metrics --agent reviewer --json

# 时间窗口按运行开始时间选择，保留选中运行的完整可见生命周期
ufoo metrics --since 2026-10-11T00:00:00Z --until 2026-10-12T00:00:00Z --json

# 保存基线、之后比较
ufoo metrics --json > baseline.json
ufoo metrics --baseline baseline.json --json > comparison.json

# 从汇总定位到过程和经过脱敏的工具参数/结果
ufoo trace <task-id> --details --json
ufoo trace --agent reviewer --follow --json
```

MCP 提供只读 `read_agent_metrics`；`read_agent_trace` 的结果及 JSONL follow 状态也包含表现汇总。指标与 trace 来自同一批 journal、worker surface、报告和队列。分页只限制返回的运行记录：默认最近 20 条，`--limit` 最大 100，汇总使用全部已读取且匹配的运行。Trace 附带汇总不返回完整运行列表。

## 指标口径

| 维度 | 观测内容 | 解释 |
|---|---|---|
| 执行 | completed、failed、cancelled、interrupted、running、waiting_user、queued | 每个 taskRunId 只计一次；恢复后续执行仍属于原运行。completedOfFinished 的分母只包括四种结束状态。 |
| 响应 | 排队、首段文字、首段思考摘要、总耗时、活动时间、等待用户时间 | 时间单位为毫秒；首段文字是已观察到的文本输出，不保证是给用户的最终回复。缺失起点/终点返回 null。 |
| 模型 | 主模型调用、SDK turns、失败、空回复重试、上下文溢出重试、自动续跑 | SDK 内部 HTTP 次数不可见，不推算。模型阶段与工具阶段累计耗时是服务时间，不能当作互不重叠的总耗时分解。 |
| 工具 | 执行、错误、执行异常、校验拒绝、未配对调用、相同工具参数重复、loop guard 警告/停止 | 执行异常单独计数并保留副作用未知的状态。同参数重复是调查线索，合法轮询或重读也可能重复。进行中的工具及等待用户的工具可以暂时未配对；这不等于失败。 |
| 用量 | input、output、cacheRead、cacheCreation | 按已有 provider 解析器的字段语义分别汇总，不把 SDK/API 数据或缓存字段重复相加。未回传 usage 不按零计算。部分回传仅汇总可见部分，并标出完整用量覆盖率；不估算费用。 |
| 缓存 | cache.hitRate、cachedTokens、promptTokens、样本和完整覆盖率 | 按 tokens 加权：命中 tokens 总量 / 同批样本的输入总量。OpenAI 的输入总量已含缓存；Anthropic 的分母为 input + cacheRead + cacheCreation。缺少缓存字段或无法确定输入口径的样本不参加缓存率计算；明确回传 cached_tokens=0 才能作为零命中样本。压缩缓存另列 compactionCache。 |
| 压缩 | 尝试、完成、失败、耗时、压缩调用用量 | 压缩用量单独放在 compactionUsage，避免藏在主模型用量里。 |
| 协作 | 委派数、报告数、待验收、accepted、rejected、投递不确定、报告到验收延迟 | acceptedOfReviewed = accepted / (accepted + rejected)；没有验收样本时为 null。不会用 done 报告代替 accepted。 |
| 输出 | 流式文字量、最终回复长度、报告长度 | 按 Unicode 字符计数；报告超过协议默认 600 字符会出现 long_report 线索。最终回复与过程流分开计数。 |
| 活动 | 最后事件距今时间、队列年龄 | running 五分钟无可见事件会标出线索；模型/SDK 可能仍在工作，不自动判定卡死。排队耗时只来自 request.accepted 或精确匹配的 bus sequence。 |

每个运行记录包含 provider、model、thinking、ufoo 版本、执行循环/SDK runner 指纹、实际提示词和工具 schema 指纹、输入指纹，以及请求类型。主 agent 区分用户请求、worker 报告唤醒、独立编码任务和任务结果唤醒；无法辨认的来源保留 unknown。面板 worker 区分已指派任务和其他 bus 消息。配置记录只保留这些元数据和指纹，不新增凭据、header、URL 或提示词正文。

Provider/model、thinking、版本、执行引擎指纹、请求类型形成 cohort，API 与 SDK 分开聚合。提示词指纹包含运行时上下文，适合查明某次运行实际用了哪份输入，不应当作稳定实验分组。引擎指纹覆盖共享循环或 SDK runner 函数，不能代表整个仓库或 SDK 内部实现；依赖或其他 host/capability 改动仍需保存源码版本。

## 后续优化方法

1. 选一组固定的开发任务，保存任务说明、仓库起点、预期产物和验证命令；同时覆盖直接编码、委派、group、错误纠正和长会话。
2. 固定模型、thinking、凭据来源和任务环境；运行后保存 metrics JSON、精确任务的 trace，以及代码 diff 和验证结果。
3. 一次改一个变量，例如系统提示词、路由策略、报告约束或压缩策略；复跑同一任务集。
4. 对比验收、错误和重复行为，再看耗时、用量及输出长度；同时人工检查真实产物。快、少 tokens 或短报告本身不代表质量提高。

`--baseline` 输出指标差值和变化比例；不同任务、样本量、模型或不完整来源可能影响结果，因此它是观测差异，不是因果结论。没有真实质量评分或独立验收的数据，不生成质量评分。

缓存统计同时出现在 CLI、JSON、MCP 和各个 cohort。缓存率只使用同时具备命中量和可确定输入总量的样本，旁边显示样本覆盖情况。基线缓存率比较要求双方所有运行具有完整缓存观测，否则差值保留 null。Responses API 读取 `usage.input_tokens_details.cached_tokens`，Chat Completions 读取 `usage.prompt_tokens_details.cached_tokens`；写缓存 tokens 计入 cacheCreation，不当作缓存命中。指标口径参考 [OpenAI 官方缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)。旧解析器遗漏后写成零的日志无法还原真实命中量；修复作用于新请求。

## 数据与边界

源数据使用已有 `.ufoo/agent/*/runtimes/*/events.jsonl`、bus surface、`reports.jsonl` 和活动队列，不引入第二份可变执行状态。旧日志仍可查询，缺少配置、身份关联或生命周期时使用 unknown/null 和 coverage；不补造旧事件。queues 是查询当下的待处理/已领取消息快照，不是时间窗口内的历史队列重建，provider/model 过滤也不改变这份快照。

查询沿用 trace 的读取限制：最多 200 个 runtime journal、14 个 bus 日文件、每文件 2 MiB、总计 32 MiB。截断、损坏记录和读取失败会出现在 warnings/incomplete；指标仅代表已读取的样本。最多返回 100 个 cohort，超出时同样告知。没有事件的项目也不被初始化或修复。

源代码入口：`src/agents/runtime/protocol/runObservation.js` 生成配置指纹；共享循环和 internal runner 写既有观测事件；`src/coordination/history/agentTrace.js` 读取并归一化；`agentPerformance.js` 计算指标；`src/app/cli/metricsCommands.js` 与共享 MCP 工具提供查询。
