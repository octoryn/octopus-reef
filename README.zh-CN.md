[English](README.md) | **简体中文**

# Reef —— 可治理的智能体工程工作台

> 人人都在做智能体工程。**Reef 让它可被证明。**

Reef 是闭源智能体 IDE 的开放、以证据为底座的替代品。它像任何智能体工作台一样在你的代码库上跑智能体 —— 然后**证明它们做过的每一个动作**。每一次状态迁移都是一条防篡改链接;每一场会话都能**独立验证、无需信任存储**,并能**从证据日志逐字节回放**(`reef replay <dir>`):一场持久化的会话先被 store-untrusting 重新验证,再把整条时间线原样重建。**只有能通过验证的日志才能被回放。**

Reef 治理单个智能体的一场会话 —— 而借助它的**指挥官**(`@octopus-reef/agent`),它能治理一整支*舰队*。指挥官**站在**各智能体 CLI(Claude Code、Codex、Gemini、乃至你自己的)**之上**,而不是与它们竞争:它把每个子任务路由到最合适的 worker,把每个 worker 当作一场独立可验证的会话来治理,并把整轮运行绑成一份**Worker Ledger(工作者账本)**,用它证明这支舰队做过什么。详见 [docs/CONDUCTOR.zh-CN.md](docs/CONDUCTOR.zh-CN.md)。

> **属于 [Octopus Core](https://github.com/octoryn) —— 面向可治理 AI 的开放基础设施栈。** Reef 是把整个栈组合成一个产品的*工作台形态*。它从不重新发明哈希、链或工作状态机 —— 而是构建于 [`octopus-evidence`](https://github.com/octoryn/octopus-evidence) 与 [`octopus-workstate`](https://github.com/octoryn/octopus-workstate) 之上;Replay 为原生实现,Runtime、Blackboard、Observe、Experience、Scout、Inspect 按增量方式接入。

## "展示"与"证明"

闭源智能体 IDE 把治理做成 UI 装饰 —— 一个写着"已应用学习"的徽章、一个额度计、一串你只能选择相信的 PR。Reef 交付的是底下那层底座:

| 闭源 IDE *展示* | Reef *证明* |
|---|---|
| "已应用学习" | 会话的每一刻都是防篡改链上的 `octopus-evidence` |
| 日志里的跨库 PR | 工作主干是 `octopus-workstate` 溯源图(proposed → done) |
| "预估消耗额度" | `reef verify` 以 store-untrusting 方式复核整场会话 |
| 一场你只能相信的会话 | 一场你能独立验证、并能回放的会话 |
| 一支你只能相信的智能体舰队 | 一份**证明舰队做过什么**的 Worker Ledger(plan → route → result → acceptance) |

## 快速开始

整个工作台 —— 治理后端**加** Web UI —— 一条命令拉起:

```bash
docker compose up      # → http://localhost:4300 (离线、免密钥)
```

compose demo 会显式设置 `REEF_ALLOW_UNAUTHENTICATED_REMOTE=1`,因为容器需要绑定
`0.0.0.0` 才能做端口映射。任何共享主机或非 demo 部署都应设置
`REEF_DAEMON_TOKEN`,并限制 `REEF_ALLOWED_ORIGINS`。

或从源码运行(Node ≥ 22):

```bash
npm install && npm run build

# 跑一场治理会话(完全离线、无需 API key —— mock driver)
node packages/cli/dist/cli.js run "给 API 加限流" --out ./.reef/demo

# 独立地、无需信任存储地重新验证
node packages/cli/dist/cli.js verify ./.reef/demo

# 重新验证 + 从日志逐字节重建整条时间线
node packages/cli/dist/cli.js replay ./.reef/demo

# 启动 Web/IDE 共享的守护进程(HTTP + SSE)
node packages/cli/dist/cli.js serve 4300

# 看闸门拒绝一个危险动作
node packages/cli/dist/cli.js run "清理这台机器" --demo-denial
```

每次运行都会实时输出事件流,随后给出一个证明块:

```
proof ─────────────────────────────────────────────
  work state   done   work links 5   evidence links 11
  ✓ verified  work spine: intact  evidence log: intact
```

## "治理"具体指什么

一场 Reef **会话**由三个原语组合而成:

- **工作主干**(`octopus-workstate`)—— 任务是一个 `WorkItem`,在 `proposed → ready → claimed → in_progress → done` 之间迁移;每一步都是被证据链承载的 `StateTransition`。非法迁移不可能发生。
- **证据日志**(`octopus-evidence`)—— 每一个观察、动作、闸门裁决、消息,都被铸成防篡改链上的 `Evidence`。
- **动作闸门** —— 智能体提议的每一个动作,在**运行之前**先被裁决。被拒的动作绝不执行;拒绝本身也被记为证据。

`reef verify`(以及 `loadSession`/`replaySession`)会重新推导每一个哈希、重新折叠两条链:被篡改的文件会加载失败,而不是被错误地加载。

## 执行安全(真闸门,不是 denylist)

真实命令只有在(1)通过 tripwire、(2)通过 `reefAllowlist`(允许已知安全者,`DefaultGate` denylist 只是兜底)、(3)由受限执行器执行之后才会运行。可选的 `SandboxExecutor`(`--sandbox`)让命令:无 shell、拒绝网络、写入限定在工作区、拒绝读真实 `$HOME` 的机密内容、中和 git 配置驱动的代码执行、一次性 `HOME`、进程组超时。

**诚实的边界**:本地沙箱是纵深防御,不是不可信 repo 的牢笼 —— 对完全不可信的 repo,请在容器里运行 Reef(`docker compose up`),由操作系统隔离执行。详见 [SECURITY.md](SECURITY.md)。

## 守护进程安全

守护进程默认面向本机:未指定 host 时,`reef-serve` 只绑定 `127.0.0.1`。如果绑定非
loopback 接口且没有 `REEF_DAEMON_TOKEN`,启动会被拒绝;只有可信 demo 才应设置
`REEF_ALLOW_UNAUTHENTICATED_REMOTE=1`。CORS 默认只允许 loopback 浏览器来源;部署时用
`REEF_ALLOWED_ORIGINS=https://your-ui.example` 显式放行。

custom stdio MCP power 可以 spawn 本机命令,因此默认关闭。只有信任本机用户与 MCP
命令时,才设置 `REEF_ALLOW_CUSTOM_MCP_STDIO=1`。

## 指挥官 —— 证明*舰队*做过什么

引擎证明单个智能体的一场会话;**指挥官**(`@octopus-reef/agent`)证明一整支舰队。它把一个任务翻译成子任务,把每个子任务路由到最合适的 worker,把每个 worker 当作一场独立可验证的会话来治理,并把整轮运行绑成一份 **Worker Ledger**:一条 `octopus-evidence` 链 —— `plan → contract → route → result → acceptance → done`,其中每个 `result` 都**钉住**它所来自子会话的链头。换掉一个子会话,钉子就断;改动一个字节,账本就变红。

Worker 是异构的,却都以同一种方式被治理:

- **`codeWorker` / `toolWorker`** —— 我们自己的智能体主循环(一个 `Driver`);模型通过 provider 接缝**租用**(**BYOK,自带密钥**),每一个动作都被闸门裁决、受限执行、并写入证据链。
- **`cliWorker`** —— 包裹一个我们没写的外部智能体 CLI(Claude Code、Codex……)。它需要网络和自己的鉴权,所以我们**不**用操作系统沙箱去关它;而是把它限定在一个工作区里运行,并把它的文件**效果**(运行前后的内容哈希差异)捕获为证据。诚实地界定范围:我们证明它**改了什么**,而非它内部如何推理。
- **`tool` worker** —— MCP / HTTP / API 调用,由 allowlist **按名字**放行。

**验收是一次机检,不是橡皮图章。** 把 [`octopus-intent`](https://github.com/octoryn/octopus-intent) 接成裁判,指挥官就不再满足于"所有子任务都完成了" —— 它会对一个 worker 的**真实子会话记录**跑 `checkContract`,并针对你设定的合约给出**逐条**判决。它能、也确实会说*不*。别人给你看一个智能体做了什么;Reef 让你**证明**一整支*舰队*做了什么。

## 各形态

Reef 与 driver、形态无关;治理集中在一个引擎(`@octopus-reef/engine`)里,所有形态共享它。

| 形态 | 包 | 状态 |
|---|---|---|
| **引擎**(治理:evidence + workstate + gate + executor + replay) | `@octopus-reef/engine` | ✅ |
| **CLI**(`run` · `verify` · `replay` · `serve`) | repo/Docker beta | ✅ |
| **指挥官**(路由 + 治理 + 证明一支异构 worker 舰队) | `@octopus-reef/agent` | ✅ |
| **执行控制平面**(持久运行、恢复、租约、预算、人工复核) | `@octopus-reef/control-plane` | ✅ |
| **真实智能体 driver**(Claude) | `@octopus-reef/driver-claude` | ✅ |
| **服务端**(守护进程 —— 所有形态的统一后端) | repo/Docker beta | ✅ |
| **Web**(Vite + React) | repo/Docker beta | ✅ |
| **IDE**(VS Code) | repo beta | ✅ |
| **Docker** 一键 | `Dockerfile` · `docker-compose.yml` | ✅ |
| 移动端 | — | 暂缓 |

Public npm beta 只发布开放基础包:`@octopus-reef/protocol`、`@octopus-reef/engine`、
`@octopus-reef/agent`、`@octopus-reef/control-plane`、`@octopus-reef/driver-claude` 与 Octopus adapter 系列。
server、CLI、Web、IDE 先保持 repo/Docker beta,直到 commercial gateway 接缝从可发布的
server 包里拆出。

指挥官见 [docs/CONDUCTOR.zh-CN.md](docs/CONDUCTOR.zh-CN.md),栈如何组合见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),完整路线图见 [docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md)。

## 开发

```bash
npm run verify:all   # typecheck + format + lint + test + build(质量闸门)
npm test             # 引擎测试套件
npm run reef -- run "试试我"   # 通过 tsx 从源码跑 CLI
```

Node ≥ 22。中立 core 只依赖 Octopus 栈；选择 PostgreSQL/AWS adapter 时才引入
`pg` 或相应 AWS SDK client。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

Apache-2.0 © Ran Tao。属于 Octopus Core。
