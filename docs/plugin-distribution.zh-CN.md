# 固定扩展的离线发行准备

如需手动导入本地扩展包集合，请参阅[手工离线扩展包](offline-packs.md)；如需使用带签名的本地更新目录，请参阅[签名离线仓库](offline-repositories.md)。

可选的 Apple silicon（`aarch64`）macOS 桌面发行包内置了固定版本的 Node/Host 运行环境（要求 macOS 13.5 或更高版本），以及 **WebVTT** 和 **SMAPI** 两个预构建扩展包。终端用户直接运行打包后的桌面应用即可，无需安装 Node.js、Rust、Python、`pnpm` 或 Git。本文介绍开发者如何在离线构建环境中准备并打包这些内置扩展资源。

当前配置使用为 [Mac 应用实验预发布](experimental-release.zh-CN.md) 构建的未签名实验插件归档。

## 输入与责任

### 桌面端内置清单（`bundled-plugins.macos-aarch64.json`）

桌面应用通过 [`bundled-plugins.macos-aarch64.json`](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json) 管理随附扩展。每个条目固定以下字段：
- 插件身份（publisher、ID）与版本号
- 公开源码仓库地址与提交哈希
- 完整的 Host `packageDigest`
- 传输归档文件名（`archiveName`）及其 SHA-256 摘要
- 精确的 SDK 产物与版本

该清单同时锁定了目标平台、运行环境 profile 与 SDK process protocol。构建脚本和桌面安装流程都会严格校验这些固定值，而不会仅凭相同的 `0.1.0-alpha.1` 版本号推定兼容。

当前锁定的 WebVTT 与 SMAPI 候选包通过 SDK helpers 保留源码提取的上下文事实及源码修订号（revision）；WebVTT 包还支持从捕获的目标语言 `.vtt` 文件导入既有译文（经独立语义检查后逐条确认采纳）。升级随附候选包时，必须同步更新源码提交、SDK 产物、传输归档 SHA-256 以及完整的 Host `packageDigest`。

### 插件发布归档

[公开插件仓库](https://github.com/Anpimi/tsumugi-plugins)负责插件构建、文件配方、领域依赖以及确定性的未压缩 `.tar` 归档。

在执行准备脚本前，请下载与清单匹配的发布归档，并在本地目录中分别命名为 `webvtt.tar` 和 `stardew-smapi.tar`：
- [WebVTT（`webvtt/v0.1.0-alpha.1`）](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/webvtt/v0.1.0-alpha.1)
- [SMAPI（`stardew-smapi/v0.1.0-alpha.1`）](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/stardew-smapi/v0.1.0-alpha.1)

请核对归档文件的传输 SHA-256 是否与 `bundled-plugins.macos-aarch64.json` 一致。准备脚本完全离线运行——若归档缺失会直接报错，不会联网拉取分支或重新编译替代产物。请注意：传输 SHA-256 校验的是 `.tar` 归档字节，而 `packageDigest` 由 Rust Host 根据解包后的完整文件内容与可执行权限位计算得出。

## 准备与构建

1. **准备 JavaScript Host 与 Node 运行环境**：在可信构建环境中按[运行环境准备说明](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact)准备好已编译的 Host、生产依赖和固定版本的 Node 分发包。
2. **放置插件归档**：将核验无误的 `webvtt.tar` 和 `stardew-smapi.tar`（与清单中的 `archiveName` 一致）放入同一个本地目录。
3. **构建检查程序并生成内置资源**：确认本地已备妥 Python 3.11+、Cargo 离线依赖缓存，以及[Pi 成员产物](../runtimes/agent-service/README.md)所需的冻结依赖与当前平台 `esbuild` 二进制，然后在仓库根目录执行：

```sh
cargo build --locked --offline -p tsumugi-plugin-host --bin tsumugi-plugin-package
python3 runtimes/javascript-host/scripts/prepare-desktop-plugins.py \
  --artifacts /absolute/approved/plugin-candidates \
  --inspector /absolute/project/target/debug/tsumugi-plugin-package \
  --inspector-sha256 <reviewed-inspector-sha256> \
  --output /absolute/project/apps/desktop/src-tauri/resources/bundled-plugins
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json
```

### 暂存与校验机制

- **路径与输出目录要求**：所有传入路径均须为绝对路径，且不得包含符号链接祖先目录（macOS 系统固定的 `/tmp` 与 `/var` 别名除外）。父目录 `apps/desktop/src-tauri/resources` 必须已存在，而 `bundled-plugins` 和 `member-runtime` 两个输出目录必须尚不存在（前端构建和 Cargo `build.rs` 均不会自动生成或刷新 `member-runtime`）。
- **归档与包体积限制**：归档必须是单硬链接的普通文件，且内部仅包含路径规范、可移植的普通文件——拒绝路径穿越、符号/硬链接、稀疏或特殊文件、重复/重叠路径以及配方外或缺失的文件。单个包最多包含 256 个文件、路径深度最多 16 层、内容上限 64 MiB；整组内置包的总内容同样不超过 64 MiB。
- **隔离检查与原子交付**：`prepare-desktop-plugins.py` 将输入归档及校验过 `--inspector-sha256` 的 `tsumugi-plugin-package` 二进制副本复制到仅当前用户可访问的新建暂存目录中。准备过程只运行该检查程序副本（有执行时间和输出上限），绝不运行插件代码、Node、Host 组件或包脚本。检查程序会独立核验每个包的身份、`packageDigest`、manifest 字节、文件数、字节数以及随附的 `sdk.lock.json`。核验通过后，脚本统一设置权限（目录与可执行文件为 `0755`，普通文件为 `0644`，不受构建环境 `umask` 影响），并通过平台原生的 no-replace rename 一次性原子交付到 `--output`。
- **桌面端打包**：生成的 `preparation.json` 仅记录公开清单固定值、检查程序摘要和包摘要，不包含本机路径。执行 `tauri build` 时，桌面构建流程会重新通过 Host 校验插件包、JavaScript 运行环境以及 `member-runtime` 目录树（确保入口存在且协议与 Core 生成的 profile 一致），并将它们打包进 macOS `aarch64` 应用中。

## 失败与既有安装

若遇到归档损坏、来源/身份/SDK 产物不匹配、输入文件被修改、存在多余文件、Host 检查不通过或输出目录已存在，准备脚本会立即中止且不会创建最终输出目录。若在暂存阶段失败，同级目录下可能保留 `.tsumugi-plugins-*` 临时目录供排查；请先审阅并清理失败的暂存目录或指定新的输出路径，切勿直接覆盖已核验的资源目录。

在打包后的桌面应用中，用户可通过 **扩展 → 使用随附扩展** 审阅并安装内置扩展：
- 安装过程沿用与手动导入本地包相同的捕获、带修订号的设置以及 PackageStore 写入边界，保留既有的启用状态，且不会替换正在运行的任务所绑定的环境。
- 若安装过程被中断，系统会保留原请求供用户核对或重试；即使后续版本不再随附安装包资源，本机已安装的扩展和批准记录依然可用。
- 在项目中实际运行插件时，仍须核验所选运行环境、当前批准状态并单独确认执行授权。

在正式分发前，请务必在断网、未安装任何开发工具链的清洁 Apple silicon macOS 系统上验证最终安装包或便携产物，完整测试初始设置、应用重开、WebVTT 与 SMAPI 两个领域的工作流、资源缺失/损坏处理以及更新与卸载边界。

[English](plugin-distribution.md)
