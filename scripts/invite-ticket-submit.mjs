#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ALLOWED_ENDPOINTS = new Set([
  "https://marketingadmin.abite.com/manualActivity/djSave",
  "https://marketingadmin.cotticoffee.com/manualActivity/djSave",
]);

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9222",
    dryRunFile: "tmp/invite-ticket-dry-run.json",
    out: "tmp/invite-ticket-submit-result.json",
    confirmSubmit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url") opts.cdpUrl = argv[++index];
    else if (arg === "--dry-run-file") opts.dryRunFile = argv[++index];
    else if (arg === "--out") opts.out = argv[++index];
    else if (arg === "--confirm-submit") opts.confirmSubmit = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.confirmSubmit) {
    throw new Error("Refusing to submit without --confirm-submit");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  node scripts/invite-ticket-submit.mjs --dry-run-file <path> --confirm-submit

Options:
  --cdp-url <url>       Chrome remote debugging URL. Default: http://127.0.0.1:9222
  --out <path>          Write submit result JSON. Default: tmp/invite-ticket-submit-result.json
  --confirm-submit      Required. Calls /manualActivity/djSave and then performs a read-only activity list post-check.
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

function readDryRun(path) {
  const result = JSON.parse(readFileSync(path, "utf8"));
  if (!result?.stoppedBeforeSubmit) throw new Error("Input file does not look like an invite-ticket dry run");
  if (!ALLOWED_ENDPOINTS.has(result.submitEndpoint)) {
    throw new Error(`Unexpected submit endpoint: ${result.submitEndpoint}`);
  }

  const payloads = Array.isArray(result.payloads) ? result.payloads : [result.payload];
  if (!payloads.length) throw new Error("Dry-run file has no payloads");
  for (const payload of payloads) validatePayload(payload);

  return { dryRun: result, payloads };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Dry-run file has no payload");
  if (payload.id !== null) throw new Error("Refusing to submit because payload.id is not null");
  if (payload.activityType !== 202) throw new Error(`Unexpected activityType: ${payload.activityType}`);
  if (payload.channel !== 1) throw new Error(`Unexpected channel: ${payload.channel}`);
  if (!Array.isArray(payload.couponTemplateSaveParamList) || payload.couponTemplateSaveParamList.length !== 1) {
    throw new Error("Expected exactly one couponTemplateSaveParamList item");
  }
  if (payload.putPeopleType === 1) {
    if (!Array.isArray(payload.memberSaveParamList) || payload.memberSaveParamList.length < 1) {
      throw new Error("Expected at least one memberSaveParamList item");
    }
  } else if (payload.putPeopleType === 2) {
    if (!payload.importMobileSuccessKey || payload.excelKey !== payload.importMobileSuccessKey) {
      throw new Error("Expected importMobileSuccessKey and matching excelKey for imported-phone targeting");
    }
  } else {
    throw new Error(`Unexpected putPeopleType: ${payload.putPeopleType}`);
  }

  const sendNums = Number(payload.couponTemplateSaveParamList[0].sendNums);
  if (!Number.isInteger(sendNums) || sendNums <= 0 || sendNums > 100) {
    throw new Error(`Invalid sendNums: ${payload.couponTemplateSaveParamList[0].sendNums}`);
  }
}

function runtimeExpression(payload, endpoint) {
  return `
(async () => {
  const payload = ${JSON.stringify(payload)};
  const endpoint = ${JSON.stringify(endpoint)};
  const activityApi = new URL(endpoint).origin;

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

  function parseTime(value) {
    const timestamp = Date.parse(String(value || "").replace(" ", "T"));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function compactActivity(row) {
    return {
      id: row.id,
      activityNo: row.activityNo,
      activityName: row.activityName,
      activityStatus: row.activityStatus,
      createTime: row.createTime,
      modifyTime: row.modifyTime,
      startTime: row.startTime,
      endTime: row.endTime,
    };
  }

  async function postCheckActivity() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(activityApi + "/activity/page", {
      method: "POST",
      credentials: "include",
      headers: {
        ...headers,
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({
        pageNum: 1,
        pageSize: 50,
        activityName: payload.activityName,
        activityNo: null,
        activityType: "",
        activityStatus: "",
        modifyName: "",
        startTime: ["2025-01-01 00:00:00", "2027-12-31 23:59:59"],
      }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { rawText: text };
    }
    const rows = rowsFrom(json?.data || json).filter((row) => row.activityName === payload.activityName);
    rows.sort((left, right) => {
      const timeDiff = parseTime(right.modifyTime || right.createTime) - parseTime(left.modifyTime || left.createTime);
      if (timeDiff) return timeDiff;
      return Number(right.id || 0) - Number(left.id || 0);
    });
    return {
      httpOk: response.ok,
      status: response.status,
      responseStatus: json?.status,
      activityName: payload.activityName,
      candidates: rows.length,
      selected: rows[0] ? compactActivity(rows[0]) : null,
      rows: rows.slice(0, 10).map(compactActivity),
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: {
      ...headers,
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { rawText: text };
  }

  const postCheck = response.ok && json?.status === 0 ? await postCheckActivity() : null;

  return {
    httpOk: response.ok,
    status: response.status,
    statusText: response.statusText,
    endpoint,
    page: { href: location.href, brandMdCode, hasToken: Boolean(token) },
    response: json,
    responseText: text,
    postCheck,
  };
})()
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dryRunPath = resolve(opts.dryRunFile);
  const { dryRun, payloads } = readDryRun(dryRunPath);

  const version = await fetchJson(`${opts.cdpUrl.replace(/\/$/, "")}/json/version`);
  const client = new CdpClient(version.webSocketDebuggerUrl);
  await client.open();

  try {
    await client.send("Target.setDiscoverTargets", { discover: true });
    const targets = await client.send("Target.getTargets");
    const targetInfo = (targets.targetInfos || []).find(
      (target) =>
        ["page", "iframe"].includes(target.type) &&
        String(target.url || target.title || "").includes("marketingweb."),
    );
    if (!targetInfo) {
      throw new Error("No marketingweb tab/iframe found. Open the marketing page first.");
    }

    const attach = await client.send("Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    await client.send("Runtime.enable", {}, attach.sessionId);
    const results = [];
    for (const payload of payloads) {
      const evaluation = await client.send(
        "Runtime.evaluate",
        {
          expression: runtimeExpression(payload, dryRun.submitEndpoint),
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
      results.push(evaluation.result?.value);
    }

    const output = {
      submittedAt: new Date().toISOString(),
      dryRunFile: dryRunPath,
      workOrder: dryRun.workOrder,
      submittedPayloads: payloads.map((payload) => ({
        activityName: payload.activityName,
        shopMdCode: payload.shopMdCode,
        couponTemplateSaveParamList: payload.couponTemplateSaveParamList,
        memberSaveParamList: payload.memberSaveParamList,
        importMobileSuccessKey: payload.importMobileSuccessKey,
      })),
      results,
    };

    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    console.log(`submit result written: ${outPath}`);
    for (let index = 0; index < results.length; index += 1) {
      console.log(`#${index + 1} http status: ${results[index].status}`);
      console.log(`#${index + 1} activity: ${payloads[index].activityName}`);
      console.log(`#${index + 1} response: ${results[index].responseText}`);
      if (results[index].postCheck) {
        const selected = results[index].postCheck.selected;
        console.log(`#${index + 1} post-check candidates: ${results[index].postCheck.candidates}`);
        console.log(`#${index + 1} post-check selected: ${selected ? `${selected.id} / ${selected.activityNo}` : "not found"}`);
      }
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
