[English](CHANGELOG.md) | **简体中文**

# 更新日志

本项目所有重要变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] — 2026-07-08

指挥官版本:Reef 现在不只治理单个智能体的一场会话,而是治理一整支**舰队**,并证明这支舰队做过什么。

### 新增

- **指挥官**(`@octopus-reef/agent`)—— 一个站在各智能体 CLI 之上的受治理编排器。它把任务翻译成子任务(`Planner`),把每个子任务路由到最合适的 worker(`Router`),把每个 worker 当作一场独立可验证的受治理子会话来跑,并把整轮运行绑成一份 **Worker Ledger**:一条 `octopus-evidence` 链 —— `plan → contract → route → result → acceptance → done`,其中每个 `result` 都钉住它所来自子会话的链头。`verifyLedger` 以无需信任存储的方式复核它;改动一个字节它就变为不可验证。
- **异构 worker,同一套治理。** `codeWorker` / `toolWorker` 跑 Reef 自己的智能体主循环(模型通过 `ModelProvider` 接缝租用 —— BYOK 自带密钥);每个动作都被闸门裁决、受限执行、写入证据链。`cliWorker` 通过可配置的 `buildArgv` 包裹一个**外部**智能体 CLI(Claude Code、Codex……),把它限定在工作区里运行,并把它的文件**效果**(运行前后的内容哈希差异)捕获为证据 —— 诚实地界定为它**改了什么**,而非它内部如何推理。
- **验收即真正的机检。** 一个 `AcceptanceSeam` 让裁判对一个 worker 的**真实**子会话 `record` 跑 `octopus-intent` 的 `checkContract`,并针对合约给出**逐条**判决 —— 作为 `orchestration.acceptance` 记入账本。它能、也确实会说*不*。Reef 从不 import 检查器;两者无需耦合即可组合。
- **引擎中的受治理 `tool` 动作** —— worker 通过一个 `ToolExecutor` 触达 MCP / HTTP / API 工具,由 `reefAllowlist` **按名字**放行。
- **`ModelProvider` 接缝 + `BedrockProvider`** —— 一个纯 fetch(无 SDK)、用 bearer token 的 provider;智能体主循环是我们自己的,模型是可替换的后端。
- **基准测试**(`bench/`)—— SWE-bench 风格的分级任务 + 隐藏评分,让 harness 能用一个分数、而非一种感觉来回答"够不够好"。

### 说明

- 护城河是*可被证明的*编排,而不是路由(路由会大路货化)。规划与路由的质量是可即插即换的;Reef 投入的是那份防篡改账本与那次真正的验收机检。
- 除 Octopus 栈外,仍为零第三方运行时依赖。

## [0.1.0] — 2026-07-05

首个工作台版本:可治理的智能体工程形态。

### 新增

- **引擎**(`@octopus-reef/engine`)—— 受治理会话:工作主干(`octopus-workstate`)与证据日志(`octopus-evidence`)一同生长,每个动作在运行前先过 `ActionGate`,`verify` 以无需信任存储的方式重新推导两条链。
- **回放** —— `reef replay <dir>` 重新验证一场持久化会话,并逐字节重建它的完整时间线;只有能通过验证的日志才能被回放。
- **执行安全** —— `reefAllowlist`(允许已知安全者)加上可选的 `SandboxExecutor`:无 shell、拒绝网络、写入限定在工作区、`$HOME` 机密不可读、中和 git 配置驱动的代码执行。
- **各形态** —— CLI(`run` · `verify` · `replay` · `serve`)、真实的 Claude driver、服务端守护进程(HTTP + SSE)、Web UI(Vite + React)、VS Code IDE 扩展,以及一键 Docker。

[0.2.0]: https://github.com/octoryn/octopus-reef/releases/tag/v0.2.0
[0.1.0]: https://github.com/octoryn/octopus-reef/releases/tag/v0.1.0
