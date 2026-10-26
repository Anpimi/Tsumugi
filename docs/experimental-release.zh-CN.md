# Mac 实验预发布

`0.2.0-alpha.1` 是面向 macOS 13.5 及更高版本 Apple silicon Mac 的未签名实验预发布版。

## 内置组件与配置隔离

归档内置固定版本的 Node `26.10.0` 组件 Host、Pi 成员运行环境，以及独立的 WebVTT 和 Stardew SMAPI `0.1.0-alpha.1` 插件包；应用目录固定了它们的源码、SDK 与完整包身份。安装应用不会更改现有项目绑定或自动授予执行权限——插件的批准、安装、启用及每次执行仍需在应用内分别确认。

应用名称为 **Tsumugi Experimental**，使用独立的 `com.tsumugi.experimental` 应用数据标识，不会自动读取其他构建版本的 profile。准备好固定运行环境资源后，可在运行环境配置之上叠加实验配置进行本地构建：

```sh
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json --config src-tauri/tauri.experimental.conf.json --no-sign -- --locked --offline
```

## 项目兼容性与模型连接

- **数据库架构**：请先使用合成项目或测试项目进行验证。本构建仅支持项目数据库 schema `61`；更早期的开发目录会被直接拒绝，不会自动迁移或重置。请保留旧目录并在新建项目中重新导入原始源文件。支持的文件格式与工作流限制详见[支持的集成](integrations.md)与[更新日志](../CHANGELOG.zh-CN.md)。
- **模型连接**：本快照提供 API Key 连接流程（未包含实验性的 ChatGPT 账户登录连接）。安装与启动过程不会发起任何模型请求，每次向真实 Provider 发送请求前均需在应用内确认范围、数据分享与预算授权。

## 签名状态与当前限制

- **未签名分发**：本预发布版未经 Apple 开发者身份代码签名或公证。随附的下载清单与校验和仅用于核对归档字节完整性，不提供 Apple 公证、可信插件更新、自动更新器或生产环境 TUF 仓库。测试本版本时请勿更改系统安全设置或钥匙串（Keychain）权限。
- **适用范围与验证边界**：本构建仅面向 Apple silicon macOS；Intel Mac、Windows 及大型项目不在支持范围内。此外，真实 Provider 译文质量、实际用量与费用核对、独立人工评估、全新系统离线首次启动，以及完整的无障碍与极端环境用例（读屏软件、输入法组合输入、极端字号与视口缩放、受控系统外观切换及物理 IPC 饱和退出等）尚未完成全面验证。
