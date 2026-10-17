# Airtl for VS Code

Author: Airtl yu<br>
Email: yuairtl@outlook.com<br>
WeChat Official Account: Airtl<br>
X: @yuairtl

Airtl 是面向 RTL/FPGA/FPSoC 开发的 VS Code 插件，提供模块源码树、Block Design View 和 AI 开发工作流。产品目标是逐步整合原理图、PCB、FPGA 与嵌入式软件开发，让用户在同一环境中完成工程浏览、开发和调试。

Airtl is a VS Code extension for RTL/FPGA/FPSoC development, providing an RTL hierarchy tree, a Block Design View, and AI development workflows. Its goal is to bring schematic, PCB, FPGA, and embedded software development together for project browsing, development, and debugging in one environment.

## 当前发布 / Current release

**1.0.0-preview · Windows x64 · 2026-10-17**

- [下载 VSIX / Download VSIX](https://github.com/yuairtl/Airtl/releases/tag/v1.0.0-preview)
- 修复大型 SystemVerilog 接口解析崩溃及过程块源码/例化定位；Block Design 使用原生 Scene 和导航缓存。
- OpenCode 首次启动即在同一个可见 TUI 进程中启用 API，复用当前工作区会话；未安装 CLI 时直接提示。
- AI 消息中的任务、工程目录和工具路径以可读文本呈现；系统规则和对应技能通过独立的 system 字段传递。
- 默认授权截止时间：**2027-01-01 00:00:00 UTC**。技能与提示词仍单独提供，发布包只保留占位内容。

This preview fixes parsing crashes on large SystemVerilog interfaces and procedural source navigation. It uses native Scene rendering and cached navigation, starts OpenCode with its API enabled in the same visible TUI process, and sends readable task context while keeping system rules and the selected skill in the system field. Default authorization expires on **2027-01-01 00:00:00 UTC**. Prompts and skills are provided separately; the distribution contains placeholders only.

## 当前功能与发展方向 / Current Features and Roadmap

### 1. 原理图设计 / Schematic Design

- **已实现功能：**暂未集成。
- **待实现功能：**通过 VS Code 扩展、MCP 或 ACP 接入原理图设计工具与 Agent，支持原理图设计及文件导入、导出。
- **Implemented:** Not yet integrated.
- **Planned:** Connect schematic design tools and agents through VS Code extensions, MCP, or ACP, supporting schematic creation, import, and export.

### 2. 硬件原理图引脚视图 / Schematic Pin and Connectivity View

- **已实现功能：**暂未集成。
- **待实现功能：**解析原理图，将多个页面或通过连接器互连的多张原理图整合为统一视图，方便查看电路连接关系、审阅引脚分配。
- **Implemented:** Not yet integrated.
- **Planned:** Parse schematics and combine multiple pages or connector-linked schematics into one view for connectivity inspection and pin assignment review.

### 3. FPGA 全流程开发 / FPGA Development Workflow

- **已实现功能：**支持 OpenCode 作为 AI 开发 Harness，通过配套技能覆盖 Vivado 工程构建、仿真、综合与实现、时序优化和硬件调试；扩展提供仿真、综合、实现及 Bitstream 生成等任务入口。
- **待实现功能：**扩展两种 Harness 接入方式：A. 原生接入其他带 VS Code 扩展的 Harness，如 DSH、Codex；B. 基于 DSH 二次开发 Airtl 专用 Harness。同时集成 Vitis、嵌入式 Linux 等开发全流程。当前已有通用 CLI 命令模板，可配置部分命令行工具，其他 Harness 的原生集成仍待完成。
- **Implemented:** OpenCode serves as the AI development harness. Companion skills cover Vivado project creation, simulation, synthesis and implementation, timing optimization, and hardware debugging. The extension provides task entry points for simulation, synthesis, implementation, and bitstream generation.
- **Planned:** Add two harness options: A. Native integrations with other harnesses offering VS Code extensions, such as DSH and Codex; B. An Airtl-specific harness developed from DSH. Integrate complete Vitis and embedded Linux workflows. Generic CLI command templates are already available for some command-line tools; native integration with other harnesses remains planned.

配套技能与插件程序分别交付：发布包中的 `prompts/`、`ref_skill/` 仅含占位内容。使用上述 AI 流程需自行填写提示词与技能，或联系开发者获取现成内容，并配置相应工具链和模型服务。

Companion skills are supplied separately from the extension. The release's `prompts/` and `ref_skill/` files contain placeholders only. To use these AI workflows, provide your own prompts and skills or contact the developer for ready-to-use materials, and configure the required toolchains and model service.

### 4. Verilog / SystemVerilog 语言支持 / Language Support

- **已实现功能：**可从模块源码树和 Block Design View 跳转到模块定义或例化位置。
- **待实现功能：**完善编辑器中的变量定义、符号引用、结构与内联关系等语言级导航，提供接近 VS Code 软件开发的代码浏览体验。
- **Implemented:** Navigate from the hierarchy tree and Block Design View to module definitions or instantiations.
- **Planned:** Add editor-level navigation for variable definitions, symbol references, and structural and inline relationships, improving the HDL editing experience in VS Code.

### 5. 模块源码树 / RTL Hierarchy Tree

- **已实现功能：**扫描并读取 Vivado `.xpr`、工程 Tcl 或 HDL 源码，生成模块层次树；支持手动选择 HDL 顶层，查看模块例化关系，并快速跳转到模块定义或例化位置。
- **待实现功能：**本项目标的基础功能已实现，后续持续优化复杂工程的解析覆盖、准确性与性能。
- **Implemented:** Discover and read Vivado `.xpr` projects, project Tcl, or HDL sources to build a module hierarchy tree. Manually select an HDL top level, inspect instantiation relationships, and navigate to module definitions or instantiations.
- **Planned:** The basic capability is available; further work will improve parsing coverage, accuracy, and performance for complex projects.

### 6. 仿真与波形 / Simulation and Waveforms

- **已实现功能：**通过 AI 工作流发起仿真任务，支持生成 testbench 骨架、查找已有波形文件，并使用 Vivado 或 VS Code 打开对应文件。
- **待实现功能：**完善仿真任务进度和结果管理，集成插件内波形查看与分析，形成从仿真配置、执行到波形分析的完整操作流程。
- **Implemented:** Submit simulation tasks through the AI workflow, generate testbench skeletons, locate existing waveform files, and open them with Vivado or VS Code.
- **Planned:** Improve simulation progress and result management, and integrate waveform viewing and analysis into the extension for a complete simulation workflow.

### 7. Block Design View（模块连接视图） / Block Design View

- **已实现功能：**自动解析 HDL 模块例化关系，生成逻辑结构与连接视图；支持纯 RTL 和 Vivado BD 工程生成的 HDL，纯 RTL 工程无需 `.bd` 文件。可在视图中浏览模块层次、端口和连线，并跳转到模块源码或例化位置。
- **待实现功能：**本项目标的基础功能已实现，后续持续优化复杂逻辑与总线的显示准确性，以及大型设计的布局和交互体验。
- **Implemented:** Parse HDL instantiations to visualize logic structure and connectivity. Supports plain RTL and HDL generated from Vivado BD projects; plain RTL does not require a `.bd` file. Browse hierarchy, ports, and connections, and navigate to module definitions or instantiations.
- **Planned:** The basic capability is available; further work will improve complex logic and bus visualization, layout, and interaction for large designs.

### 8. AI 协同 / AI Collaboration

- **已实现功能：**可从模块源码树或 Block Design View 快速发起模块讲解、IP 端口信息获取、选中模块导出到仿真等 AI 任务，并传递相关工程和模块上下文。
- **待实现功能：**结合更多 Harness 接入和 Airtl 专用 Harness，完善视图内 AI 交互、任务进度展示与结果反馈。
- **Implemented:** Start AI tasks from the hierarchy tree or Block Design View, including module explanation, IP port information lookup, and exporting selected modules for simulation, with relevant project and module context.
- **Planned:** Extend these interactions to additional harnesses and the Airtl-specific harness, improving in-view AI interaction, task progress, and result feedback.

## 环境要求 / Requirements

- 当前 VSIX 为 **Windows x64** 版本。推荐使用 **VS Code 1.126.0 或更高版本**（1.126 发布于 2026-06-24）；旧版本未经过完整兼容性测试，这不是已确认的最低版本要求。Linux 需要单独构建的原生模块包。
- The current VSIX targets **Windows x64**. **VS Code 1.126.0 or later** is recommended (1.126 was released on 2026-06-24). Older versions have not been fully tested; this is a recommendation, not a confirmed minimum requirement. Linux requires a separately built native package.
- 浏览已有工程文件不要求安装 Vivado；执行仿真、综合、实现或生成 Bit 需要本机 Vivado 和有效的工程许可。
- Vivado is not required just to browse existing project files. Running simulation, synthesis, implementation, or bitstream generation requires a local Vivado installation and a valid project license.
- AI 功能默认使用 OpenCode **CLI**。推荐使用已完成集成实测的 **OpenCode 1.18.35**，其他版本未逐一验证。需要安装 CLI、配置可用的模型服务和模型。只安装 OpenCode 的 VS Code 编辑器扩展不够。
- AI features use the OpenCode **CLI** by default. **OpenCode 1.18.35** is the recommended, integration-tested version; other versions have not been individually verified. Install the CLI and configure an available model provider and model. The OpenCode VS Code editor extension alone is not sufficient.
- VSIX 已包含 Airtl 编译后的原生核心模块，安装扩展不需要 GCC/MinGW。核心 C++ 源码不在本仓库中，并按独立授权管理。
- The VSIX includes Airtl's compiled native core, so GCC/MinGW is not needed to install the extension. C++ source code for the core is not included and is governed by separate authorization terms.
- 发布包中的 `prompts/` 和 `ref_skill/` 是占位内容。AI 任务需要用户自行填写，或联系开发者获取现成内容。
- The `prompts/` and `ref_skill/` files in the release are placeholders. Add your own AI instructions or contact the developer for ready-made content.

## 安装与开始 / Install and get started

1. 在 VS Code 扩展面板选择 `...` → **Install from VSIX...**，安装仓库中的 `airtl-<版本>-win32-x64.vsix`。<br>
   In VS Code, open Extensions, select `...` → **Install from VSIX...**, and choose `airtl-<version>-win32-x64.vsix`.
2. 使用 VS Code 打开 Vivado 工程目录。<br>
   Open the Vivado project folder in VS Code.
3. 在左侧 **源码树** 中展开 **工程来源**，选择 `.xpr`、工程 Tcl 或 HDL 顶层文件，然后刷新。<br>
   In the left sidebar, open **源码树** (Source Tree), expand **工程来源** (Project Source), select an `.xpr`, project Tcl, or HDL top-level source, then refresh.
4. 需要 AI 工作流时，安装并配置 OpenCode、Vivado，并按[中文使用指南](使用指南.md)填写 prompts/skills。<br>
   For AI workflows, install and configure OpenCode and Vivado, then follow the [User Guide](USER_GUIDE.md) to fill in prompts and skills.

完整的安装、配置和操作步骤见[中文使用指南](使用指南.md)。
For detailed installation and configuration steps, see the [English User Guide](USER_GUIDE.md).

## 许可 / License

当前版本内置默认授权的截止时间为 **2027-01-01 00:00:00 UTC**。

The built-in default authorization expires at **2027-01-01 00:00:00 UTC**.

仓库中的可读源码与文档按 Apache License 2.0 授权，详见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)。整个 VSIX 不应视为统一按 Apache 2.0 授权：编译原生核心不含 C++ 源码，需按其独立授权规则使用，详见 [LICENSE](LICENSE)。

Readable source code and documentation in this repository are licensed under Apache License 2.0; see [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0). The VSIX as a whole is not licensed solely under Apache 2.0: the compiled native core does not include its C++ source and is subject to separate authorization terms. See [LICENSE](LICENSE).

## 联系开发者 / Contact

- 邮箱：yuairtl@outlook.com
- 微信公众号：Airtl
- X：@yuairtl
- Email: yuairtl@outlook.com
- WeChat Official Account: Airtl
- X: @yuairtl
