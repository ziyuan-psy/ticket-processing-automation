#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_COUPON_TEMPLATE_ID = "CT20250521000001";
const DEFAULT_INVITE_SOURCE_ACTIVITY_NO = "47648259203850240";
const ACTIVITY_API = "https://marketingadmin.cotticoffee.com";
const SHOP_API = "https://memberprofileadmin.cotticoffee.com";
const STORE_MISMATCH_RETURN_COMMENT = "门店名称和门店编号不一致，请重新填写";
const MAX_PER_PHONE = 200;
const MAX_PER_SUBMIT = 100;

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9222",
    couponTemplateId: DEFAULT_COUPON_TEMPLATE_ID,
    out: "tmp/invite-ticket-dry-run.json",
    parseOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url") opts.cdpUrl = argv[++index];
    else if (arg === "--work-order-file") opts.workOrderText = readFileSync(argv[++index], "utf8");
    else if (arg === "--work-order-text") opts.workOrderText = argv[++index];
    else if (arg === "--store-name") opts.storeName = argv[++index];
    else if (arg === "--store-code") opts.storeCode = argv[++index];
    else if (arg === "--phone" || arg === "--phones") opts.phones = argv[++index];
    else if (arg === "--quantity") opts.quantity = Number(argv[++index]);
    else if (arg === "--coupon-template-id") opts.couponTemplateId = argv[++index];
    else if (arg === "--out") opts.out = argv[++index];
    else if (arg === "--parse-only") opts.parseOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const parsed = opts.workOrderText ? parseWorkOrderText(opts.workOrderText) : {};
  const workOrder = normalizeWorkOrder({
    storeName: opts.storeName ?? parsed.storeName,
    storeCode: opts.storeCode ?? parsed.storeCode,
    phones: opts.phones ?? parsed.phones,
    quantity: opts.quantity ?? parsed.quantity,
    couponTemplateId: opts.couponTemplateId,
  });
  return { ...opts, workOrder };
}

function printHelp() {
  console.log(`Usage:
  node scripts/invite-ticket-dry-run.mjs --work-order-file <txt>
  node scripts/invite-ticket-dry-run.mjs --store-name <name> --store-code <JD...> --phones <mobile;mobile> --quantity <n>

Options:
  --cdp-url <url>             Chrome remote debugging URL. Default: http://127.0.0.1:9222
  --coupon-template-id <id>   Coupon template id. Default: ${DEFAULT_COUPON_TEMPLATE_ID}
  --out <path>                Write dry-run result JSON. Default: tmp/invite-ticket-dry-run.json
  --parse-only                Only parse and validate the work order; do not call the admin APIs.

Dry run calls read/query APIs and uploads the phone Excel to obtain an import key. It never calls /manualActivity/djSave.
`);
}

function parseWorkOrderText(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labelMap = new Map([
    ["券适用门店（仅适用联营商名下一家门店）", "storeName"],
    ["券适用门店", "storeName"],
    ["门店编号（JD开头）", "storeCode"],
    ["门店编号", "storeCode"],
    ["收券人手机号（多个手机号用；隔开，请确保手机号正确否则无法发送）", "phones"],
    ["收券人手机号", "phones"],
    ["单个手机号发券数量", "quantity"],
  ]);
  const knownLabels = new Set([
    ...labelMap.keys(),
    "标题",
    "申请说明",
    "申请原因",
  ]);
  const result = {};

  function isKnownLabelLine(line) {
    for (const label of knownLabels) {
      if (line === label) return true;
      if (line.startsWith(label) && /^[:：\t\s]/.test(line.slice(label.length))) return true;
    }
    return false;
  }

  function collectValue(index, initialValue) {
    const parts = [];
    if (initialValue) parts.push(initialValue);
    for (let next = index + 1; next < lines.length; next += 1) {
      if (isKnownLabelLine(lines[next])) break;
      parts.push(lines[next]);
    }
    return parts.join(" ").trim();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const direct = [...labelMap.entries()].find(([label]) => {
      if (!line.startsWith(label) || line === label) return false;
      return /^[:：\t\s]/.test(line.slice(label.length));
    });
    if (direct) {
      const [label, key] = direct;
      const value = line.slice(label.length).replace(/^[:：\t\s]+/, "").trim();
      const collected = collectValue(index, value);
      if (collected) result[key] = collected;
      continue;
    }
    const key = labelMap.get(line);
    if (!key) continue;
    const collected = collectValue(index, "");
    if (collected) result[key] = collected;
  }
  if (result.quantity !== undefined) result.quantity = Number(String(result.quantity).match(/\d+/)?.[0]);
  return result;
}

function normalizePhones(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[;；,，\s]+/);
  const phones = [];
  const seen = new Set();
  for (const item of raw) {
    const phone = String(item || "").trim();
    if (!phone) continue;
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error(`invalid phone number: ${phone}`);
    if (!seen.has(phone)) {
      seen.add(phone);
      phones.push(phone);
    }
  }
  if (!phones.length) throw new Error("at least one phone number is required");
  return phones;
}

function normalizeWorkOrder(input) {
  const storeName = String(input.storeName || "").trim();
  const storeCode = String(input.storeCode || "").trim();
  const phones = normalizePhones(input.phones);
  const quantity = Number(input.quantity);
  const couponTemplateId = String(input.couponTemplateId || DEFAULT_COUPON_TEMPLATE_ID).trim();

  if (!storeName) throw new Error("store name is required");
  if (!/^JD\d+$/.test(storeCode)) throw new Error("store code must start with JD and digits");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (quantity > MAX_PER_PHONE) throw new Error(`single-phone quantity must be <= ${MAX_PER_PHONE}`);
  return {
    storeName,
    storeCode,
    phones,
    quantity,
    couponTemplateId,
    submitQuantities: splitQuantity(quantity),
    totalQuantity: quantity * phones.length,
  };
}

function splitQuantity(quantity) {
  if (quantity <= MAX_PER_SUBMIT) return [quantity];
  return [MAX_PER_SUBMIT, quantity - MAX_PER_SUBMIT];
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = textBytes(file.name);
    const data = textBytes(file.content);
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = concatBytes(centrals);
  return concatBytes([
    ...locals,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
}

function createPhoneXlsxBase64(phones) {
  const rows = [
    '<row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>手机号码（必填）</t></is></c></row>',
    ...phones.map(
      (phone, index) =>
        `<row r="${index + 2}"><c r="A${index + 2}" t="inlineStr"><is><t></t></is></c><c r="B${index + 2}" t="inlineStr"><is><t>${xmlEscape(phone)}</t></is></c></row>`,
    ),
  ].join("");
  const files = [
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: "xl/workbook.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="导入手机号" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B${phones.length + 1}"/><sheetData>${rows}</sheetData></worksheet>`,
    },
  ];
  return Buffer.from(zipStore(files)).toString("base64");
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
      }, 30000);
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

function runtimeExpression(workOrder, xlsxBase64) {
  return `
(async () => {
  const workOrder = ${JSON.stringify(workOrder)};
  const xlsxBase64 = ${JSON.stringify(xlsxBase64)};
  const ACTIVITY_API = ${JSON.stringify(ACTIVITY_API)};
  const SHOP_API = ${JSON.stringify(SHOP_API)};
  const STORE_MISMATCH_RETURN_COMMENT = ${JSON.stringify(STORE_MISMATCH_RETURN_COMMENT)};
  const DEFAULT_INVITE_SOURCE_ACTIVITY_NO = ${JSON.stringify(DEFAULT_INVITE_SOURCE_ACTIVITY_NO)};
  const SUBMIT_ENDPOINT = ACTIVITY_API + "/manualActivity/djSave";

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
  if (!token) throw new Error("No token found in current marketing page");

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
    const request = { method, credentials: "include", headers: { ...headers } };
    if (body !== undefined) {
      request.headers["Content-Type"] = "application/json;charset=UTF-8";
      request.body = JSON.stringify(body);
    }
    const response = await fetch(url, request);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { rawText: text }; }
    if (!response.ok) throw new Error(method + " " + url + " failed: HTTP " + response.status + " " + text.slice(0, 300));
    if (json && json.status !== undefined && json.status !== 0) throw new Error(method + " " + url + " failed: " + JSON.stringify(json));
    return { status: response.status, url, json, data: unwrap(json) };
  }

  function chooseBy(rows, predicates, label) {
    for (const predicate of predicates) {
      const found = rows.find(predicate);
      if (found) return found;
    }
    throw new Error("No matching " + label + " found. candidates=" + JSON.stringify(rows.slice(0, 5)));
  }

  function compactShop(row) {
    return {
      shopMdCode: row.shopMdCode,
      shopShowNo: row.shopShowNo,
      shopName: row.shopName,
      statusDesc: row.statusDesc,
      operationModeDesc: row.operationModeDesc,
    };
  }

  async function queryShops(filters) {
    const shopResponse = await api("POST", SHOP_API + "/crowd/shop/list", {
      shopMdCode: "",
      shopShowNo: filters.shopShowNo || "",
      shopName: filters.shopName || "",
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
    return rowsFrom(shopResponse.data);
  }

  async function uploadPhoneExcel() {
    const bytes = Uint8Array.from(atob(xlsxBase64), (char) => char.charCodeAt(0));
    const file = new File([bytes], "invite-mobile.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch(ACTIVITY_API + "/member/importExcelForManualActivity?autoRegister=true", {
      method: "POST",
      credentials: "include",
      headers: { token, terminalCode: "1", brandMdCode: "0" },
      body: form,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok || !json || json.status !== 0 || !json.data) {
      throw new Error("phone import upload failed: HTTP " + response.status + " " + text.slice(0, 500));
    }
    return json.data;
  }

  async function waitForImportResult(key) {
    let lastResult = null;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const importResultResponse = await api("GET", ACTIVITY_API + "/member/getImportResult?key=" + encodeURIComponent(key));
      lastResult = importResultResponse.data;
      if (lastResult && lastResult.status === 1) return lastResult;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("phone import is not complete: " + JSON.stringify(lastResult));
  }

  async function queryActivityPage({ activityName = "", activityNo = null, pageSize = 10 }) {
    const response = await api("POST", ACTIVITY_API + "/activity/page", {
      pageNum: 1,
      pageSize,
      activityName,
      activityNo,
      activityType: "",
      activityStatus: "",
      modifyName: "",
      startTime: ["2025-01-01 00:00:00", "2027-12-31 23:59:59"],
    });
    return rowsFrom(response.data);
  }

  function chooseSourceActivity(rows, predicates) {
    for (const predicate of predicates) {
      const found = rows.find(predicate);
      if (found) return found;
    }
    return null;
  }

  const steps = [];
  const sourceMode = "fixed_invite_template";
  const activityRows = await queryActivityPage({ activityNo: DEFAULT_INVITE_SOURCE_ACTIVITY_NO, pageSize: 10 });
  const sourceActivity = chooseSourceActivity(
    activityRows,
    [
      (row) => String(row.activityNo || "") === DEFAULT_INVITE_SOURCE_ACTIVITY_NO,
    ]
  );
  if (!sourceActivity) {
    throw new Error(
      "No matching fixed source activity found. fixedTemplateActivityNo=" +
        DEFAULT_INVITE_SOURCE_ACTIVITY_NO +
        " fixedTemplateCandidates=" +
        JSON.stringify(activityRows.slice(0, 5))
    );
  }
  steps.push({ api: "POST /activity/page", candidates: activityRows.length, selected: {
    id: sourceActivity.id, activityNo: sourceActivity.activityNo, activityName: sourceActivity.activityName, activityStatus: sourceActivity.activityStatus,
  }, mode: sourceMode, fixedTemplateActivityNo: DEFAULT_INVITE_SOURCE_ACTIVITY_NO });

  const detailId = sourceActivity.id || sourceActivity.activityId;
  const detailResponse = await api("POST", ACTIVITY_API + "/manualActivity/detail?id=" + encodeURIComponent(detailId));
  const detail = detailResponse.data;
  steps.push({ api: "POST /manualActivity/detail", selected: {
    id: detail.id, activityNo: detail.activityNo, activityName: detail.activityName, activityType: detail.activityType,
  }});

  const couponResponse = await api(
    "GET",
    ACTIVITY_API + "/coupon/djpage?templateNo=" + encodeURIComponent(workOrder.couponTemplateId) + "&modifyTimeStart=&modifyTimeEnd=&pageNum=1&pageSize=10"
  );
  const couponRows = rowsFrom(couponResponse.data);
  const coupon = chooseBy(couponRows, [(row) => String(row.templateNo || row.templateId || "") === workOrder.couponTemplateId], "coupon template");
  const couponName = coupon.templateName || coupon.couponName || coupon.name || "招待券";
  steps.push({ api: "GET /coupon/djpage", candidates: couponRows.length, selected: {
    templateNo: coupon.templateNo || coupon.templateId, templateName: couponName, shopExtend: coupon.shopExtend,
  }});

  const shopLookups = [];
  for (const filters of [
    { mode: "code_and_name", shopShowNo: workOrder.storeCode, shopName: workOrder.storeName },
    { mode: "code_only", shopShowNo: workOrder.storeCode },
    { mode: "name_only", shopName: workOrder.storeName },
  ]) {
    const rows = await queryShops(filters);
    shopLookups.push({ mode: filters.mode, candidates: rows.length, sample: rows.slice(0, 5).map(compactShop) });
  }
  const shopsByKey = new Map();
  for (const shop of shopLookups.flatMap((lookup) => lookup.sample)) {
    shopsByKey.set(String(shop.shopMdCode || shop.shopShowNo || shop.shopName), shop);
  }
  const shopRows = [...shopsByKey.values()];
  if (!shopRows.length) throw new Error("store search returned no rows. lookups=" + JSON.stringify(shopLookups));
  const shop = shopRows.find((row) => String(row.shopShowNo || "") === workOrder.storeCode && String(row.shopName || "") === workOrder.storeName);
  if (!shop) {
    return {
      ok: false,
      fallback: true,
      fallbackReason: "store_name_code_mismatch",
      returnComment: STORE_MISMATCH_RETURN_COMMENT,
      stoppedBeforePhoneImport: true,
      stoppedBeforeSubmit: true,
      page: { href: location.href, brandMdCode, hasToken: Boolean(token) },
      workOrder,
      steps: [
        ...steps,
        {
          api: "POST /crowd/shop/list",
          candidates: shopRows.length,
          selected: null,
          lookups: shopLookups,
        },
      ],
      submitEndpoint: SUBMIT_ENDPOINT,
    };
  }
  steps.push({ api: "POST /crowd/shop/list", candidates: shopRows.length, selected: {
    shopMdCode: shop.shopMdCode, shopShowNo: shop.shopShowNo, shopName: shop.shopName, statusDesc: shop.statusDesc, operationModeDesc: shop.operationModeDesc,
  }, lookups: shopLookups });

  const importMobileSuccessKey = await uploadPhoneExcel();
  steps.push({ api: "POST /member/importExcelForManualActivity", selected: { importMobileSuccessKey, phoneCount: workOrder.phones.length } });

  const importResult = await waitForImportResult(importMobileSuccessKey);
  if (Number(importResult.allCount || 0) !== workOrder.phones.length) {
    throw new Error("phone import count mismatch: expected " + workOrder.phones.length + ", got " + importResult.allCount);
  }
  if (Number(importResult.failedCount || 0) !== 0 || Number(importResult.noRegisterCount || 0) !== 0) {
    throw new Error("phone import has failed or unregistered rows: " + JSON.stringify(importResult));
  }
  const excelUrl = {
    successExcelUrl: importResult.successExcelUrl || "",
    failedExcelUrl: importResult.failedExcelUrl || "",
    noRegisterExcelUrl: importResult.noRegisterExcelUrl || "",
  };
  steps.push({ api: "GET /member/getImportResult", selected: {
    allCount: importResult.allCount, failedCount: importResult.failedCount, noRegisterCount: importResult.noRegisterCount, status: importResult.status,
  }});

  function buildPayload(sendNums) {
    const payload = JSON.parse(JSON.stringify(detail));
    payload.id = null;
    payload.activityStatus = null;
    payload.activityName = workOrder.storeName + "-招待*" + sendNums;
    payload.shopExtend = 1;
    payload.putShopType = 1;
    payload.shopMdCode = shop.shopMdCode;
    payload.startTimeType = payload.startTimeType || 1;
    payload.triggleTimeRule = payload.triggleTimeRule || { triggleDate: [], triggleTime: "", triggleStartTime: "", triggleEndTime: "" };
    payload.putPeopleType = 2;
    payload.excelUrl = excelUrl;
    payload.excelKey = importMobileSuccessKey;
    payload.importMobileSuccessKey = importMobileSuccessKey;
    payload.importMemberSuccessKey = "";
    payload.memberSaveParamList = [];
    payload.memberVOList = [];
    payload.sensorsUserGroupList = [];
    payload.sensorsMemberCount = null;
    payload.hasUserCrowd = false;
    payload.userCrowdInfo = null;
    payload.channel = 1;
    payload.channelInfo = null;
    payload.couponTemplateSaveParamList = [{ templateNo: workOrder.couponTemplateId, templateName: couponName, sendNums: String(sendNums), shopExtend: 1 }];
    payload.couponTemplateVOList = [{ templateNo: workOrder.couponTemplateId, templateName: couponName, sendNums: Number(sendNums), shopExtend: 1 }];
    payload.manualSendCouponMaterial = payload.manualSendCouponMaterial || { sendMsg: 2, msgSendType: [] };
    return payload;
  }

  const payloads = workOrder.submitQuantities.map(buildPayload);
  return {
    ok: true,
    stoppedBeforeSubmit: true,
    warning: "Dry run only. /manualActivity/djSave was not called.",
    page: { href: location.href, brandMdCode, hasToken: Boolean(token) },
    workOrder: {
      ...workOrder,
      activityNames: workOrder.submitQuantities.map((quantity) => workOrder.storeName + "-招待*" + quantity),
    },
    steps,
    submitEndpoint: SUBMIT_ENDPOINT,
    payloads,
    payload: payloads[0],
  };
})()
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workOrder = opts.workOrder;

  if (opts.parseOnly) {
    console.log(JSON.stringify(workOrder, null, 2));
    return;
  }

  const xlsxBase64 = createPhoneXlsxBase64(workOrder.phones);
  const version = await fetchJson(`${opts.cdpUrl.replace(/\/$/, "")}/json/version`);
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.open();

  try {
    await client.send("Target.setDiscoverTargets", { discover: true });
    const targets = await client.send("Target.getTargets");
    const targetInfo = (targets.targetInfos || []).find(
      (target) => ["page", "iframe"].includes(target.type) && String(target.url || target.title || "").includes("marketingweb."),
    );
    if (!targetInfo) throw new Error("No marketingweb tab/iframe found. Open the marketing page in remote-debugging Chrome first.");

    const attach = await client.send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
    await client.send("Runtime.enable", {}, attach.sessionId);
    const evaluation = await client.send(
      "Runtime.evaluate",
      { expression: runtimeExpression(workOrder, xlsxBase64), awaitPromise: true, returnByValue: true, timeout: 120000 },
      attach.sessionId,
    );
    if (evaluation.exceptionDetails) {
      const description = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || "Runtime evaluation failed";
      throw new Error(description);
    }

    const result = evaluation.result?.value;
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    if (!result.ok) {
      console.log(`dry-run fallback: wrote ${outPath}`);
      console.log(`reason: ${result.fallbackReason || "unknown"}`);
      if (result.returnComment) console.log(`return comment: ${result.returnComment}`);
      console.log("stopped before submit: /manualActivity/djSave was not called");
      process.exitCode = 2;
      return;
    }

    console.log(`dry-run ok: wrote ${outPath}`);
    console.log(`activities: ${result.workOrder.activityNames.join(", ")}`);
    console.log(`store: ${result.steps.find((step) => step.api === "POST /crowd/shop/list")?.selected.shopShowNo}`);
    console.log(`phones: ${workOrder.phones.length}`);
    console.log(`quantity per phone: ${workOrder.quantity}`);
    console.log("stopped before submit: /manualActivity/djSave was not called");
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
