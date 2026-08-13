# API Discovery Notes

## Capture Summary

Capture file:

- `captures/manual-cdp-iframe-20260812-161802.ndjson`
- `captures/invite-submit-20260812-174049.ndjson`

The recorder now listens to both top-level pages and iframe targets, because the marketing system is loaded as a cross-domain iframe:

- Outer shell: `https://admin.cotticoffee.com`
- Marketing iframe: `https://marketingweb.yummy.tech`

The second capture confirmed these hosts:

- `marketingweb.yummy.tech` - frontend bundle and route shell
- `static.yummy.tech` - frontend dependencies
- `shopadmin.yummy.tech` - shop enum APIs
- `memberprofileadmin.cotticoffee.com` - shop/member/crowd APIs

Important correction:

- Submit APIs for manual coupon activities use `marketingadmin.abite.com`.
- Earlier captures filtered hosts too narrowly, so a real submit click could have happened without being written to the NDJSON log.
- The CDP recorder default host filter now includes `abite.com`.

Only the shop lookup business API was actually triggered during the second manual run:

```text
POST https://memberprofileadmin.cotticoffee.com/crowd/shop/list
```

Observed request body shape:

```json
{
  "shopMdCode": "",
  "shopShowNo": "",
  "shopName": "义乌国际商贸城二区店",
  "siteName": "",
  "status": "",
  "operationMode": "",
  "thirdType": "",
  "thirdNo": "",
  "isAgencyOperation": "",
  "shopType": "",
  "pageSize": 10,
  "currentPage": 1,
  "count": true,
  "statusList": [0, 1, 2],
  "shopMdCodeList": []
}
```

The focused submit capture successfully recorded the invite-ticket submit flow.

Observed request sequence:

```text
POST https://marketingadmin.abite.com/activity/page
POST https://marketingadmin.abite.com/manualActivity/detail?id=...
GET  https://marketingadmin.abite.com/coupon/djpage?templateNo=CT20250521000001&...
POST https://memberprofileadmin.cotticoffee.com/crowd/shop/list
GET  https://marketingadmin.abite.com/member/djpage?mobile=...
POST https://marketingadmin.abite.com/manualActivity/djSave
POST https://marketingadmin.abite.com/activity/page
```

This confirms the automation shape for invite tickets:

1. Search an existing manual coupon activity by store name.
2. Load the activity detail.
3. Search/fill the fixed coupon template `CT20250521000001`.
4. Search and verify the requested store.
5. Search each requested phone as a member.
6. Submit a copied activity payload with changed red-box fields.

## Source Map Findings

The marketing frontend publishes sourcemaps. They were used to confirm the following candidate APIs from source:

### Manual Coupon / Invite Ticket Flow

Base URL:

```text
https://marketingadmin.abite.com/
```

For current invite-ticket work orders, the coupon template is fixed:

```text
CT20250521000001
```

The SOP marks editable fields with red boxes. For invite-ticket automation these are required/changed fields:

- `activityName`: must be `店名-招待*单个手机号发券数量`.
- `couponTemplateSaveParamList`: template is fixed to `CT20250521000001`, while `sendNums` changes per work order.
- `shopMdCode`: selected from the requested store.
- `memberSaveParamList`, `inputMobile`, or import key: selected/entered from requested phone numbers.

Observed submit values from `captures/invite-submit-20260812-174049.ndjson`:

```json
{
  "activityType": 202,
  "activityName": "宝华恒大雅苑店-招待*5",
  "shopExtend": 1,
  "putShopType": 1,
  "shopMdCode": 20300029139,
  "startTimeType": 1,
  "putPeopleType": 1,
  "channel": 1,
  "couponTemplateSaveParamList": [
    {
      "templateNo": "CT20250521000001",
      "templateName": "现制饮品单杯兑换券",
      "sendNums": "5",
      "shopExtend": 1
    }
  ]
}
```

Notes:

- The request is created from an existing activity detail; many inherited fields remain in the payload.
- `id` is submitted as `null`, so the backend creates a copied/new activity.
- `activityNo` from the source activity remains present in the observed payload.
- `couponTemplateVOList` may contain the old copied quantity; the modified quantity appears in `couponTemplateSaveParamList`.
- In this manual run, `putPeopleType = 1` and `memberSaveParamList` contained selected member records from `/member/djpage`.
- For multiple phone numbers, the SOP says to use phone import. We still need one capture of that branch if we want to automate large batches through `importMobileSuccessKey`.

API wrappers:

```text
POST /manualActivity/djSave
POST /manualActivity/detail?id=...
POST /manualActivity/memberMobileRegister?memberMobile=...
```

Bulk upload endpoints:

```text
POST /member/importExcelForManualActivity?autoRegister=true
POST /member/importExcelForManualActivityById
POST /manualActivity/importShopList?autoRegister=true
GET  /member/getImportResult?key=...
GET  /member/getMemberIdImportResult?key=...
GET  /manualActivity/getShopMemberExcelCount?activityNo=...
```

Likely payload fields for `POST /manualActivity/djSave`:

```json
{
  "id": null,
  "activityName": "店名-招待*单个手机号发券数量",
  "activityDesc": "",
  "startTimeType": 1,
  "putPeopleType": 5,
  "putShopType": 1,
  "nextTriggleTime": null,
  "triggleTimeRule": {
    "triggleDate": [],
    "triggleTime": "",
    "triggleStartTime": "",
    "triggleEndTime": ""
  },
  "memberSaveParamList": [
    {
      "memberId": null,
      "memberNo": null,
      "memberMobile": "",
      "memberName": null
    }
  ],
  "couponTemplateSaveParamList": [
    {
      "templateNo": "",
      "templateName": "",
      "sendNums": 60,
      "shopExtend": 0
    }
  ],
  "shopMdCode": "",
  "shopExtend": 0,
  "excelKey": null,
  "manualSendCouponMaterial": {},
  "channel": 1
}
```

For service-ticket initiated requests, source adds:

```json
{
  "channel": 2,
  "channelInfo": {
    "customerNo": "",
    "solutionId": ""
  }
}
```

Frontend validation confirms:

- `activityName` required and must follow `店名-招待*单个手机号发券数量`.
- `startTimeType` required.
- `couponTemplateSaveParamList` required.
- If selected coupon has `shopExtend = 1`, then `shopMdCode` or imported shop/member Excel data is required.
- `putPeopleType` required when people targeting is shown.
- `inputMobile` supports single phone mode and must match `^1[3-9]\d{9}$`.
- For `putPeopleType = 5`, frontend converts `inputMobile` to `memberSaveParamList`.
- If backend returns `data == 40010`, the UI asks whether to register the phone through `/manualActivity/memberMobileRegister`.

### Coupon Template / Store Scope Candidates

Base URL from marketing app source:

```text
https://memberprofileadmin.cotticoffee.com/
```

Candidate APIs:

```text
POST /crowd/coupon/template
POST /crowd/shop/list
POST /crowd/store/getCouponPage
POST /crowd/store/batchImport
POST /crowd/store/validExport
POST /crowd/store/save
POST /crowd/store/update
GET  /crowd/store/getInfo?crowdNo=...
```

These are likely relevant to the SOP item "确认优惠券适用门店外部导入", but the exact save/update payload still needs a focused capture.

## Next Focused Capture

The next capture should intentionally include one safe submit-level action.

For invite-ticket automation:

1. Open the manual coupon page.
2. Fill a test or real low-risk work order.
3. Select the coupon template.
4. Select the store.
5. Enter one phone number.
6. Click submit once.
7. If the backend reports unregistered phone, stop there or choose according to the real work order.

Expected APIs to confirm:

- `GET /coupon/djpage` or related coupon search endpoint.
- `POST /manualActivity/djSave`.
- Optional `POST /manualActivity/memberMobileRegister`.

For coupon store scope automation:

1. Open coupon management.
2. Search a template by internal/template identifier.
3. Open applicable-store configuration.
4. Run external import with a small test file if safe.
5. Save.

Expected APIs to confirm:

- Template query/detail endpoint.
- `POST /crowd/store/batchImport`.
- `POST /crowd/store/save` or `POST /crowd/store/update`.
