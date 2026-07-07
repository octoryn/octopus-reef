[English](README.md) | **简体中文**

# Reef —— 可治理的智能体工程工作台

> 人人都在做智能体工程。**Reef 让它可被证明。**

Reef 是闭源智能体 IDE 的开放、以证据为底座的替代品。它像任何智能体工作台一样在你的代码库上跑智能体 —— 然后**证明它们做过的每一个动作**。每一次状态迁移都是一条防篡改链接;每一场会话都能**独立验证、无需信任存储**,并能**从证据日志逐字节回放**(`reef replay <dir>`):一场持久化的会话先被 store-untrusting 重新验证,再把整条时间线原样重建。**只有能通过验证的日志才能被回放。**

> **属于 [Octopus Core](https://github.com/octoryn) —— 面向可治理 AI 的开放基础设施栈。** Reef 是把整个栈组合成一个产品的*工作台形态*。它从不重新发明哈希、链或工作状态机 —— 而是构建于 [`octopus-evidence`](https://github.com/octoryn/octopus-evidence) 与 [`octopus-workstate`](https://github.com/octoryn/octopus-workstate) 之上;Replay 为原生实现,Runtime、Blackboard、Observe、Experience、Scout、Inspect 按增量方式接入。

## "展示"与"证明"

闭源智能体 IDE 把治理做成 UI 装饰 —— 一个写着"已应用学习"的徽章、一个额度计、一串你只能选择相信的 PR。Reef 交付的是底下那层底座:

| 闭源 IDE *展示* | Reef *证明* |
|---|---|
| "已应用学习" | 会话的每一刻都是防篡改链上的 `octopus-evidence` |
| 日志里的跨库 PR | 工作主干是 `octopus-workstate` 溯源图(proposed → done) |
| "预估消耗额度" | `reef verify` 以 store-untrusting 方式复核整场会话 |
| 一场你只能相信的会话 | 一场你能独立验证、并能回放的会话 |

## 快速开始

整个工作台 —— 治理后端**加** Web UI —— 一条命令拉起:

```bash
docker compose up      # → http://localhost:4300 (离线、免密钥)
```

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

## 各形态

Reef 与 driver、形态无关;治理集中在一个引擎(`@octopus-reef/engine`)里,所有形态共享它。

| 形态 | 包 | 状态 |
|---|---|---|
| **引擎**(治理:evidence + workstate + gate + executor + replay) | `@octopus-reef/engine` | ✅ |
| **CLI**(`run` · `verify` · `replay` · `serve`) | `@octopus-reef/cli` | ✅ |
| **真实智能体 driver**(Claude) | `@octopus-reef/driver-claude` | ✅ |
| **服务端**(守护进程 —— 所有形态的统一后端) | `@octopus-reef/server` | ✅ |
| **Web**(Vite + React) | `@octopus-reef/web` | ✅ |
| **IDE**(VS Code) | `@octopus-reef/ide` | ✅ |
| **Docker** 一键 | `Dockerfile` · `docker-compose.yml` | ✅ |
| 移动端 | — | 暂缓 |

完整路线图见 [docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md),栈如何组合见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```bash
npm run verify:all   # typecheck + format + lint + test + build(质量闸门)
npm test             # 引擎测试套件
npm run reef -- run "试试我"   # 通过 tsx 从源码跑 CLI
```

Node ≥ 22。除 Octopus 栈外,零第三方运行时依赖。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

Apache-2.0 © Ran Tao。属于 Octopus Core。
