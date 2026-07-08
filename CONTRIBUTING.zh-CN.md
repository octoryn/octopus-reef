[English](CONTRIBUTING.md) | **简体中文**

# 为 Reef 贡献

Reef 按一套"房屋标准"构建:**一切都以绿色交付,且每一处非平凡的改动在被称为完成之前,都要经过对抗式评审。**

## 环境准备

```bash
npm ci            # Node >= 22
npm run verify:all
```

`verify:all` 就是那道闸门:类型检查(库 + web + ide)· prettier · eslint · 测试 · 全部构建。CI 跑同一道闸门,外加一次 Docker 镜像构建 + 冒烟测试。红的绝不合入。

## 结构

一个由小而单一职责的包组成的 monorepo(npm workspaces、ESM、TypeScript strict):

| 包 | 角色 |
| --- | --- |
| `engine` | 受治理会话 —— evidence + workstate + gate + executor + replay。离线、依赖极少。**治理住在这里;其他每个包都很薄。** |
| `protocol` | 共享的 HTTP/SSE 线缆契约 |
| `agent` | 指挥官 —— 路由 + 治理 + 证明一支异构 worker 舰队(Worker Ledger)。它组合引擎;从不 import 验收检查器。 |
| `driver-claude` | 真实的 Claude 智能体 driver(独立成包,好让引擎保持离线) |
| `server` | 所有形态共享的守护进程(HTTP + SSE) |
| `cli` · `web` · `ide` | 各形态(终端 · Vite/React · VS Code) |

引擎**从不重新发明**哈希、链或工作状态机 —— 它组合 `octopus-evidence` 与 `octopus-workstate`。

## 工作节奏

1. 把改动做到绿。
2. **对抗式评审** —— 多维度的寻错者,随后是一个默认判"证伪"的怀疑者;只有能复现的发现才算数。每一处修复都带一个回归测试落地。
3. 重新验证(修复可能引入新洞 —— 持续评审,直到某一轮找不出真正的 HIGH/MED)。
4. 更新 `docs/DELIVERY-PLAN.md`,开一个聚焦的 PR。

## 约定

- 与周围代码在命名、注释密度、惯用法上保持一致。
- 偏好受限、可测的接缝,而非宽泛的暴露面。
- 安全相关的代码(闸门、执行器/沙箱、服务端)要过一遍显式的对抗式评审 —— 威胁模型与我们对自己坚持的诚实边界见 [SECURITY.md](SECURITY.md)。
- 提交信息:祈使句主题,正文解释*为什么*。
