# Tsumugi

**紡ぎ**

[English](README.md) · [简体中文](README.zh-CN.md)

面向持续演进内容的可扩展本地化工作台，原生支持 AI 与 Agent 协作流程。

Tsumugi 不把本地化当作一次性导出任务，而是将源内容快照、译文修订、术语、上下文、审阅结论、QA 检查、AI 候选以及构建发布记录统一保存在同一个项目中。当上游内容更新时，它能帮助你识别哪些工作仍然有效、哪些需要重新处理，并完整保留决策历史。

## 概览

软件界面、游戏 Mod 和字幕往往会持续迭代：原文会修改、条目会移动、术语也会演进。上一版已经完成的翻译，到了新版本可能需要局部更新或重新核对。

Tsumugi 将这种演进视为日常项目生命周期的一部分：

```text
导入 → 翻译 → 审阅 → 验证 → 构建 → 发布 → 更新
```

导入新的上游源内容时，Tsumugi 不会丢弃既有成果，而是基于内容身份、版本沿袭和依赖关系与现有项目进行比对：自动保留仍然适用的结果，标记需要重新验证、重译或审阅的条目，并记录每次变更的依据。

## 核心概念

### 项目模型

一个项目（Project）跨版本管理全部本地化资产与状态：

- 源内容快照、本地化单元及其原始文件位置
- 目标语言与不可变的译文修订记录
- 术语表、单元上下文与翻译记忆建议
- 人工审阅结论、QA 检查结果与限定范围的豁免（Waiver）
- 后台任务记录、AI 翻译候选与 Arena 对比结果
- 经校验的构建产物（Release）与本地导出回执

**内容身份独立于文本字面值和文件位置**：相同的文本不一定代表同一个本地化单元；即便条目在新版本中移动了位置或修改了原文，仍可延续同一逻辑身份。

**翻译、人工审阅、当前适用性与 QA 验证分别记录状态**：保存译文不会自动视为通过审阅；修改译文不会自动沿用旧版批准结论；当原文、术语或上下文发生变化时，原本已批准的译文也会被标记为需要重新确认。

### 上游持续维护

导入新版本源内容后，Tsumugi 会根据版本沿袭与依赖分析区分：

- 仍然直接适用的译文与审阅结论
- 需要重新运行 QA 检查的条目
- 需要重新翻译或人工审阅的条目
- 无法自动判定对应关系、需要人工确认沿袭关系的变更

不再适用于当前版本的旧译文、审阅记录与历史发布仍保留在项目历史中，随时可供对照。

### 扩展模型与领域插件

Tsumugi 将通用本地化流程与具体文件格式、领域规则解耦。Rust Core 负责项目状态、持久化、并发控制与结果采纳；具体领域能力通过语言无关的契约接入：

- **[插件 SDK](crates/plugin-sdk/README.md)**（`crates/plugin-sdk`）：独立构建的 Rust 数据契约、契约检查 CLI 以及生成的 JavaScript 绑定。
- **[插件 Host](crates/plugin-host/README.md)**（`crates/plugin-host`）：提供插件包检查、本地 Store 与信任管理，以及隔离的原生 / JavaScript 组件通道。
- **[桌面插件管理](docs/plugin-distribution.zh-CN.md)**：支持显式安装插件包、批准运行环境，并为项目绑定对应领域能力。

目前内置与插件支持覆盖 Stardew Valley SMAPI Mod（`manifest.json` 与平铺 `i18n/*.json`）以及带显式 cue ID 的实验性 WebVTT 纯文本字幕（导入、翻译、更新与导出均保留时间轴、布局及非文本字节）。支持范围与兼容性详见[内置集成说明](docs/integrations.md)与[插件开发指南](docs/plugin-authoring.md)。

### AI 翻译、Arena 与 Agent 工作计划

AI 能力按需使用，与纯手动翻译、审阅和维护共享同一套项目模型：

- **[直接 AI 翻译](docs/ai-translation.md)**：支持可编辑的 OpenAI 兼容 Chat Completions 接口（以及 macOS 下的 ChatGPT 订阅账号登录），发送前可预览实际共享的数据并设置预算。
- **[Arena 对比](docs/ai-translation.md#arena-comparison)**：支持在同一预算下生成 2–4 套方案或离线对比已有候选，提供可选盲评标签与记录贡献来源的人工合并。
- **[Agent 工作计划（Work Plans）](docs/work-plans.md)**：基于 `pi-agent-core` 与 `pi-ai` 运行多步本地化协作任务，支持团队成员动态讨论、只读插件与 MCP 工具调用（见[插件工具](docs/plugin-tools.md)、[MCP 检索](docs/mcp-retrieval.md)、[MCP 共享](docs/mcp-sharing.md)）、请求预算控制，以及人工随时指导、停止或接管。

AI 与 Agent 产出的内容不会直接覆盖当前译文或充当人工批准，而是作为候选或建议保存，通过相同的选择、审阅和 QA 流程进入项目。

### 构建与发布

编辑、构建、发布（Release）与导出交付是彼此独立的操作：

```text
项目状态
    ↓
固定 Release 输入
    ↓
构建前验证
    ↓
构建产物
    ↓
构建后产物验证
    ↓
记录不可变 Release
    ↓
本地导出 / 交付
```

构建前会检查项目就绪状态，构建后会校验实际生成的产物字节。构建失败不会生成 Release；已经记录的 Release 也不会因为后续导出中断或目标目录写入失败而丢失，可随时核对结果并基于原始校验字节重新导出。详见[本地构建与导出说明](docs/build-release.md)。

## 桌面工作台

桌面端通过侧边导航切换各个工作面，切换时自动保留当前位置、筛选条件与未保存草稿；离开存在未保存修改的译文时会提示保存、继续编辑或放弃。

- **源内容**：导入并检查源快照、比对上游更新并确认内容沿袭关系。详见[源导入与维护说明](docs/source-import.md)。
- **译文**：默认打开分页编辑器，支持在整个源快照范围内搜索原生 key、原文与当前译文，并排提供术语、上下文与修订历史折叠参考栏，同时支持导入外部译文文件。详见[译文导入与编辑说明](docs/translation-import.md)。
- **术语与上下文**：维护项目术语、逐条审阅本地词表文件、固定单元上下文，并定位受术语变更影响的译文。详见[术语与上下文说明](docs/resources.md)。
- **审阅与 QA**：记录人工批准或修改意见、运行内置或插件 QA 检查、管理豁免，并按语言评估构建前就绪状态。详见[审阅与 QA 说明](docs/review-qa.md)。
- **AI 翻译、Arena 与工作计划**：发起受控的 AI 翻译请求、在 Arena 中盲评或合并候选，或编排多成员 Agent 任务。
- **任务**：查看持久化任务进度、取消运行中操作、恢复中断任务并显式采纳已完成结果。
- **构建与导出**：将通过审阅与检查的译文构建为经校验的本地语言文件并导出到目标目录。

单独启动的新工作台右侧可新建和选择对话、保存消息、恢复本机输入，并查看之前的规划回复。保存消息不会调用模型。

询问助理时，先勾选 1–16 条已保存消息，也可带入 1–100 个已选条目及其目标语言。核对连接、实际发送内容与限额，明确同意后只请求一次；之后改筛选不会扩大已带入的范围。术语和上下文由你勾选，当前选用译文不会发送。

有效的规划建议可以保存为提议，修改后另存新版本；历史版本仍可查看，未完成的修改也可以保存在本机。可从已保存的版本准备工作计划，核对材料、权限和有效期后明确确认。确认会记录计划，但不会自动开始执行。

对话面板可以查看关联计划的状态、最近一次启动的工作进度和累计模型用量，也可以由你主动开始、暂停、停止或接管。显示的进度对应那次启动，不能直接代表计划当前状态；团队成员的进度暂未展示。普通计划暂停或被接管后，可以重新核对并确认继续；团队和 MCP 计划需要走各自的恢复流程或建立新计划。只有当前会话保留了直接确认的回执时才能开始。恢复方式和限制见[工作计划](docs/work-plans.md)。

工作台默认屏蔽浏览器刷新、前进/后退、打印、查看源码与另存网页等快捷键，防止误触中断编辑流程。`Ctrl+S`（macOS 为 `Command+S`）用于保存当前编辑器草稿，输入框原生编辑菜单与 `Ctrl+C` / `Command+C` 复制保持正常可用。

## 架构

```text
React 19 + TypeScript 7 + i18next
               │
            Tauri 2
               │
           Rust Core
               │
   Language-neutral Capability Protocol
               │
Workers / Domain Plugins / Agent Service
```

前端负责状态展示与操作发起，所有状态转换、SQLite 持久化、并发保护与结果采纳均由 Rust Core 控制。耗时的领域能力在独立 Worker 进程中运行，通过与语言无关的协议与 Core 通信，公开扩展契约不绑定 Rust ABI。

## 开发环境

### 环境要求

- **支持平台**：Windows x64 与 macOS（Apple Silicon 及 Intel 构建目标，最低系统版本 macOS 11）
- **开发工具链**：Rust 1.98+、Node.js、pnpm 12、Vite 8、Tauri 2
- **Windows 原生依赖**：Visual Studio C++ Build Tools、Windows SDK、Microsoft Edge WebView2 Runtime
- **macOS 原生依赖**：Xcode Command Line Tools（使用系统 `WKWebView`）

各平台依赖安装方式可参考 [Tauri 环境准备指南](https://v2.tauri.app/start/prerequisites/)。

### 构建与运行

在仓库根目录执行：

```sh
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

构建不带安装器的 Windows 独立可执行程序（内嵌前端资源，运行需系统具备 WebView2 Runtime）：

```sh
pnpm --dir apps/desktop tauri build --no-bundle
# 产物路径：target/release/tsumugi-desktop.exe
```

在 macOS 上构建应用包：

```sh
pnpm --dir apps/desktop tauri build
open target/release/bundle/macos/Tsumugi.app
```

在 Apple Silicon 上交叉编译 Intel 版本时，需先安装 Rust 的 `x86_64-apple-darwin` target 并传入 `--target x86_64-apple-darwin`。代码签名、公证与分发流程独立于本地构建。

### 协议契约生成与文本偏移

项目生命周期、执行、源内容、译文、资源、审阅、发布、AI、Arena、连接、插件、策略及 MCP 等桌面 IPC DTO 均以 Rust/Serde 定义为单一事实来源。修改相关定义后，需重新生成并校验仓库内的 JSON Schema、TypeScript 类型与预编译校验器：

```sh
pnpm --dir apps/desktop generate:contracts
pnpm --dir apps/desktop check:contracts
```

可通过 `--domain=<名称>` 仅更新或检查指定领域（如 `--domain=project`、`--domain=execution`、`--domain=source`、`--domain=translation`、`--domain=resource`、`--domain=review`、`--domain=release`、`--domain=ai`、`--domain=arena`、`--domain=connections`、`--domain=plugins`、`--domain=strategy`、`--domain=mcp`、`--domain=mcpRetrieval`）。契约生成使用可选的 `wire-schema` Cargo feature，应用在运行时不会动态编译 Schema。

源内容与译文的捕获范围采用原始文件字节流中左闭右开的 UTF-8 字节偏移（位于转义解码与换行符规范化之前），而非 JavaScript 的 UTF-16 字符串索引。共用测试集 `crates/core/tests/fixtures/source-unicode.contract.json` 覆盖了 BOM、CRLF、中文字符、emoji、组合字符及 JSON 转义在 Rust 与 TypeScript 两侧的对照验证。

### 存储格式、诊断与测试宿主

- **数据库 Schema**：当前项目使用 SQLite schema **65**，采用 `DELETE` 日志模式与 `FULL` 同步级别。有效的 schema 61、62、63 或 64 项目会在打开时通过单个事务升级，保留原有内容、对话、规划历史、提议版本、计划、团队讨论和回执；升级中断后，数据库保持升级前的完整格式或完整的 schema 65。更早的开发格式和不支持的存储配置仍会被拒绝，不会重置目录。不支持的存储配置仍返回 Rust 的 `PersistenceError::UnsupportedStorage`，或桌面 IPC 的 `unsupported-schema` 与 `reason: "storage-mode"`。旧客户端不能打开升级后的 schema 65 项目；不受支持的旧目录请原样保留，再在新项目中重新导入原始源文件。
- **结构化诊断与恢复**：命令失败时会保留原始结构化证据。若保存时底层基准已发生变化，可展开诊断面板对照提交值与当前值，并按提示执行下一步读取或决策，系统不会自动重放写入。命令边界日志通过诊断编号关联，仅记录操作标签与错误分类，不包含请求正文或本地工程路径。
- **执行测试宿主**：开发调试时可使用隔离的[执行测试宿主](docs/execution-test-host.md)，在不接入外部翻译模型的情况下验证任务进度、取消与恢复流程。

## 版本与状态

当前代码库处于尚未发布的 **`0.2.0-alpha.1`** 开发批次。最近变更、兼容性边界与版本管理规则详见[更新日志](CHANGELOG.zh-CN.md)与[版本管理策略](docs/versioning.md)。
