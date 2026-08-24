#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const SOURCE_ACTIVITY_NO = "47678430008262656";
const MAX_PER_PHONE = 200;

const DISCOUNT_TEMPLATES = {
  "9折": "CT20231226000001",
  "8折": "CT20231223000003",
  "8.5折": "CT20250710000002",
  "8.8折": "CT20231226000002",
  "6.8折": "CT20240105000003",
  "95折": "CT20260616000005",
  "8.3折": "CT20260129000001",
  "7.9折": "CT20240220000001",
  "7.7折": "CT20231224000002",
};

const FIXED_PRICE_TEMPLATES = {
  "9.9元": "CT20231220000010",
  "12.9元": "CT20260420000004",
  "22元": "CT20260814000011",
  "10.9元": "CT20260224000001",
  "8.8元": "CT20231215000003",
  "22.5元": "CT20260408000010",
  "15元": "CT20260622000007",
  "9元": "CT20240104000001",
};

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9223",
    out: "tmp/coupon-ticket-dry-run.json",
    parseOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url") opts.cdpUrl = argv[++index];
    else if (arg === "--work-order-file") opts.workOrderText = readFileSync(argv[++index], "utf8");
    else if (arg === "--work-order-text") opts.workOrderText = argv[++index];
    else if (arg === "--store-name") opts.storeName = argv[++index];
    else if (arg === "--store-code") opts.storeCode = argv[++index];
    else if (arg === "--coupon-type") opts.couponType = argv[++index];
    else if (arg === "--coupon-value") opts.couponValue = argv[++index];
    else if (arg === "--phone" || arg === "--phones") opts.phones = argv[++index];
    else if (arg === "--quantity") opts.quantity = Number(argv[++index]);
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
  return {
    ...opts,
    workOrder: normalizeWorkOrder({
      storeName: opts.storeName ?? parsed.storeName,
      storeCode: opts.storeCode ?? parsed.storeCode,
      couponType: opts.couponType ?? parsed.couponType,
      couponValue: opts.couponValue ?? parsed.couponValue,
      phones: opts.phones ?? parsed.phones,
      quantity: opts.quantity ?? parsed.quantity,
    }),
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/coupon-ticket-dry-run.mjs --work-order-file <txt>
  node scripts/coupon-ticket-dry-run.mjs --store-name <name> --store-code <code> --coupon-type <type> --coupon-value <value> --phones <mobile;mobile> --quantity <n>

Options:
  --cdp-url <url>       Chrome remote debugging URL. Default: http://127.0.0.1:9223
  --out <path>          Write dry-run result JSON. Default: tmp/coupon-ticket-dry-run.json
  --parse-only          Only parse and validate the work order; do not call admin APIs.
`);
}

function parseWorkOrderText(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labelMap = new Map([
    ["标题", "title"],
    ["门店所在省份", "province"],
    ["门店名称（请与后台名称一致）", "storeName"],
    ["门店名称", "storeName"],
    ["门店编号（JD开头）", "storeCode"],
    ["门店编号", "storeCode"],
    ["申请券类型（默认饮品）", "couponType"],
    ["申请券类型", "couponType"],
    ["券说明", "couponDesc"],
    ["券金额/券折扣", "couponValue"],
    ["接受券手机号（请二次检查，发错不能撤回）", "phones"],
    ["接受券手机号", "phones"],
    ["发放张数", "quantity"],
    ["备注", "remark"],
  ]);
  const knownLabels = new Set(labelMap.keys());
  const labels = [...knownLabels].sort((left, right) => right.length - left.length);
  const result = {};

  function isKnownLabelLine(line) {
    return labels.some((label) => line === label || (line.startsWith(label) && /^[:：\t\s]/.test(line.slice(label.length))));
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
    const label = labels.find((candidate) => line === candidate || (line.startsWith(candidate) && /^[:：\t\s]/.test(line.slice(candidate.length))));
    if (!label) continue;
    const key = labelMap.get(label);
    const value = line === label ? "" : line.slice(label.length).replace(/^[:：\t\s]+/, "").trim();
    const collected = collectValue(index, value);
    if (collected) result[key] = collected;
  }
  if (result.quantity !== undefined) result.quantity = Number(String(result.quantity).match(/\d+/)?.[0]);
  return result;
}

function formatNumber(value) {
  return Number(value).toFixed(10).replace(/\.?0+$/, "");
}

function normalizeDiscount(value) {
  const text = String(value || "").replace(/[％%\s]/g, "");
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) throw new Error("coupon discount is required");
  let number = Number(match[0]);
  if (number === 9.5 || number === 95) return "95折";
  if (number >= 10) number /= 10;
  return `${formatNumber(number)}折`;
}

function normalizeFixedPrice(value) {
  const text = String(value || "").replace(/[元\s]/g, "");
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) throw new Error("coupon price is required");
  return `${formatNumber(Number(match[0]))}元`;
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

function normalizeStoreCode(value) {
  const storeCode = String(value || "").trim().toUpperCase();
  if (!storeCode) throw new Error("store code is required");
  if (/^\d+$/.test(storeCode)) return `JD${storeCode}`;
  if (!/^(?:JD\d+|Q[A-Z0-9]+)$/.test(storeCode)) throw new Error("store code must be JD+digits, Q-prefixed, or digits only");
  return storeCode;
}

function extractPhoneNumbers(value) {
  const source = Array.isArray(value) ? value.join(" ") : String(value || "");
  const matches = source.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || [];
  const phones = [];
  const seen = new Set();
  for (const phone of matches) {
    if (!seen.has(phone)) {
      seen.add(phone);
      phones.push(phone);
    }
  }
  if (!phones.length) throw new Error("at least one phone number is required");
  return phones;
}

function splitQuantity(quantity) {
  return quantity <= 100 ? [quantity] : [100, quantity - 100];
}

function normalizeWorkOrder(input) {
  const storeName = String(input.storeName || "").trim();
  const storeCode = normalizeStoreCode(input.storeCode);
  const couponTypeInput = String(input.couponType || "").trim();
  const couponValueInput = String(input.couponValue || "").trim();
  const phones = extractPhoneNumbers(input.phones);
  const quantity = Number(input.quantity);
  if (!storeName) throw new Error("store name is required");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (quantity > MAX_PER_PHONE) throw new Error(`single-phone quantity must be <= ${MAX_PER_PHONE}`);

  let couponType;
  let couponValue;
  let couponTemplateId;
  if (couponTypeInput.includes("折") || couponValueInput.includes("折")) {
    couponType = "discount";
    couponValue = normalizeDiscount(couponValueInput);
    couponTemplateId = DISCOUNT_TEMPLATES[couponValue];
  } else if (couponTypeInput.includes("一口价") || couponTypeInput.includes("金额")) {
    couponType = "fixed_price";
    couponValue = normalizeFixedPrice(couponValueInput);
    couponTemplateId = FIXED_PRICE_TEMPLATES[couponValue];
  } else {
    throw new Error("coupon type must be discount or fixed price");
  }
  if (!couponTemplateId) throw new Error("券金额/券折扣未匹配到已配置模板");

  const submitQuantities = splitQuantity(quantity);
  const activityNameFragment = `优惠-${couponValue}`;
  return {
    storeName,
    storeCode,
    couponType,
    couponValue,
    couponTemplateId,
    sourceActivityNo: SOURCE_ACTIVITY_NO,
    activityNameFragment,
    phones,
    quantity,
    submitQuantities,
    totalQuantity: quantity * phones.length,
    activityNames: submitQuantities.map((sendNums) => `${storeName}${activityNameFragment}*${sendNums}`),
  };
}

function enrichDryRun(path, couponWorkOrder) {
  if (!existsSync(path)) return;
  const result = JSON.parse(readFileSync(path, "utf8"));
  result.workOrder = {
    ...(result.workOrder || {}),
    couponType: couponWorkOrder.couponType,
    couponValue: couponWorkOrder.couponValue,
    couponTemplateId: couponWorkOrder.couponTemplateId,
    sourceActivityNo: couponWorkOrder.sourceActivityNo,
    activityNameFragment: couponWorkOrder.activityNameFragment,
    activityNames: couponWorkOrder.activityNames,
    workflowType: "coupon_ticket",
  };
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workOrder = opts.workOrder;
  if (opts.parseOnly) {
    console.log(JSON.stringify(workOrder, null, 2));
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const inviteDryRun = resolve(scriptDir, "invite-ticket-dry-run.mjs");
  const args = [
    inviteDryRun,
    "--cdp-url",
    opts.cdpUrl,
    "--store-name",
    workOrder.storeName,
    "--store-code",
    workOrder.storeCode,
    "--phones",
    workOrder.phones.join(";"),
    "--quantity",
    String(workOrder.quantity),
    "--coupon-template-id",
    workOrder.couponTemplateId,
    "--source-activity-no",
    workOrder.sourceActivityNo,
    "--activity-name-fragment",
    workOrder.activityNameFragment,
    "--workflow-type",
    "coupon_ticket",
    "--out",
    opts.out,
  ];
  const completed = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  enrichDryRun(resolve(opts.out), workOrder);
  process.exitCode = completed.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
