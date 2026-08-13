# Ticket Processing Automation

这个工作区先从 `泛微联营商工单处理SOP.pdf` 里最简单的两类任务开始：

- 招待券发放
- 优惠券发放

当前版本只做两件安全的事：

1. 把工单字段按 SOP 做本地校验。
2. 分析从浏览器 Network 导出的 HAR，帮助我们定位 `admin.cotticoffee.com` 后台真实接口。

它不会调用真实后台接口，也不会发券、保存活动或修改券模板。

## 从 SOP 提取的关键规则

招待券发放：

- 入口：用户营销平台 -> 卡券系统 -> 优惠券管理，选择模板并复制模板标识。
- 入口：用户营销平台 -> 营销系统 -> 活动管理，复制/新建手工发券活动。
- 需要核对门店编号和门店名称是否对应。
- 当前招待券固定使用优惠券模板 `CT20250521000001`，不需要每次重新复制模板标识。
- 活动名称格式固定为 `店名-招待*单个手机号发券数量`。
- SOP 截图里红色方框标出的内容，都是自动化需要填写或修改的字段。
- 单次发放数量 <= 100。
- 总量 = 数量 * 手机号数量，总量 <= 200。
- 多个手机号走投放人群 -> 导入手机号 -> 批量导入。
- 复制现有活动时，需要先删除原门店和手机号已选项，再添加新的。

优惠券发放：

- 入口：用户营销平台 -> 卡券系统 -> 优惠券管理。
- 选择模板并复制模板标识。
- 确认优惠券适用门店，使用外部导入。

## 推荐抓接口方式：CDP 全浏览器录制

多 tab 流程优先用这个方法。它通过 Chrome DevTools Protocol 监听整个 Chrome 实例，会自动跟踪已打开页面和后续弹出的新 tab。

先启动一个专门用于抓包的 Chrome：

```powershell
$profile="$env:LOCALAPPDATA\CottiApiCaptureChrome"
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$profile" --no-first-run https://admin.cotticoffee.com
```

然后开始录制：

```powershell
node scripts/record-cdp-network.mjs --out captures/invite-ticket.ndjson --host cotticoffee.com,yummy.tech,abite.com --pause-new-tabs --keep-phones
```

录制期间在这个 Chrome 里完整做一次招待券流程。结束后按 `Ctrl+C` 停止录制，再分析：

```powershell
python -m ticket_automation.cli analyze-cdp-log captures/invite-ticket.ndjson --host cotticoffee.com,yummy.tech,abite.com --keep-phones
```

优惠券适用门店导入流程同理：

```powershell
node scripts/record-cdp-network.mjs --out captures/coupon-scope.ndjson --host cotticoffee.com,yummy.tech,abite.com --pause-new-tabs --keep-phones
python -m ticket_automation.cli analyze-cdp-log captures/coupon-scope.ndjson --host cotticoffee.com,yummy.tech,abite.com --keep-phones
```

`--pause-new-tabs` 会让新开的 tab 在 Network 监听启用后再继续加载，适合捕捉弹窗/新 tab 打开后的第一批接口。

## 备选抓接口方式：导出 HAR

1. 打开 Chrome，登录 `admin.cotticoffee.com`。
2. 打开 DevTools -> Network，勾选 Preserve log，过滤 Fetch/XHR。
3. 做一次招待券流程，但尽量先只做到查询、复制活动、填写字段；最终保存/上架/发放动作先用测试数据。
4. 右键 Network 请求列表，选择 `Save all as HAR with content`。
5. 保存到 `captures/invite-ticket.har`。
6. 对优惠券适用门店导入流程重复一次，保存到 `captures/coupon-scope.har`。

分析 HAR：

```powershell
python -m ticket_automation.cli analyze-har captures/invite-ticket.har --host admin.cotticoffee.com
python -m ticket_automation.cli analyze-har captures/coupon-scope.har --host admin.cotticoffee.com
```

校验工单输入：

```powershell
python -m ticket_automation.cli validate examples/work_orders.sample.json
```

## 下一步

拿到 HAR 后，我们会把候选接口分成：

- 查询类：模板搜索、门店搜索、活动搜索、活动详情。
- 预览/导入类：手机号批量导入、适用门店外部导入。
- 写入类：复制活动、保存活动、上架/发放、保存券模板适用门店。

写入类会先实现 dry-run 输出 payload，再接真实执行。

当前发现报告见 [docs/api-discovery.md](docs/api-discovery.md)。
