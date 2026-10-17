# Airtl for VS Code

作者：Airtl yu

联系邮箱：yuairtl@outlook.com

Airtl 在 VS Code 中展示 Vivado 工程的模块层次、设计源、仿真源、约束和模块连接图。
支持从 `.xpr`、指定顶层的 Tcl 脚本或 HDL 源文件选择工程来源。

## 推荐运行版本

- **Visual Studio Code 1.126.0 或更高版本**。1.126 于 2026 年 6 月 24 日发布，建议使用此版本之后的版本；旧版本未经过完整兼容性测试。
- **OpenCode 1.18.35**。这是当前完成集成验收的版本；其他版本未逐一验证。

RTL 解析、工程文件收集、模块图、端口与总线处理、布局和改线计算由编译后的
`airtl.node` 原生库完成。模块树与 BD 面板复用同一份原生工程快照。

## 安装

在 VS Code 扩展面板选择 **Install from VSIX**，打开对应的 Windows x64 安装包；
也可运行 `code --install-extension airtl-<版本>-win32-x64.vsix`。
原生库随安装包提供，无需单独安装 C/C++ 编译器或第三方 C 运行库。

## 使用

1. 打开包含 Vivado 工程或 HDL 源码的工作区。
2. 在源码树中选择工程来源；已有选择保存在工作区的 `.vscode/vivado-project.json`。
3. 查看 Design Sources、Simulation Sources 和 Constraints。
4. 打开模块连接图，查看模块、端口、总线与连线；通过节点命令跳转源码。

文件变更后刷新视图。RTL 改线通过 VS Code 的 WorkspaceEdit 应用，可用 Ctrl+Z 撤销。

## 界面语言

扩展界面跟随 VS Code 的显示语言：中文环境显示中文，其他语言环境显示英文。
在命令面板运行 **Configure Display Language**，选择语言后重启 VS Code 即可切换。

## AI 资源

发布包中的 `prompts/` 与 `ref_skill/` 文件仅包含 `需写入prompts ` 占位内容。
使用相应流程前需提供所需内容。运行时资源位于 `C:/userconfig/rtlassistant/`；
具体 AI 工具与模型在扩展设置中选择。

## 授权

内置默认授权截止于 **2027-01-01 00:00:00 UTC**。正式授权文件可按授权规则覆盖默认授权。

The built-in default authorization expires at **2027-01-01 00:00:00 UTC**. A valid license file can replace the default authorization.

## 发布内容

发布版本包含 VS Code 扩展运行文件与编译后的原生库。C/C++ 源码、构建工具、
测试、调试符号和开发期参考实现不随 VSIX 发布。

可读源码与文档按 Apache License 2.0 授权；编译后的原生核心按独立授权规则管理。
具体许可边界见 `LICENSE` 和 `LICENSE-APACHE-2.0`。

如有问题，请提供扩展版本、所选工程来源和 Output 面板中的错误信息。
