#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_COUPON_TEMPLATE_ID = "CT20250521000001";
const MARKETING_HOST = "marketingweb.yummy.tech";
const ACTIVITY_API = "https://marketingadmin.abite.com";
const SHOP_API = "https://memberprofileadmin.cotticoffee.com";

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9222",
    couponTemplateId: DEFAULT_COUPON_TEMPLATE_ID,
    out: "tmp/invite-ticket-dry-run.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url") opts.cdpUrl = argv[++index];
    else if (arg === "--store-name") opts.storeName = argv[++index];
    else if (arg === "--store-code") opts.storeCode = argv[++index];
    else if (arg === "--phone") opts.phone = argv[++index];
    else if (arg === "--quantity") opts.quantity = Number(argv[++index]);
    else if (arg === "--coupon-template-id") opts.couponTemplateId = argv[++index];
    else if (arg === "--out") opts.out = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const field of ["storeName", "storeCode", "phone"]) {
    if (!opts[field]) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!/^JD\d+$/.test(opts.storeCode)) throw new Error("--store-code must start with JD and digits");
  if (!/^1[3-9]\d{9}$/.test(opts.phone)) throw new Error("--phone must be a valid mainland China mobile number");
  if (!Number.isInteger(opts.quantity) || opts.quantity <= 0) throw new Error("--quantity must be a positive integer");
  if (opts.quantity > 100) throw new Error("--quantity must be <= 100");
  return opts;
}

function printHelp() {
  console.log(`Usage:
  node scripts/invite-ticket-dry-run.mjs --store-name <name> --store-code <JD...> --phone <mobile> --quantity <n>

Options:
  --cdp-url <url>             Chrome remote debugging URL. Default: http://127.0.0.1:9222
  --coupon-template-id <id>   Coupon template id. Default: ${DEFAULT_COUPON_TEMPLATE_ID}
  --out <path>                Write dry-run result JSON. Default: tmp/invite-ticket-dry-run.json

This script only performs read/query APIs and builds the djSave payload. It never calls /manualActivity/djSave.
`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener("open", resolveOpen, { once: true });
      this.ws.addEventListener("error", rejectOpen, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveSend, rejectSend) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timeout, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result || {});
  }

  close() {
    this.ws?.close();
  }
}

function runtimeExpression(workOrder) {
  return `
(async () => {
  const workOrder = ${JSON.stringify(workOrder)};
  const ACTIVITY_API = ${JSON.stringify(ACTIVITY_API)};
  const SHOP_API = ${JSON.stringify(SHOP_API)};

  const hashQuery = new URLSearchParams((location.hash.split("?")[1] || "").split("#")[0]);
  const searchQuery = new URLSearchParams(location.search || "");
  const storageValue = (name) => localStorage.getItem(name) || sessionStorage.getItem(name);
  const token =
    hashQuery.get("token") ||
    searchQuery.get("token") ||
    storageValue("token") ||
    storageValue("Admin-Token") ||
    storageValue("Authorization") ||
    storageValue("access_token") ||
    "";
  const brandMdCode =
    hashQuery.get("brandMdCode") ||
    searchQuery.get("brandMdCode") ||
    storageValue("brandMdCode") ||
    "20200000006";

  const headers = {
    terminalCode: "1",
    Authorization: token,
    token,
    brandMdCode,
    "Request-Ajax": "true",
    Accept: "application/json, text/plain, */*",
  };

  function unwrap(responseJson) {
    if (responseJson && Object.prototype.hasOwnProperty.call(responseJson, "data")) return responseJson.data;
    return responseJson;
  }

  function rowsFrom(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    for (const key of ["rows", "records", "list", "items"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const key of ["page", "result", "data"]) {
      const rows = rowsFrom(value[key]);
      if (rows.length) return rows;
    }
    return [];
  }

  async function api(method, url, body) {
    const request = {
      method,
      credentials: "include",
      headers: { ...headers },
    };
    if (body !== undefined) {
      request.headers["Content-Type"] = "application/json;charset=UTF-8";
      request.body = JSON.stringify(body);
    }
    const response = await fetch(url, request);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { rawText: text };
    }
    if (!response.ok) {
      throw new Error(method + " " + url + " failed: HTTP " + response.status + " " + text.slice(0, 300));
    }
    return { status: response.status, url, json, data: unwrap(json) };
  }

  function chooseBy(rows, predicates, label) {
    for (const predicate of predicates) {
      const found = rows.find(predicate);
      if (found) return found;
    }
    throw new Error("No matching " + label + " found. candidates=" + JSON.stringify(rows.slice(0, 5)));
  }

  const steps = [];
  const activityName = workOrder.storeName + "-招待*" + workOrder.quantity;

  const activitySearch = await api("POST", ACTIVITY_API + "/activity/page", {
    pageNum: 1,
    pageSize: 10,
    activityName: workOrder.storeName,
    activityNo: null,
    activityType: "",
    activityStatus: "",
    modifyName: "",
    startTime: ["2025-01-01 00:00:00", "2027-12-31 23:59:59"],
  });
  const activityRows = rowsFrom(activitySearch.data);
  const sourceActivity = chooseBy(
    activityRows,
    [
      (row) => String(row.activityName || "").includes(workOrder.storeName) && String(row.activityName || "").includes("招待"),
      (row) => String(row.activityName || "").includes(workOrder.storeName),
    ],
    "source activity"
  );
  steps.push({
    api: "POST /activity/page",
    candidates: activityRows.length,
    selected: {
      id: sourceActivity.id,
      activityNo: sourceActivity.activityNo,
      activityName: sourceActivity.activityName,
      activityStatus: sourceActivity.activityStatus,
    },
  });

  const detailId = sourceActivity.id || sourceActivity.activityId;
  const detailResponse = await api("POST", ACTIVITY_API + "/manualActivity/detail?id=" + encodeURIComponent(detailId));
  const detail = detailResponse.data;
  steps.push({
    api: "POST /manualActivity/detail",
    selected: {
      id: detail.id,
      activityNo: detail.activityNo,
      activityName: detail.activityName,
      activityType: detail.activityType,
    },
  });

  const couponResponse = await api(
    "GET",
    ACTIVITY_API +
      "/coupon/djpage?templateNo=" +
      encodeURIComponent(workOrder.couponTemplateId) +
      "&modifyTimeStart=&modifyTimeEnd=&pageNum=1&pageSize=10"
  );
  const couponRows = rowsFrom(couponResponse.data);
  const coupon = chooseBy(
    couponRows,
    [(row) => String(row.templateNo || row.templateId || "") === workOrder.couponTemplateId],
    "coupon template"
  );
  const couponName = coupon.templateName || coupon.couponName || coupon.name || "现制饮品单杯兑换券";
  steps.push({
    api: "GET /coupon/djpage",
    candidates: couponRows.length,
    selected: {
      templateNo: coupon.templateNo || coupon.templateId,
      templateName: couponName,
      shopExtend: coupon.shopExtend,
    },
  });

  const shopResponse = await api("POST", SHOP_API + "/crowd/shop/list", {
    shopMdCode: "",
    shopShowNo: workOrder.storeCode,
    shopName: workOrder.storeName,
    siteName: "",
    status: "",
    operationMode: "",
    thirdType: "",
    thirdNo: "",
    isAgencyOperation: "",
    shopType: "",
    pageSize: 10,
    currentPage: 1,
    count: true,
    statusList: [0, 1, 2],
    shopMdCodeList: [],
  });
  const shopRows = rowsFrom(shopResponse.data);
  const shop = chooseBy(
    shopRows,
    [
      (row) => String(row.shopShowNo || "") === workOrder.storeCode && String(row.shopName || "") === workOrder.storeName,
      (row) => String(row.shopShowNo || "") === workOrder.storeCode,
      (row) => String(row.shopName || "") === workOrder.storeName,
    ],
    "store"
  );
  steps.push({
    api: "POST /crowd/shop/list",
    candidates: shopRows.length,
    selected: {
      shopMdCode: shop.shopMdCode,
      shopShowNo: shop.shopShowNo,
      shopName: shop.shopName,
      statusDesc: shop.statusDesc,
      operationModeDesc: shop.operationModeDesc,
    },
  });

  const memberSaveParamList = [];
  for (const phone of workOrder.phones) {
    const memberResponse = await api(
      "GET",
      ACTIVITY_API +
        "/member/djpage?mobile=" +
        encodeURIComponent(phone) +
        "&name=&cname=&currentPage=1&pageSize=10&pageNum=1"
    );
    const memberRows = rowsFrom(memberResponse.data);
    const member = chooseBy(
      memberRows,
      [
        (row) => String(row.memberMobile || row.mobile || "") === phone,
        (row) => String(row.mobile || row.memberMobile || "").includes(phone),
      ],
      "member for " + phone
    );
    memberSaveParamList.push({
      memberId: member.memberId,
      memberName: member.memberName ?? null,
      memberNo: member.memberNo,
      memberMobile: member.memberMobile || member.mobile || phone,
    });
    steps.push({
      api: "GET /member/djpage",
      phone,
      candidates: memberRows.length,
      selected: memberSaveParamList[memberSaveParamList.length - 1],
    });
  }

  const payload = JSON.parse(JSON.stringify(detail));
  payload.id = null;
  payload.activityStatus = null;
  payload.activityName = activityName;
  payload.shopExtend = 1;
  payload.putShopType = 1;
  payload.shopMdCode = shop.shopMdCode;
  payload.startTimeType = payload.startTimeType || 1;
  payload.putPeopleType = 1;
  payload.excelUrl = null;
  payload.excelKey = null;
  payload.importMobileSuccessKey = "";
  payload.importMemberSuccessKey = "";
  payload.memberSaveParamList = memberSaveParamList;
  payload.memberVOList = memberSaveParamList;
  payload.sensorsUserGroupList = [];
  payload.sensorsMemberCount = null;
  payload.hasUserCrowd = false;
  payload.userCrowdInfo = null;
  payload.channel = 1;
  payload.channelInfo = null;
  payload.couponTemplateSaveParamList = [
    {
      templateNo: workOrder.couponTemplateId,
      templateName: couponName,
      sendNums: String(workOrder.quantity),
      shopExtend: 1,
    },
  ];
  payload.couponTemplateVOList = [
    {
      templateNo: workOrder.couponTemplateId,
      templateName: couponName,
      sendNums: Number(workOrder.quantity),
      shopExtend: 1,
    },
  ];
  payload.manualSendCouponMaterial = payload.manualSendCouponMaterial || {
    sendMsg: 2,
    msgSendType: [],
    longLink: "",
    shortLink: "",
    cacheLongLink: "",
    content: "",
    isShortLink: 0,
    wxPushType: null,
    wxAppletContent: "",
    wxAppletJump: "",
    alipayPushType: null,
    alipayAppletContent: "",
    alipayAppletJump: "",
    appPushType: null,
    messageTitle: "",
    messageContent: "",
    jumpPage: "",
    messageUrl: "",
    qwMessageContent: "",
    qwContentType: "",
    qwMessageTitle: "",
    qwAppletCoverUrl: "",
    qwAppletJumpLink: "",
    qwPictureUrl: "",
    qwVideoUrl: "",
    sendWay: null,
    sendTime: null,
    manualSendCouponPicUrlList: null,
  };

  return {
    ok: true,
    stoppedBeforeSubmit: true,
    warning: "Dry run only. /manualActivity/djSave was not called.",
    page: { href: location.href, brandMdCode, hasToken: Boolean(token) },
    workOrder: { ...workOrder, activityName, totalQuantity: workOrder.quantity * workOrder.phones.length },
    steps,
    submitEndpoint: ACTIVITY_API + "/manualActivity/djSave",
    payload,
  };
})()
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workOrder = {
    storeName: opts.storeName,
    storeCode: opts.storeCode,
    phones: [opts.phone],
    quantity: opts.quantity,
    couponTemplateId: opts.couponTemplateId,
  };

  const version = await fetchJson(`${opts.cdpUrl.replace(/\/$/, "")}/json/version`);
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.open();

  try {
    await client.send("Target.setDiscoverTargets", { discover: true });
    const targets = await client.send("Target.getTargets");
    const targetInfo = (targets.targetInfos || []).find(
      (target) =>
        ["page", "iframe"].includes(target.type) &&
        String(target.url || target.title || "").includes(MARKETING_HOST),
    );
    if (!targetInfo) {
      throw new Error(
        `No ${MARKETING_HOST} tab/iframe found. Open the marketing page in the remote-debugging Chrome first.`,
      );
    }

    const attach = await client.send("Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    await client.send("Runtime.enable", {}, attach.sessionId);
    const evaluation = await client.send(
      "Runtime.evaluate",
      {
        expression: runtimeExpression(workOrder),
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
      },
      attach.sessionId,
    );

    if (evaluation.exceptionDetails) {
      const description =
        evaluation.exceptionDetails.exception?.description ||
        evaluation.exceptionDetails.text ||
        "Runtime evaluation failed";
      throw new Error(description);
    }

    const result = evaluation.result?.value;
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    console.log(`dry-run ok: wrote ${outPath}`);
    console.log(`activity: ${result.workOrder.activityName}`);
    console.log(`store: ${result.steps.find((step) => step.api === "POST /crowd/shop/list")?.selected.shopShowNo}`);
    console.log(`phone: ${opts.phone}`);
    console.log(`quantity: ${opts.quantity}`);
    console.log("stopped before submit: /manualActivity/djSave was not called");
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
