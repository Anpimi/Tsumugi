# 固定扩展的离线发行准备

如需手动导入本地扩展包集合，请参阅[手工离线扩展包](offline-packs.md)；如需使用带签名的本地更新目录，请参阅[签名离线仓库](offline-repositories.md)。

macOS 13.5+ Apple silicon 和 Windows 11 x64 的完整打包配置包含固定版 Node/Host 运行环境和预构建的 **WebVTT**、**SMAPI** 扩展包。桌面应用的运行环境随包提供，用户无需安装 Node.js、Rust、Python、`pnpm` 或 Git。开发者需按目标平台清单准备指定归档。

当前开发配置使用未签名的 Process 4 插件候选包。[已发布的 Mac 预发布版本](experimental-release.zh-CN.md)保留其原有包清单。

## 平台与构建支持

下表说明当前源码能力与打包约束，不代表新发行或干净机器验收结论。具体构建和安装仍可能缺少某项能力。

| 能力 | Apple Silicon macOS 13.5+ | 其他桌面目标 |
|---|---|---|
| 桌面壳、已保存内容的人工编辑 | 已有 macOS 源码路径 | 保留 Windows x64、Intel Mac 源码路径；当前完整包未验 |
| 本机预构建包检查 | 只读目录指纹和声明诊断 | Windows x64 源码构建可用 `tsumugi-plugin-package` 检查数据和 JavaScript 扩展目录 |
| 本机扩展与运行时存储 | 应用管理安装与设置回执 | Windows x64 在本地 NTFS 的专用存储中使用相同的批准与恢复流程 |
| SMAPI／WebVTT 导入、检查与导出 | 需要固定插件包、已批准的 Node／Host，以及逐次执行许可 | Windows 11 x64 候选使用独立的固定清单，沿用相同的运行时批准和执行许可 |
| Skyrim SE 开发集成 | [独立候选包与匹配的原生 Host](integrations.md#skyrim-se-development-package) 已在桌面应用导入 64 MiB、50,000 字段的合成 ESP，导出经独立检查、全部保留原文的构建，并在重开后读回回执。两版更新维护另用较小的合成 Mod 验证 | Windows 桌面处理与 Skyrim SE 实际游戏加载仍待验证 |
| OpenAI 兼容 API Key 直接请求 | 已有 Core transport；macOS Keychain 或明确选择的环境变量 | Windows x64 源码构建可用 Windows 凭据管理器或明确选择的环境变量 |
| Pi 成员与动态团队 | 需要成员产物和已安装、批准的随附 Node，以及明确请求许可 | Windows x64 候选使用固定版 Node 和 Pi 产物，完整桌面和团队流程仍待验收 |
| ChatGPT 订阅登录 | macOS Keychain 实现；账号与外发许可另行确认 | 当前桌面凭据实现不支持 |
| 完整离线应用包 | 在 Apple silicon 构建机使用 `tauri.runtime.conf.json` | Windows 11 x64 MSVC 构建使用 Windows 配置覆盖，随附 WebView2 离线安装程序 |

保存连接不代表模型兼容性测试；安装资源也不授予外发许可。macOS 和 Windows x64 的桌面密钥输入及环境变量方式见 [AI 翻译说明](ai-translation.md)。Provider 与完整平台验收另有记录。

## 首次运行与离线样例

1. 打开完整应用，进入**设置 → 扩展**。“已安装”显示成员文件是否符合本应用协议；读取不执行插件、不访问凭据、不调用模型。
2. 选择**核对随附资源安装 → 发现**，核对随附 WebVTT／SMAPI 与运行环境，明确批准“安装内置扩展”。已有启停选择保留。中断或结果不明时使用“重试原操作”，随后刷新原库存，不另装无关插件。
3. 运行环境仍未安装或批准时，使用“已安装”中的原控制项。成员文件缺失或不兼容需要完好的完整应用；只安装 Node 无法修复。无资源的源码桌面壳须按下文重新构建。
4. 将公开[首次运行样例](../examples/first-run/README.md)复制到可写本地目录。创建项目，在“源内容”选择 WebVTT，选择样例目录，核对捕获材料，分别授权提取／检查后确认采用。人工编辑并明确保存一条译文，关闭重开确认保留；无需配置连接或调用模型。
5. 导出按[构建与交付](build-release.md)的原流程执行；检查、审阅批准及最终导出仍分别确认。人工样例不证明模型质量、干净机器支持或游戏兼容。

## 输入与责任

### 桌面端内置清单

桌面应用通过 [macOS 清单](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json)和 [Windows 清单](../apps/desktop/src-tauri/bundled-plugins.windows-x86_64.json)管理随附扩展。每个条目固定以下字段。
- 插件身份（publisher、ID）与版本号
- 公开源码仓库地址与提交哈希
- 完整的 Host `packageDigest`
- 传输归档文件名（`archiveName`）及其 SHA-256 摘要
- 精确的 SDK 产物与版本

该清单同时锁定了目标平台、运行环境 profile 与 SDK process protocol。构建脚本和桌面安装流程都会严格校验这些固定值。

应用打包按当前 SDK 和 Process 4 核对清单。旧插件需要用匹配的 SDK 重建，并同步更新源码提交、SDK 归档、插件摘要和传输摘要。

当前锁定的 WebVTT 与 SMAPI 候选包通过 SDK helpers 保留源码提取的上下文事实及源码修订号（revision）；WebVTT 包还支持从捕获的目标语言 `.vtt` 文件导入既有译文（经独立语义检查后逐条确认采纳）。升级随附候选包时，必须同步更新源码提交、SDK 产物、传输归档 SHA-256 以及完整的 Host `packageDigest`。

### 插件发布归档

[公开插件仓库](https://github.com/Anpimi/tsumugi-plugins)负责插件构建、文件配方、领域依赖以及确定性的未压缩 `.tar` 归档。

将与清单完全匹配的归档放入同一个本地目录，分别命名为 `webvtt.tar` 和 `stardew-smapi.tar`。可使用与清单一致的发布产物。当前 Process 4 开发版清单使用 WebVTT 和 SMAPI 的 `0.1.0-alpha.2` 归档。在插件仓库检出条目固定的 `sourceCommit`，沿用对应的 SDK 锁定信息，按[候选构建流程](https://github.com/Anpimi/Tsumugi-plugins#build-and-check-all-independent-candidates)生成 `.tar`。

按目标平台清单核对归档的传输 SHA-256。传输 SHA-256 覆盖 `.tar` 文件字节，Rust Host 根据解包后的清单、文件内容和可执行权限位计算 `packageDigest`。准备脚本仅使用给定归档。

## 准备与构建

### Apple silicon macOS

使用可信的 Apple Silicon macOS 13.5+ 构建机，准备 Rust 1.98+、Node 26.10.x、pnpm 12、Python 3.11+，并[配置原生构建所需的 libclang](build-release.md#native-application-build-prerequisites)。离线工作前先获取冻结依赖、[`node-distribution.macos-aarch64.json`](../runtimes/javascript-host/scripts/node-distribution.macos-aarch64.json)固定的 Node 归档和上文清单匹配的插件归档。准备命令不会下载替代品。

从仓库根目录先安装冻结依赖并构建 Host，production deploy 必须包含已编译的 `dist`：

```sh
pnpm install --frozen-lockfile
pnpm --dir runtimes/javascript-host build
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/host-deploy
cargo build --locked --offline -p tsumugi-plugin-host --bin tsumugi-plugin-runtime --bin tsumugi-plugin-package
mkdir -p apps/desktop/src-tauri/resources
node runtimes/javascript-host/scripts/prepare-desktop-runtime.mjs \
  --node-archive /absolute/approved/node-v26.10.0-darwin-arm64.tar.xz \
  --host-source /absolute/new/host-deploy \
  --inspector "$PWD/target/debug/tsumugi-plugin-runtime" \
  --output "$PWD/apps/desktop/src-tauri/resources/javascript-runtime"
```

设置了 `CARGO_TARGET_DIR` 时使用真实 target 路径。核对本地构建的包检查程序后，用其摘要进入原有准备边界（macOS 命令为 `shasum -a 256 <inspector>`）：

```sh
python3 runtimes/javascript-host/scripts/prepare-desktop-plugins.py \
  --artifacts /absolute/approved/plugin-candidates \
  --inspector /absolute/project/target/debug/tsumugi-plugin-package \
  --inspector-sha256 <reviewed-inspector-sha256> \
  --output "$PWD/apps/desktop/src-tauri/resources/bundled-plugins"
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json
```

未覆盖 target 时，产物为 `target/release/bundle/macos/Tsumugi.app`。候选记录保留应用源码提交、选定清单、Node pin 和成员协议。普通 `tauri build` 不会选择此配置，不能当作完整资源包。本地候选不等于上传、签名或公证发行；新的分发前须按[版本策略](versioning.md)递增已冻结的预发布版本。

### Windows 11 x64

在 Windows 11 x64 构建机使用 `x86_64-pc-windows-msvc` 工具链和[原生依赖](build-release.md#native-application-build-prerequisites)，沿用上文锁定的 Host 和成员构建命令。准备 JavaScript 运行时使用[固定的 Windows Node ZIP](../runtimes/javascript-host/scripts/node-distribution.windows-x86_64.json)和 Windows 原生的 `tsumugi-plugin-runtime.exe`。

在 macOS 或 Linux 上使用该平台原生的包检查器准备 Windows 插件归档。运行 `prepare-desktop-plugins.py` 时加入 `--platform windows-x86_64`，再将核验后的目录树复制到 Windows 构建机的 `apps/desktop/src-tauri/resources/bundled-plugins`。Windows 构建会按自身目录清单重新核验。将已准备的运行时和成员产物分别放入 `resources/javascript-runtime` 和 `resources/member-runtime`。

在仓库根目录通过 PowerShell 执行以下命令。Tauri 在构建机上获取 NSIS 和 WebView2 离线安装程序时可能需要网络。

```powershell
pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json --config src-tauri/tauri.runtime.windows.conf.json -- --locked
```

使用默认 Cargo 产物位置时，安装包位于 `target/release/bundle/nsis`。候选记录随安装包保留准确的应用源码、插件清单、Node 固定值和成员协议。

### 暂存与校验机制

- **路径与输出目录要求**：所有传入路径均须为绝对路径，且不得包含符号链接祖先目录（macOS 系统固定的 `/tmp` 与 `/var` 别名除外）。父目录 `apps/desktop/src-tauri/resources` 必须已存在，而 `javascript-runtime`、`bundled-plugins` 和 `member-runtime` 三个输出目录必须尚不存在（前端构建和 Cargo `build.rs` 均不会自动生成或刷新 `member-runtime`）。
- **归档与包体积限制**：归档必须是单硬链接的普通文件，且内部仅包含路径规范、可移植的普通文件——拒绝路径穿越、符号/硬链接、稀疏或特殊文件、重复/重叠路径以及配方外或缺失的文件。单个包最多包含 256 个文件、路径深度最多 16 层、内容上限 64 MiB；整组内置包的总内容同样不超过 64 MiB。
- **隔离检查与原子交付**：`prepare-desktop-plugins.py` 将输入归档及校验过 `--inspector-sha256` 的 `tsumugi-plugin-package` 二进制副本复制到仅当前用户可访问的新建暂存目录中。准备过程只运行该检查程序副本（有执行时间和输出上限），绝不运行插件代码、Node、Host 组件或包脚本。检查程序会独立核验每个包的身份、`packageDigest`、manifest 字节、文件数、字节数以及随附的 `sdk.lock.json`。核验通过后，脚本统一设置权限（目录与可执行文件为 `0755`，普通文件为 `0644`，不受构建环境 `umask` 影响），并通过平台原生的 no-replace rename 一次性原子交付到 `--output`。
- **桌面端打包**的 `preparation.json` 记录公开清单固定值、检查程序摘要和包摘要。打包前，Rust 构建流程按平台清单和 Core 的成员 profile 重新核验插件包、JavaScript 运行环境和 `member-runtime`。

## 失败与既有安装

若遇到归档损坏、来源/身份/SDK 产物不匹配、输入文件被修改、存在多余文件、Host 检查不通过或输出目录已存在，准备脚本会立即中止且不会创建最终输出目录。若在暂存阶段失败，同级目录下可能保留 `.tsumugi-plugins-*` 临时目录供排查；请先审阅并清理失败的暂存目录或指定新的输出路径，切勿直接覆盖已核验的资源目录。

在打包后的桌面应用中，用户可通过 **设置 → 扩展 → 发现 → 安装内置扩展** 审阅并安装内置扩展：
- 安装过程沿用与手动导入本地包相同的捕获、带修订号的设置以及 PackageStore 写入边界，保留既有的启用状态，且不会替换正在运行的任务所绑定的环境。
- 若安装过程被中断，系统会保留原请求供用户核对或重试；即使后续版本不再随附安装包资源，本机已安装的扩展和批准记录依然可用。
- 在项目中实际运行插件时，仍须核验所选运行环境、当前批准状态并单独确认执行授权。

在正式分发前，请务必在断网、未安装任何开发工具链的清洁 Apple silicon macOS 系统上验证最终安装包或便携产物，完整测试初始设置、应用重开、WebVTT 与 SMAPI 两个领域的工作流、资源缺失/损坏处理以及更新与卸载边界。

[English](plugin-distribution.md)
