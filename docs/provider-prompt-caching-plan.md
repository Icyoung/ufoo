# 按 provider 调整原生 agent 的提示缓存

提案，2026-11-20。适用于共享原生 runtime 的 ufoo 主 agent 和 ucode。目标是在长任务中降低每个完成任务的输入成本和首输出延迟，同时保住前序代码、用户约束和工具结果的可查性。

项目配置 `.ufoo/config.json` 的 `context.cacheStrategy` 可为新会话选择 `stable-prefix`。首次写入投影时会固定策略版本。升级前已有窗口记录的会话继续使用原策略。新策略保留窗口内已发送的轮次和补充块，到达软水位后按完整旧轮次收缩。若当前轮仍在硬上限内，保留最新工具结果全文。ucode 的实时表盘和任务结束表盘都显示该请求采用的上下文窗口。使用 `ufoo metrics --json` 检查通道、策略版本和各用途费用。长 TTL 实验需要实测缓存读取量与任务质量，当前按通道的默认保留行为发送请求。

## 上下文与缓存策略各自负责什么

共享 runtime 决定模型需要看到哪些内容。provider 适配器决定怎样把这些内容序列化、在哪些位置标记缓存、请求多长的保留期。ufoo 和独立 ucode 的主模型、辅助模型都按最终解析的 provider、端点、凭证类型、协议和模型选择策略。选同一个 Codex group，在官方 API、订阅后端或兼容代理上可以得到不同的策略。SDK 托管的 worker 沿用 SDK 的会话管理，按它实际提供的用量单独统计。

1. **固定已经发送的前缀。** 工具定义及顺序、系统规则、项目指令在内容和授权相同时保持稳定。权限和模式变化仍由可信指令与工具执行层立即生效。历史记录保存原始对话，索引从原始记录生成。工作集、后台报告、检索摘要等补充内容由 runtime 标注来源并随当前轮追加。另存带版本的会话投影，记录窗口起点、各轮实际发出的补充块和重建该协议请求所需的字段。同一会话、通道和模型恢复时按原顺序重放，新证据随新消息加入。
2. **按输入预算收缩。** 输入硬上限取已知约束的最小值，包括端点与模型的最大输入、有效上下文窗口减去本次输出预留，以及显式输入上限（如有）。现有 `UFOO_CONTEXT_LIMIT_TOKENS` 作用于上下文窗口。按最终请求估算占用，系统文本、工具定义、历史和本轮消息各计一次。达到预算的 **85%** 时按完整旧轮次收缩，目标约 **60%**。保留当前用户任务和待返回的工具调用，已完成的调用与结果成对处理。超大结果保留可回查的原文。可删历史耗尽时，必要输入在硬上限内就继续发送，超过硬上限才在本地报错。收缩后的窗口起点持久化，下一轮从这里继续。窗口外继续使用已有话题索引和 `recall_turn`。
3. **把调用间隔用在合适的位置。** 首版用同一可复用前缀的请求起始间隔评估是否值得购买长缓存。一次慢测试或用户离开后回来，仍可继续同一段历史。后续若实测有收益，可在预计下一轮就会越过高水位、且已超出该通道默认缓存覆盖时间时，提前到最近的完整轮次边界收缩。时间是对缓存可用性的估计，实际读取量以服务端 usage 为准。

## 各通道的第一版默认值

| 实际通道 | 请求和保留策略 |
|---|---|
| Anthropic 官方 Messages | 默认 5 分钟。工具、system 和 messages 共用最多 4 个断点，由最终请求构造器统一选取、去重。优先选稳定系统段末尾、复用历史末尾和最新可缓存消息。经常在 5 分钟至 1 小时内再次使用的大段稳定前缀可单独试用 1 小时，长 TTL 段在短 TTL 段之前。命中会刷新，持续时间从请求开始计算。[Claude 官方说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| OpenAI 官方 Responses | 我们常用的 GPT-6 系列默认采用 30 分钟。对隔较长时间仍原样复用的前缀，单独评估 12 小时的额外写入费。按模型能力决定字段和消息位置。GPT-6.2 起，需缓存的固定指令放入首条 developer 输入。旧型号使用各自支持的 retention 选项。[OpenAI 官方说明](https://developers.openai.com/api/docs/guides/prompt-caching) |
| Codex 订阅后端 | 两个入口将解析得到的 `codex-subscription` 传到最终请求构造器。使用 `stable-prefix` 的原生 ucode 在 GPT-6.2 上把稳定的开头两层指令放入首条 developer 消息，把当轮的可信指令保留在顶层 `instructions`。只有分层文本与原始指令完全对应时才启用这项序列化。自定义地址按端点已知能力处理，订阅读取量按服务端 usage 单独统计。[接入分流](../src/agents/providers/upstreamRuntime.js#L61) · [请求构造](../src/agents/providers/transports/responsesProtocol.js) |
| agy / Antigravity | 保持工具声明、systemInstruction 和历史顺序稳定，读取 `cachedContentTokenCount`。按 agy 端点实际支持的能力选择选项，Gemini 4 模型名本身不足以推断该后端的保留期。[现有适配器](../src/agents/providers/transports/antigravityTransport.js) |
| Kimi、Grok 及自定义兼容端点 | 初始使用稳定前缀和现有协议字段，只为已确认支持的端点与模型启用专属选项。对缺少缓存用量的响应记录“未知”。 |

例如，agent 等待后台测试，两次模型请求的开始时间相隔 12 分钟。GPT-6 官方 API 的默认缓存时间覆盖这段间隔。Claude 默认 5 分钟已过，若这类会话经常复用相同的大前缀，可以在写入时为该前缀选择 1 小时。是否启用取决于多付的写入费能否被后续节省的重写费抵消。两者都按实际输入占用决定是否压缩。用户配置可以默认 `auto`，有明确成本偏好时再覆盖具体通道的保留期。

## 实施顺序与验收

以下 P1 和 P2 记录实施前的故障和对应回归条件。请求构造、跨轮恢复和费用归属已有离线回归覆盖。实际缓存读取量、延迟和任务费用由灰度阶段验证。

### 第一阶段　修复 Claude 断点并建立请求级基线

离线捕获的 Claude 请求包含任务阶段、历史和新工具结果，system 有 3 个断点、messages 有 2 个，超过官方上限 4 个。用同一请求断言 tools、system、messages 的断点总数最多 4 个，相同边界只标一次，跳过不适合标记的内容块，并保留稳定前缀的断点。在 `ufoo metrics` 补充通道、策略版本、相邻请求起始间隔、前缀最早变化的位置和压缩原因。前缀比对只记录摘要值和 token 数。[Claude 断点规则](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#explicit-cache-breakpoints)

- **P1 · Codex 订阅分流。** 目前 ufoo 主入口能传递 `requestProfile`，独立 ucode 的前台与辅助调用均漏传。只有识别出订阅通道，构造器才会移除 `max_output_tokens`。回归用假传输从两个入口分别运行官方 API key、官方订阅 OAuth 和覆盖地址的兼容代理，核对主模型与辅助模型最终发出的 URL、通道标识和请求字段。订阅请求应省略该字段，代理只使用已确认支持的字段。[ucode 凭证解析](../src/agents/providers/runtimeConfig.js#L203) · [ucode 调用](../src/code/nativeRunner.js#L276) · [最终请求构造](../src/agents/providers/nativeTransport.js#L707)
- **P2 · 混合 TTL 计费。** 现有解析只保留总写入量。OpenAI Responses 应保留 `input_tokens_details.cache_write_tokens_details` 中的 `ttl_30m_tokens` 和 `ttl_12h_tokens`，普通输入由总输入扣除缓存读取和写入得到。Claude 的 `input_tokens` 已是普通输入，应另取 `cache_creation` 中的 `ephemeral_5m_input_tokens` 和 `ephemeral_1h_input_tokens`。写入按各档分别计价，总写入量用于核对分项之和。[OpenAI 用量解析](../src/agents/providers/transports/responsesProtocol.js#L415) · [Claude 用量解析](../src/agents/providers/nativeTransport.js#L159) · [OpenAI 计费](https://developers.openai.com/api/docs/guides/prompt-caching) · [Claude 计费](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

  回归覆盖两档写入都大于零、服务端明确返回零、分项缺失，以及 GPT-6.2 Sol 输入刚好达到和超过 272K 的两次请求。后一请求的全部输入和缓存用量适用双倍费率。按请求计算后再汇总到任务，混合 TTL 缺少定价分项时将费用标为未知，保留可见用量。[Sol 价格档位](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
- **P2 · 辅助模型费用归属。** 两个入口的话题选择和摘要增强目前只取返回文本，窗口变化会影响检索调用次数。为前台、检索和增强分别记录用途、实际模型、请求 ID、所属任务与用量。用假传输产生一次前台调用、一次检索、一次异步增强，断言三个请求各计一次，增强完成后费用归回原任务，前台首输出仍按原请求计时。[ufoo 辅助调用](../src/runtime/daemon/agentHost.js#L231) · [ucode 辅助调用](../src/code/nativeRunner.js#L289) · [现有指标聚合](../src/coordination/history/agentPerformance.js#L153)

### 第二阶段　在共享 runtime 验证跨轮历史与收缩边界

- **P1 · 用户原文。** 当前文本清洗会把用户自己写的 `<turn_context>only staging</turn_context>` 一并删掉，首次请求和历史回查都受影响。改为根据 runtime 写入的结构化来源识别补充块。回归把这段字面文本和一条真正的召回摘要放进同一轮。最终模型输入、索引的原始输入和 `recall_turn` 返回的正文都应逐字保留用户原话。后续请求按补充块重放召回摘要，索引与原文回查只取用户正文。[清洗逻辑](../src/agents/runtime/context/turnAnalyzer.js#L68) · [历史回查](../src/agents/capabilities/turnRecall/index.js#L122)
- **P1 · 暂停与恢复。** Responses 的加密 `reasoning` 项和原始输出顺序目前保存在不可枚举的 Symbol 中。离线经会话日志往返后，工具调用和结果仍在，之前的推理项已经丢失。新投影应保留这些协议项、调用 ID 和顺序。用同一段含工具调用的会话和相同答复对照连续运行与 `ask_user` 暂停后重启两条路径，逐项比较下一次请求的保留前缀、签名或推理项、调用与结果的配对。旧记录缺少协议字段时，从可合法重建的边界开始新的缓存前缀，原始记录仍可回查。另测旧会话恢复时已完成的工具调用只执行一次。[Responses 协议项](../src/agents/providers/transports/responsesProtocol.js#L64) · [会话重放](../src/code/context/transcript.js#L144) · [现有日志往返用例](../test/unit/code/providers/transports.test.js#L262)
- **P1 · 输入软水位和硬上限。** 离线设置窗口 8,000、输出预留 1,000。只有一条用户消息且估算为 6,322 tokens 时，现有实现越过 5,950 的软水位便报 `context_budget_exceeded`。回归要求这条完整消息能发送，同样条件下 7,372 tokens 的必要输入才触发本地超限。再验证 Chat 请求里的 system 文本只计一次，以及按实际端点取模型限制。以官方 GPT-6.2 Sol 为例，当前本地回退值为 200,000，官方上下文窗口为 1,050,000，另有 922,000 的最大输入限制。[水位与估算](../src/agents/runtime/context/slidingWindowManager.js#L476) · [本地拒绝条件](../src/agents/runtime/context/slidingWindowManager.js#L712) · [本地模型上限](../src/agents/runtime/context/contextWindow.js#L56) · [官方模型规格](https://developers.openai.com/api/docs/models/gpt-6.2-sol)

两个入口共用上述选择逻辑，在最终序列化后的请求上比较连续读代码、下一轮有新检索结果、后台唤醒和超大工具输出。验证收缩后旧代码还能从原记录找回，新工具结果仍与调用配对。

### 第三阶段　按会话灰度，再试长 TTL

四项 P1 的回归通过后，按相同通道、模型、任务类型和停顿时长对照新旧策略，同一会话固定策略版本。按完成任务汇总前台与辅助调用的输入费用和缓存读写量，并在同组任务间比较前台首输出 P95、任务验收和历史召回结果。单列压缩前的最后一次请求、压缩后的首次请求和后续工具轮，比较可复用前缀长度与实际缓存读取量，判断一次压缩的影响持续几轮。命中率按 token 加权，以服务端用量为准。订阅和缺字段的通道分别报告可见用量与覆盖率。[现有观测口径](OBSERVABILITY.md)

长 TTL 实验还需通过两项 P2 的费用验收，使对照组和实验组都能按任务核算输入成本。费用或延迟改善且任务质量稳定时再扩大启用范围。85% 和 60% 均为试运行起点。

离线对照使用 18 轮合成文本对话、8,000 tokens 的窗口和 1,000 tokens 的输出预留。用同一组消息构造 Responses 请求，稳定前缀策略在第 11、14、17 轮触发收缩。第 11 轮收缩后，下一轮请求与其共享的前缀估算约 2,900 tokens，再下一轮约 3,400 tokens。这个样例验证了压缩后可以从新边界继续追加。服务端命中量仍以真实请求的 usage 为准。
