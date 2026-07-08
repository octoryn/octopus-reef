[English](ARCHITECTURE.md) | **简体中文**

# Reef —— 架构

Reef 是**架在 Octopus 栈之上的一层形态**,而不是一个新原语。它唯一的职责,是把整个栈组合成一个可治理的智能体工作台 —— 在那里,每一场会话都可被证明。它从不重新实现哈希、链或工作状态机。

## 核心的那一个想法

一场**会话**是围绕一个智能体的受治理外壳。两条防篡改记录随着智能体工作而一同生长,只有两者都通过验证,会话才算可被证明:

```
                        ┌──────────────────────────────────────┐
   task ──▶ GovernedSession                                     │
                        │   work spine        evidence log      │
                        │  (octopus-          (octopus-         │
                        │   workstate)         evidence)        │
   agent Driver ──steps─┤   proposed          session.created   │
   (mock | Claude SDK)  │     │                observation      │
                        │   ready             action.executed   │  每一步
   each action ─▶ Gate ─┤   claimed           action.denied ◀── │  都是一条链接
   (allow / deny)       │   in_progress       message           │
                        │   done              session.sealed    │
                        │     ▼                    ▼             │
                        │  workstate.jsonl    session.log.jsonl  │
                        └──────────────────────────────────────┘
                                        │
                            reef verify(无需信任存储):
                            重新推导每一个哈希、重新折叠两条链
```

## 各个包

| 包 | 职责(一句话) |
|---|---|
| `@octopus-reef/engine` | 受治理会话引擎 —— 把 workstate + evidence + gate + driver 组合成一场可证明的会话。 |
| `@octopus-reef/agent` | 指挥官 —— 规划、路由、并治理一支异构 worker 舰队,汇成一份可验证的 Worker Ledger。 |
| `@octopus-reef/cli` | 终端形态:运行并验证受治理会话。 |
| `@octopus-reef/server` *(M2)* | 承载引擎的本地守护进程,让所有形态共享一个后端。 |
| `@octopus-reef/web` *(M3)* | 架在服务端之上的浏览器形态。 |
| `@octopus-reef/ide` *(M4)* | 架在服务端之上的 VS Code 形态。 |

## 引擎内部

- **`GovernedSession`**(`session.ts`)—— 编排整场运行:创建 `WorkItem`,让它沿合法迁移前进,迭代 driver,裁决每个动作,发出 `ReefEvent`,并把每一刻铸成证据。
- **`EvidenceLog`**(`log.ts`)—— 对 `octopus-evidence`(`createEvidence` + `nextLink` + `verifyChain`)一层薄而诚实的封装。`verify()` 检查:每个 evidence 重算它的 id + integrity;每条 link 都提交了它的 evidence;链条连续且正确链接;以及可选钉住的长度/链头以捕获截断。`restore()` 拒绝任何损坏的记录。
- **`ActionGate` / `DefaultGate`**(`gate.ts`)—— "不安全的执行在结构上不可能发生"这一接缝。`DefaultGate` 是一个最小的内建策略;`octopus-runtime` 在 M6 从这同一个接口背后接入。
- **`Driver`**(`types.ts`、`driver.ts`)—— 会话背后的智能体。Reef 与 driver 无关:`MockDriver`(离线/免密钥,驱动测试 + Docker demo)与 M1 的 Claude Agent SDK driver 共享一个接口。无论用哪个 driver,治理底座都完全相同。
- **持久化**(`persist.ts`)—— 写出 `workstate.jsonl` + `session.log.jsonl`;`loadSession` 以无需信任存储的方式重新验证两者。

## 为什么是两条链,而非一条

**工作主干**回答*存在哪些工作、它从何而来、以及它为何迁移状态*(workstate 的领域)。**证据日志**为回放捕获*每一个细粒度的会话时刻*。它们是领域各异的两份独立记录;只有当**两者都**验证通过,会话才可被证明。这让每个 Octopus 原语都恰好只做它那一件事。

## 从一场会话到一整支舰队 —— 指挥官

引擎证明一场会话;`@octopus-reef/agent` 把它组合成一支受治理的**舰队**。指挥官从不重新实现治理 —— 它路由到的每个 worker 都是一场普通的 `GovernedSession`,所以每个子会话本就有它自己那两条能验证的链。指挥官所增加的,是覆盖编排本身的**第三**份防篡改记录 —— **Worker Ledger**:

```
   task ─▶ Orchestrator
             plan ─▶ (contract) ─▶ route ─▶ result ─▶ … ─▶ acceptance ─▶ done
                                              │
                                    每个 result 都钉住子会话的
                                    (workHead, logHead) —— 防调包
```

每个条目都是 `octopus-evidence`;`verifyLedger` 以无需信任存储的方式复核链条。因为一个 `result` 钉住了一场真实受治理子会话的链头,这份账本被绑定到了**真实的工作**上,而不只是自洽。验收是可选且解耦的:裁判可对一个 worker 的子会话记录跑 `octopus-intent` 的 `checkContract`,其判决作为 `orchestration.acceptance` 被记录。引擎从不 import 检查器。详见 [CONDUCTOR.zh-CN.md](CONDUCTOR.zh-CN.md)。

## 恪守的设计准则

- **组合,不重造。** 哈希、链与状态机来自已发布的包。Reef 只增加编排与形态,不碰任何密码学。
- **默认无需信任存储。** 验证从不信任文件;它重新推导。被篡改的会话会加载失败。
- **可免密钥。** 整个底座用 mock driver 就能离线运行,所以测试、CI 与 Docker demo 都不需要 API key。
- **先裁决,再执行。** 没有动作会在裁定之前运行;拒绝即证据。
