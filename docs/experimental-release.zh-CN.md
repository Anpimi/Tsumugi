# Mac 实验预发布

`0.2.0-alpha.1` 是面向 macOS 13.5 或以上 Apple silicon Mac 的未签名实验应用。
归档包含固定 Node 26.10.0 组件 Host、Pi 成员运行环境及独立 WebVTT／SMAPI
`0.1.0-alpha.1` 包；应用清单固定其源码、SDK 与完整包身份。插件批准、安装、
启用及每次执行仍须分别决定。安装应用不会替换已有项目绑定或授予执行许可。

应用名为 **Tsumugi Experimental**，使用独立的 `com.tsumugi.experimental`
应用数据标识，不自动打开其他构建的 profile。固定资源准备好后，构建命令在运行环境
profile 之上叠加该实验标识：

```sh
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json --config src-tauri/tauri.experimental.conf.json --no-sign -- --locked --offline
```

请先使用合成或可丢弃项目。仅支持当前项目 schema 61；应用拒绝更早的开发目录，
不自动迁移或重置。请保留旧目录，在新项目重新导入原始源文件。格式及工作流限制见
[支持的集成](integrations.md)和[更新日志](../CHANGELOG.zh-CN.md)。

该预发布没有 Apple 开发者身份代码签名或公证。下载清单和校验值仅标识所提供字节，
不代表 Apple 认可、可信插件更新或生产 TUF 仓库；没有自动更新器。测试此版本时
不要更改系统安全或钥匙串权限。

真实 Provider 译文质量、实际用量与费用、独立人工评估及清洁系统离线首次使用仍未验。
大项目、Windows 执行、Intel Mac 及其他未验平台不在本产物支持范围内。
真实读屏／IME、精确字号／视口、受控系统外观和物理 IPC／饱和退出等细项也未全部验证。
发布此实验快照不表示这些检验或整体重构已经完成。

本快照不包含实验中的 ChatGPT 账户连接；原 API Key 连接流程保留。
任何真实 Provider 请求仍须经过应用自身的范围、数据分享与预算同意；安装和启动
不会派发模型请求。
