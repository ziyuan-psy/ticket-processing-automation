# Ticket Processing Automation

用于批量处理泛微工单中的发券类任务。当前支持把固定格式工单粘贴到 GUI 中，自动拆分、分类、解析、dry-run、人工勾选提交，并在提交后做只读复查。

当前已接入：

- 招待券发放
- 优惠券发放
- 未识别工单会在 GUI 中标记为“暂不支持”，不影响其他工单处理

## 一、GUI 使用说明

### 1. 免安装版怎么使用

免安装版适合普通运营同事使用。同事不需要安装 Python 或 Node，只需要电脑里有 Chrome。

1. 解压 `TicketProcessingAutomation.zip`。
2. 双击 `launch.bat` 或 `TicketProcessingAutomation.exe`。
3. 点击 GUI 顶部的 `打开中台 Chrome`。
4. 在新打开的 Chrome 窗口里登录运营中台。
5. 回到 GUI，粘贴一批泛微工单。
6. 点击 `解析工单`。
7. 点击 `批量 dry-run`。
8. 在下方 dry-run 明细表里勾选确认要提交的工单。
9. 点击 `提交已勾选`。

免安装 zip 的构建产物路径：

```text
dist\TicketProcessingAutomation.zip
```

### 2. 源码版怎么启动 GUI

源码版适合维护/开发同事使用：

```powershell
.\run_app.ps1
```

`run_app.ps1` 会优先使用 Codex bundled Python；如果不存在，则回退到系统 `python`。

### 3. 为什么要点“打开中台 Chrome”

自动化脚本不是直接控制普通 Chrome 页面，而是通过 Chrome DevTools Protocol 连接一个带调试端口的专用 Chrome。

GUI 顶部的 `打开中台 Chrome` 会打开：

- 中台地址：`https://admin.cotticoffee.com/#/index`
- 调试端口：`9223`
- 专用 profile：`%LOCALAPPDATA%\CottiTicketAutomationChrome`

使用专用 `9223` 端口是为了避免和每日企微导出等其他自动化工具的 Chrome 调试端口冲突。

### 4. GUI 页面说明

- `工单粘贴区`：粘贴一批泛微工单，可以混合招待券和优惠券。
- `解析结果`：展示工单类型、标题、门店、门店编号、手机号数量、数量拆分、解析错误。
- `dry-run 明细与提交勾选`：展示门店校验、手机号导入结果、payload 拆分、退回批示语、提交后复查结果。
- `复制退回批示语`：复制 fallback 工单的泛微退回说明。
- `提交已勾选`：只提交下方表格里已勾选且状态为“可提交”的工单，并会弹窗二次确认。

### 5. 当前业务规则

招待券发放：

- 固定使用优惠券模板 `CT20250521000001`。
- 统一复制源活动编号 `47648259203850240`。
- 活动名称格式：`店名-招待*单个手机号发券数量`。
- 自动覆盖当前工单的门店、手机号、数量和活动名。
- 无论单个还是多个手机号，都走“投放人群 -> 导入手机号 -> 批量导入”。

优惠券发放：

- 统一复制源活动编号 `47678430008262656`。
- 根据工单里的“申请券类型”和“券金额/券折扣”自动选择券模板。
- 活动名称格式：`店名优惠-x元/x折*单个手机号发券数量`。
- 折扣输入会归一化，例如 `88折 -> 8.8折`、`9.5折 -> 95折`。

当前支持的折扣券模板：

| 券值 | 模板标识 |
| --- | --- |
| 9折 | CT20231226000001 |
| 8折 | CT20231223000003 |
| 8.5折 | CT20250710000002 |
| 8.8折 | CT20231226000002 |
| 6.8折 | CT20240105000003 |
| 95折 | CT20260616000005 |
| 8.3折 | CT20260129000001 |
| 7.9折 | CT20240220000001 |
| 7.7折 | CT20231224000002 |

当前支持的一口价券模板：

| 券值 | 模板标识 |
| --- | --- |
| 9.9元 | CT20231220000010 |
| 12.9元 | CT20260420000004 |
| 22元 | CT20260814000011 |
| 10.9元 | CT20260224000001 |
| 8.8元 | CT20231215000003 |
| 22.5元 | CT20260408000010 |
| 15元 | CT20260622000007 |
| 9元 | CT20240104000001 |

通用规则：

- 门店编号支持 `JD+数字` 或 `Q+数字/字母`。
- 纯数字门店编号会自动补成 `JD+数字` 后查询。
- 手机号字段里可以包含姓名或其他汉字，解析时只提取符合 `^1[3-9]\d{9}$` 的手机号。
- 单个手机号发券数量不能超过 200。
- 运营中台单次提交最多 100 张，数量 101-200 会拆成多次，例如 150 拆成 100 和 50。
- dry-run 会校验门店名称和门店编号是否匹配；不匹配时返回退回批示语：`门店名称和门店编号不一致，请重新填写`。

### 6. dry-run 和提交分别做什么

dry-run 会调用查询、导入和预检查接口，但不会调用真实保存接口。它会：

- 查询固定源活动
- 查询券模板
- 查询并校验门店
- 生成手机号 Excel 并上传
- 查询手机号导入结果
- 生成待提交 payload

提交时会读取 dry-run JSON，二次校验后调用中台保存接口，并按活动名做提交后只读复查。

### 7. 常见问题

如果 PowerShell 提示找不到 `.\run_app.ps1`，先切到项目目录：

```powershell
cd "C:\Users\EDY\Documents\Ticket Processing Automation"
.\run_app.ps1
```

如果 dry-run 长时间不结束，通常是专用 Chrome 调试通道卡住。关闭工单专用 Chrome，重新点 GUI 顶部的 `打开中台 Chrome`，登录后再 dry-run。

如果打开了普通 Chrome 并手动输入中台网址，脚本无法连接它。必须用 GUI 的 `打开中台 Chrome` 打开带 `9223` 调试端口的专用窗口。

## 二、维护和拓展说明

### 1. 源码结构

```text
app_ui.py                         GUI 入口
run_app.ps1                       源码版 GUI 启动脚本
build_windows.ps1                 Windows 免安装包构建脚本
ticket_automation/
  batch_runner.py                 GUI 调用 parser 和 Node 脚本的调度层
  models.py                       工单模型、校验规则、券模板映射
  ticket_classifier.py            工单类型识别
  ticket_splitter.py              混合粘贴文本拆分
  pipelines/
    invite_ticket.py              招待券工单 parser
    coupon_ticket.py              优惠券工单 parser
scripts/
  invite-ticket-dry-run.mjs       招待券 dry-run
  invite-ticket-submit.mjs        招待券提交
  coupon-ticket-dry-run.mjs       优惠券 dry-run
  coupon-ticket-submit.mjs        优惠券提交
  record-cdp-network.mjs          CDP 抓接口工具
docs/
  api-discovery.md                接口发现记录
  invite-ticket-workflow.md       招待券 workflow 记录
  sop-notes.md                    SOP 规则整理
```

### 2. 当前技术流程

- GUI 负责录入、展示、勾选、调度。
- Python parser 负责工单拆分、分类、字段提取和本地校验。
- Node 脚本通过 Chrome CDP 读取登录态，并在中台页面上下文里调用接口。
- dry-run 只生成 payload，不提交活动。
- submit 读取 dry-run JSON，二次校验后提交。
- submit 后做只读复查，把结果写回 GUI。

### 3. 如何加新的工单类型

新增一种工单类型时，建议按这个顺序接入：

1. 在 `ticket_automation/ticket_classifier.py` 增加识别规则。
2. 在 `ticket_automation/models.py` 增加工单 dataclass、字段校验和常量映射。
3. 在 `ticket_automation/pipelines/` 下新增 parser。
4. 在 `ticket_automation/batch_runner.py` 里注册 dry-run/submit 脚本分发。
5. 在 `scripts/` 下新增对应的 dry-run 和 submit 脚本。
6. 确认 GUI 表格是否需要新增展示字段。
7. 增加样例，先跑 parse-only 和 dry-run。
8. dry-run 稳定后，再接真实 submit。

新工单类型的最低安全要求：

- parser 能稳定提取字段。
- 本地校验能拦截明显错误。
- dry-run 不调用写入接口。
- submit 必须要求显式确认参数。
- submit 前必须校验 dry-run JSON 来源和关键 payload 字段。
- submit 后必须做只读复查。

如果优惠券模板发生变化，需要同步修改 `ticket_automation/models.py` 和 `scripts/coupon-ticket-dry-run.mjs` 里的模板映射。

### 4. 如何抓新接口

多 tab 流程优先使用 CDP 全浏览器录制。它会监听整个专用 Chrome 实例，并自动跟踪后续打开的新 tab。

先启动专用 Chrome：

```powershell
$profile="$env:LOCALAPPDATA\CottiTicketAutomationChrome"
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="$profile" --no-first-run https://admin.cotticoffee.com
```

然后开始录制：

```powershell
node scripts/record-cdp-network.mjs --out captures/new-flow.ndjson --host cotticoffee.com,yummy.tech,abite.com --pause-new-tabs --keep-phones
```

录制期间在这个 Chrome 里完整做一次人工流程。结束后按 `Ctrl+C` 停止录制，再分析：

```powershell
python -m ticket_automation.cli analyze-cdp-log captures/new-flow.ndjson --host cotticoffee.com,yummy.tech,abite.com --keep-phones
```

`--pause-new-tabs` 会让新开的 tab 在 Network 监听启用后再继续加载，适合捕捉弹窗或新 tab 打开后的第一批接口。

备选方式是导出 HAR：

1. 打开 Chrome，登录 `admin.cotticoffee.com`。
2. 打开 DevTools -> Network，勾选 Preserve log，过滤 Fetch/XHR。
3. 完整做一次人工流程，写入动作尽量使用测试数据。
4. 右键 Network 请求列表，选择 `Save all as HAR with content`。
5. 保存到 `captures/`。
6. 使用 CLI 分析：

```powershell
python -m ticket_automation.cli analyze-har captures/new-flow.har --host admin.cotticoffee.com
```

### 5. 如何打包免安装版

开发机需要能访问 Python、PyInstaller 和 Node；同事的使用机只需要有 Chrome。

在 Codex 环境中，构建脚本会优先使用 Codex 自带的 Python 和 Node；在普通开发机上，需要提前安装 Python、PyInstaller 和 Node。

构建：

```powershell
.\build_windows.ps1
```

输出：

```text
dist\TicketProcessingAutomation\
dist\TicketProcessingAutomation.zip
```

打包版会优先使用 exe 同目录下的：

```text
runtime\node.exe
```

运行数据会写入：

```text
%LOCALAPPDATA%\TicketProcessingAutomation
```

### 6. 不建议提交的文件

以下文件由本地运行或打包生成，不应提交到 git：

- `build/`
- `dist/`
- `tmp/`
- `captures/`
- `*.spec`
- `*.log`
- `*.har`

### 7. 本地检查命令

Python 语法检查：

```powershell
python -m py_compile app_ui.py ticket_automation\batch_runner.py ticket_automation\models.py ticket_automation\pipelines\invite_ticket.py ticket_automation\pipelines\coupon_ticket.py ticket_automation\cli.py
```

Node 脚本语法检查：

```powershell
node --check scripts/invite-ticket-dry-run.mjs
node --check scripts/invite-ticket-submit.mjs
node --check scripts/coupon-ticket-dry-run.mjs
node --check scripts/coupon-ticket-submit.mjs
```
