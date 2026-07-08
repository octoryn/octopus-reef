[English](CONDUCTOR.md) | **简体中文**

# 指挥官 —— 证明*舰队*做过什么

引擎([ARCHITECTURE.md](ARCHITECTURE.md))证明**单个**智能体的一场会话;指挥官(`@octopus-reef/agent`)证明**一整支**舰队。

它不是又一个编码智能体,也不与 Claude Code、Codex、Gemini 竞争。它站在它们**之上**:一个受治理的调度员 —— 把意图翻译成子任务,把每个子任务路由到最合适的 worker,让每个 worker 在治理之下运行,然后(这才是关键)**证明整支舰队做过什么**。

> 路由是大路货(AutoGen、CrewAI、LangGraph 都会路由)。护城河是**可被证明的**编排:一份钉住每个子会话的防篡改账本,加上一次真正的机检式验收。这才是本包的增量。

## 核心的那一个想法

```
task ─▶ Orchestrator(指挥官)
         │
         ├─ Planner ───────▶ 子任务
         │
         ├─ 对每个子任务:
         │     Router ─────▶ 选一个 Worker
         │     Worker.run ─▶ 一场受治理的子会话(它自己的两条链)
         │                    └─ 返回一个 WorkerResult,并**钉住**子会话的链头
         │
         ├─ Acceptance(可选)─▶ 按合约裁决这些结果
         │
         └─ Worker Ledger ─▶ 覆盖整轮运行的 octopus-evidence 链
                 plan → contract → route → result → … → acceptance → done
```

上图每一根箭头都被铸成 `octopus-evidence`。**Worker Ledger** 是覆盖编排本身的一条防篡改链;每个 `result` 条目都记录它所来自子会话的链头。把一个子会话换成另一个,钉住的链头就对不上;改动任何条目的一个字节,`verifyLedger` 就变红。

## 各个接缝(seam)

指挥官是一组小接口,让每个部件都可替换、可离线测试。

| 接缝 | 职责 | 内置实现 |
|---|---|---|
| `Planner` | 任务 → 子任务 | `LlmPlanner`(任意 provider)或你自己的 |
| `Router` | 子任务 → 选哪个 worker | `LlmRouter` 或一个确定性路由器 |
| `Worker` | 把一个子任务当作受治理子会话来跑 | `codeWorker`、`toolWorker`、`cliWorker` |
| `ModelProvider` | 租用一个模型(BYOK) | `BedrockProvider`(纯 fetch,无 SDK) |
| `AcceptanceSeam` | 按合约裁决整轮运行 | 接入 `octopus-intent` |

这里没有任何东西被锁死到某个厂商:智能体主循环是**我们自己的**,模型只是 `ModelProvider` 背后一个可替换的后端。

## 异构的 worker,同一套治理

无论包裹的是什么,每个 worker 都返回同样的 `WorkerResult` —— `{ outcome, output, workHead, logHead, verified, record }`。其中 `record` 是子会话的两条链(工作主干 + 证据日志),因此裁判可以独立地重新验证它。

- **`codeWorker` / `toolWorker`** —— Reef 自己的智能体主循环(一个 [`AgentWorker`](../packages/agent/src/worker.ts) `Driver`)。模型通过 `ModelProvider` 租用(BYOK)。每一个动作都被 `reefAllowlist` 裁决、被执行器限定、并铸成证据。`toolWorker` 通过一个受治理的 `tool` 动作调用 MCP / HTTP / API 工具,由 allowlist **按名字**放行。
- **`cliWorker`** —— 通过可配置的 `buildArgv` 包裹一个我们**没写**的外部智能体 CLI(Claude Code、Codex……)。外部智能体需要网络和自己的鉴权,所以 —— 不同于我们自己的 worker —— 我们**不**在操作系统沙箱里跑它。而是把它限定在一个工作区里运行,并捕获它的文件**效果**:运行前后的内容哈希差异,记为证据。这场受治理的子会话证明了这次调用、以及究竟哪些文件被创建 / 修改 / 删除。

## 验收是一次机检,不是橡皮图章

把 [`octopus-intent`](https://github.com/octoryn/octopus-intent) 接成裁判,指挥官就不再接受"所有子任务都完成了"。它转而对一个 worker 的**真实**子会话 `record` 跑 `checkContract`,并针对你设定的合约给出**逐条**判决:

```
verdict = unmet(未满足)
  ✓ 到达 done
  ✗ 进入 done 的迁移是 agent 做的,不是人   (分权 / 职责分离)
  ✓ 无被禁止的拒绝证据
```

那个 `met: false` 正是价值所在 —— 橡皮图章会说 `met`。这份判决作为 `orchestration.acceptance` 被记入账本,因此一轮运行**为什么**被(或不被)接受,本身就是防篡改记录的一部分。

Reef 从不 import `octopus-intent`;是检查器去消费 Reef 的输出。`record` 的形状是 Reef 原生的,但与检查器的 `SessionRecord` 在结构上完全一致,因此两者无需耦合即可组合。

## 验证一份账本

```ts
import { Orchestrator, toolWorker, verifyLedger } from "@octopus-reef/agent";

const result = await orchestrator.orchestrate("向一个潜在客户介绍 Octopus");

result.verified;                      // 账本独立地重新验证通过
verifyLedger(result.ledger);          // ……任何人都能重新复核它,无需信任存储
result.ledger.evidence.map(e => e.kind);
// [ 'orchestration.plan', 'orchestration.route', 'orchestration.result',
//   'orchestration.acceptance', 'orchestration.done' ]
```

改动 `result.ledger` 里任何内容,`verifyLedger` 都会返回 `false`。每个 `orchestration.result` 都钉住一场真实受治理子会话的 `workHead` + `logHead`,所以这份账本不仅自洽 —— 它还被绑定到了**真实的工作**上。

## 诚实的范围界定

- **我们证明效果,不证明念头。** 对外部 CLI,我们捕获文件差异和受治理记录 —— 而非智能体的内部推理。我们只声称我们能展示的。
- **护城河是治理,不是路由。** 规划与路由的*质量*是可调的(换一个更好的 planner 即可)。难以复制的是那份可证明、防调包的账本,以及那次真正的验收机检 —— 所以 Reef 把投入放在这里。
- **BYOK。** 你自带模型密钥。Reef 是治理与证据层,不是 token 二道贩子。
