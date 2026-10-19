# 固定扩展的离线发行准备

可选 Apple silicon macOS 桌面发行物携带固定的 Node/Host 运行环境，以及独立的
WebVTT 和 SMAPI 两个预构建包；随附运行环境要求 macOS 13.5 或以上。使用组装后的
应用不要求用户安装开发用 Node、Rust、Python、pnpm 或 Git。准备和构建应用属于
开发操作，不承诺空机器可以离线从源码构建。

当前组合仍是实验性、未分发的候选。准备命令不证明签名发行、可信网络更新、
完整 Host/Worker 兼容性或清洁系统离线运行已经通过。

## 输入与责任

应用拥有
[`bundled-plugins.macos-aarch64.json`](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json)。
每个条目固定独立的插件身份/版本、声明的公开源码仓库与提交、完整 Host 包摘要、
传输归档文件名与 SHA-256，以及准确 SDK 产物/版本。整组选择另固定平台、运行环境
profile 和 SDK process protocol。构建与应用设置会拒绝不同 profile/protocol，
不能仅凭相同 alpha 版本推定兼容。

当前候选通过固定 SDK helpers 保留源码提取的上下文事实及准确源码 revision。
更新候选时须一并刷新源码提交、SDK 产物、传输摘要和完整 Host 包摘要；仅凭相同
alpha 版本选择旧归档，可能丢失这些能力。

[公开插件仓库](https://github.com/Anpimi/tsumugi-plugins)拥有包生产、文件配方、领域
依赖和确定性的未压缩候选 `.tar`。应通过已批准的产物供应流程取得与清单匹配的准确
字节。清单目前没有已发布的产物下载地址，准备器不联网、不检出源码、不编译依赖。
归档缺失会报错，不因此下载某个分支或重新构建另一候选。

传输 SHA-256 固定归档字节；`packageDigest` 由原 Rust Host 按完整包内容和可执行位
计算，是另一种身份。两种摘要都不认证发布者。声明的源码提交与随包 SDK 来源记录
也不能独立证明构建来源。应用构建固定值、本机批准、安装回执、项目选择和执行授权
仍由各自边界负责。

## 准备与构建

先按[运行环境准备说明](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact)
准备当前已编译 Host、生产依赖与固定 Node 分发包。使用可信构建环境；该准备仅提供
固定工具文件与清洁 Host 树。准备报告和本机包管理器缓存不授予权限，也不替代运行依赖。

将两个完整、已批准的归档置于同一已有目录，文件名须与清单的 `archiveName` 一致。
构建并明确审阅 `tsumugi-plugin-package` 检查程序及其 SHA-256，再使用 Python 3.11
或以上执行。同时从同一 checkout 准备应用的独立
[Pi 成员产物](../runtimes/agent-service/README.md)，其冻结依赖与当前平台的 esbuild
二进制须已离线备妥。以下命令从仓库根执行；准备器不调用安装器或下载运行依赖：

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

资源父目录必须已存在，两处输出都必须是新目录。成员打包直接编译源码，前端构建和
Cargo build script 不生成或刷新该产物；应明确审阅旧输出或使用新 checkout，不覆盖
既有产物。所有输入路径使用绝对路径，不经过符号链接
祖先；仅允许 macOS 固定的 `/tmp`、`/var` 系统别名。归档必须是有界、单硬链接的普通
文件。准备器先捕获实际归档字节，仅物化这些字节，不转而读取后来替换的路径。

传输格式仅接受路径规范、可移植的普通文件，拒绝路径逃逸、别名、重复/重叠路径、
链接、稀疏/特殊成员，以及配方之外或缺失的文件。每包最多 256 文件、路径最多 16 段、
内容最多 64 MiB；整组选择的内容总量也不超过 64 MiB。随包 SDK lock 必须与选定 SDK
准确产物和版本一致。固定 Host 检查程序独立验证实际 manifest 和完整包摘要；仅传输
摘要匹配不足以交付资源。

所有文件先写入新建、仅 owner 可访问的暂存目录。只执行具有已审阅摘要的检查程序
捕获副本；不运行插件、所选 Node、Host 组件或包脚本。检查有时间和输出上限，其身份、
包摘要、manifest 字节、文件数和字节数必须全部一致。准备器复核捕获的输入与完整输出
字节/可执行位后，以平台原生的 no-replace rename 一次性交付整组包。最终包目录权限
为 `0755`，普通文件 `0644`，可执行文件 `0755`；可执行位与已检查产物保持一致，
不受构建者 umask 影响。

输出内的 `preparation.json` 仅记录公开选择固定值、检查程序摘要和包观察，不包含本机
输入路径。桌面构建再次通过原 Host 捕获实际包与运行环境，并嵌入构建拥有的元数据，
不会将该报告当作批准。Tauri 按逻辑资源路径携带完整包、工具和 Host 树。独立成员树
通过实际执行时相同的 Host 产物 owner 捕获；入口缺失或协议与 Core 生成 profile
不符都会阻止构建。它只使用独立批准的 Node 工具，不成为插件 Process 通道；准确
Node 分发固定值仍归既有运行环境准备入口。当前入口仅
支持清单选择的 macOS arm64 构建者与目标。

## 失败与既有安装

归档损坏、来源/身份/SDK 产物不符、输入变化、额外文件、Host 检查异常或依赖缺失，
都会停止准备。不会回退到旧清单、内嵌解析器、开发 checkout、PATH 运行时或临时源码
编译。准备失败不会新建最终输出，但可能在旁边保留本次 `.tsumugi-plugins-*` 暂存目录
供检查。已有输出在读取输入前即拒绝；并发创建的空目录也不会被替换。只清理明确审阅过
的失败尝试，或改用新输出，不覆盖已有已核验资源以强行重试。原子交付成功后如暂存清理
异常，会单独报告；完整输出仍可检查。

应用中通过 **扩展 → 使用随附扩展** 审阅并安装。设置沿用手工包相同的捕获、带修订
设置和 Store 安装边界，保留既有启用选择；结果不确定时保留原请求以核对。取得资源
消失后，已安装字节和本机决定仍可保留。新执行仍须核验实际选择的环境、当前批准、
支持平台和独立授权的 Core 操作。更新随附包不会替换在途 attempt 捕获的环境。

分发前仍须在断网、无开发工具链的清洁支持系统上检查最终安装/便携产物、两个包及完整
运行环境，并覆盖设置、重开、两领域、损坏/缺失资源、既有决定和卸载/更新边界。准备器
与传输测试的证据范围小于这些完整验收。

[English](plugin-distribution.md)
