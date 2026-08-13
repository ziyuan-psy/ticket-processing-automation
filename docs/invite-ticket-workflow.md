# 招待券发放自动化 Workflow

本文记录招待券发放从工单到中台提交的处理流程，并标明哪些步骤由脚本完成、哪些由 LLM 判断、哪些需要人工 review。

## 本地保存情况

刚刚处理的工单信息已经保存到本地文件，文件内包含门店、手机号、发券数量、活动名、接口查询结果和提交结果。

- Dry-run 预览文件：`tmp/invite-ticket-20260813-huaxi-dry-run.json`
- 提交结果文件：`tmp/invite-ticket-20260813-huaxi-submit-result.json`
- 提交后复查文件：`tmp/invite-ticket-20260813-huaxi-after-submit-check.json`

这些文件包含真实手机号。当前约定是手机号不脱敏；登录凭证 token/cookie 不写入这些结果文件。

## 输入工单字段

招待券发放需要从工单中提取这些字段：

- 申请原因：用于判断是否属于招待券发放，例如 `物业招待`
- 券适用门店：例如 `华熙国际中心C座B2店`
- 门店编号：例如 `JD2025042400094`
- 收券人手机号：一个或多个手机号
- 单个手机号发券数量：例如 `15`

固定配置：

- 招待券模板标识：`CT20250521000001`
- 活动名称格式：`店名-招待*单个手机号发券数量`
- 单个手机号发券数量必须 `<= 100`
- 总发券量 `手机号数量 * 单手机号数量` 必须 `<= 200`

## 角色分工

### LLM 处理

LLM 负责理解工单和 SOP 规则，但不直接绕过脚本写入中台。

- 从自然语言工单中识别门店名、门店编号、手机号、发券数量。
- 判断这是招待券发放任务，而不是优惠券适用门店维护等其他任务。
- 根据 SOP 生成活动名称，例如 `华熙国际中心C座B2店-招待*15`。
- 判断固定券模板应使用 `CT20250521000001`。
- 检查数量上限、手机号格式、门店编号格式。
- 阅读脚本输出，解释接口返回结果。
- 在人工确认后，选择执行提交脚本。

### 脚本处理

脚本负责可重复、可校验的接口调用。

`scripts/invite-ticket-dry-run.mjs` 负责提交前预览，只调用查询接口，不调用保存接口：

- 通过 Chrome DevTools Protocol 连接当前已登录 Chrome。
- 在 `marketingweb.yummy.tech` 页面上下文中复用当前登录态。
- 查询可复制的手工发券活动：`POST /activity/page`
- 查询活动详情：`POST /manualActivity/detail`
- 查询固定券模板：`GET /coupon/djpage`
- 查询并核对门店：`POST /crowd/shop/list`
- 查询手机号对应会员：`GET /member/djpage`
- 生成待提交 payload。
- 将 dry-run 结果写入本地 JSON。
- 明确停止在提交前，不调用 `POST /manualActivity/djSave`。

`scripts/invite-ticket-submit.mjs` 负责真实提交：

- 读取 dry-run JSON。
- 校验 `payload.id === null`，确保是新建活动，不是修改旧活动。
- 校验 `activityType === 202`。
- 校验 `couponTemplateSaveParamList` 和 `memberSaveParamList` 存在。
- 校验单人数量和总量不超过 SOP 限制。
- 必须显式传入 `--confirm-submit` 才会提交。
- 只调用一次 `POST /manualActivity/djSave`。
- 保存中台返回结果到本地 JSON。

### 人工 Review

人工 review 是提交前的业务确认点。

需要核对：

- 活动名称是否符合 `店名-招待*数量`。
- 门店编号和门店名称是否匹配。
- 门店是否属于联营、状态是否正常。
- 手机号是否正确。
- 会员查询结果是否匹配该手机号。
- 券模板是否是当前固定招待券模板。
- 单个手机号发券数量和总量是否符合 SOP。
- 是否允许执行真实提交。

本次流程中，人工 review 发生在 dry-run 输出后。用户确认“按脚本跑提交步骤”后，才执行真实提交脚本。

## 标准执行流程

1. 人工提供工单文本。
2. LLM 提取字段并按 SOP 做初步校验。
3. 脚本执行 dry-run 查询，生成待提交 payload。
4. LLM 汇总 dry-run 结果给人工 review。
5. 人工确认可以提交。
6. 脚本执行 `invite-ticket-submit.mjs --confirm-submit`。
7. 脚本保存提交结果。
8. 脚本或 LLM 执行提交后只读复查，确认活动列表能查到新活动。
9. LLM 汇总最终处理结果。

## 本次工单执行记录

工单字段：

- 申请原因：`物业招待`
- 门店：`华熙国际中心C座B2店`
- 门店编号：`JD2025042400094`
- 手机号：`13488892815`
- 单手机号发券数量：`15`
- 活动名称：`华熙国际中心C座B2店-招待*15`
- 券模板：`CT20250521000001`

Dry-run 查询结果：

- 复制源活动 ID：`1177391`
- 复制源活动编号：`46840435691028480`
- 门店主数据编号：`20300018444`
- 门店状态：`已开业`
- 经营模式：`联营`
- 会员 ID：`43072633575`
- 待提交接口：`POST https://marketingadmin.abite.com/manualActivity/djSave`

真实提交结果：

- HTTP 状态：`200`
- 中台返回：`{"status":0,"msg":null,"code":null,"data":"成功","trace":null}`

提交后复查：

- 新活动 ID：`1181773`
- 新活动编号：`47554489864699904`
- 新活动名称：`华熙国际中心C座B2店-招待*15`

## 当前边界

- 当前流程适用于少量手机号，走 `memberSaveParamList` 直接选择会员。
- 多手机号批量导入模式还需要单独抓取并固化 `importMobileSuccessKey` 分支。
- 当前脚本依赖一个已经登录并开启 remote debugging 的 Chrome。
- 当前脚本不会清理本地结果文件；这些文件会作为操作审计留存。
