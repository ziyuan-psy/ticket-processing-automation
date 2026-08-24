#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-token",
  "token",
]);

const SENSITIVE_QUERY_PARTS = [
  "authorization",
  "cookie",
  "csrf",
  "password",
  "secret",
  "session",
  "sid",
  "token",
];

const PHONE_RE = /1[3-9]\d{9}/g;

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9223",
    host: "cotticoffee.com,yummy.tech,abite.com",
    out: "captures/cdp-network.ndjson",
    pauseNewTabs: false,
    maxBodyChars: 2000,
    maxResponseBodyChars: 20000,
    keepPhones: false,
    includeResponseBodies: false,
    durationMs: 0,
    stopFile: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp-url") opts.cdpUrl = argv[++index];
    else if (arg === "--host") opts.host = argv[++index];
    else if (arg === "--out") opts.out = argv[++index];
    else if (arg === "--pause-new-tabs") opts.pauseNewTabs = true;
    else if (arg === "--max-body-chars") opts.maxBodyChars = Number(argv[++index]);
    else if (arg === "--max-response-body-chars") opts.maxResponseBodyChars = Number(argv[++index]);
    else if (arg === "--keep-phones") opts.keepPhones = true;
    else if (arg === "--include-response-bodies") opts.includeResponseBodies = true;
    else if (arg === "--duration-ms") opts.durationMs = Number(argv[++index]);
    else if (arg === "--stop-file") opts.stopFile = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.maxBodyChars) || opts.maxBodyChars < 0) {
    throw new Error("--max-body-chars must be a non-negative number");
  }
  if (!Number.isFinite(opts.maxResponseBodyChars) || opts.maxResponseBodyChars < 0) {
    throw new Error("--max-response-body-chars must be a non-negative number");
  }
  if (!Number.isFinite(opts.durationMs) || opts.durationMs < 0) {
    throw new Error("--duration-ms must be a non-negative number");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  node scripts/record-cdp-network.mjs [options]

Options:
  --cdp-url <url>         Chrome remote debugging URL. Default: http://127.0.0.1:9223
  --host <host>           Only record requests whose host contains this value.
                           Use commas for multiple hosts, or an empty string for all.
                           Default: cotticoffee.com,yummy.tech,abite.com
  --out <path>            Output NDJSON path. Default: captures/cdp-network.ndjson
  --pause-new-tabs        Pause newly opened tabs until Network is enabled.
                           Useful when the first request in a popup matters.
  --max-body-chars <n>    Max request body characters to keep. Default: 2000
  --max-response-body-chars <n>
                          Max response body characters to keep. Default: 20000
  --keep-phones           Keep phone numbers in URLs and request bodies.
  --include-response-bodies
                          Record API response bodies after requests finish.
  --duration-ms <n>       Stop automatically after this many milliseconds. Default: 0
  --stop-file <path>      Stop when this file exists.
`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

function redactScalar(name, value, keepPhones = false) {
  const text = String(value ?? "");
  const lowered = String(name ?? "").toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lowered)) {
    return "<redacted>";
  }
  if (SENSITIVE_QUERY_PARTS.some((part) => lowered.includes(part))) {
    return "<redacted>";
  }
  if (keepPhones) {
    return text;
  }
  if (lowered.includes("phone") || lowered.includes("mobile")) {
    return text.replace(PHONE_RE, "<phone>");
  }
  return text.replace(PHONE_RE, "<phone>");
}

function redactHeaders(headers = {}, keepPhones = false) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = redactScalar(name, value, keepPhones);
  }
  return result;
}

function redactUrl(url, keepPhones = false) {
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      parsed.searchParams.set(key, redactScalar(key, value, keepPhones));
    }
    const text = parsed.toString();
    return keepPhones ? text : text.replace(PHONE_RE, "<phone>");
  } catch {
    const text = String(url);
    return keepPhones ? text : text.replace(PHONE_RE, "<phone>");
  }
}

function redactBody(body, maxBodyChars, keepPhones = false) {
  if (!body) return "";
  let redacted = String(body);
  if (!keepPhones) {
    redacted = redacted.replace(PHONE_RE, (match, offset, source) => {
      const prev = source[offset - 1];
      const next = source[offset + match.length];
      if (prev === '"' && next === '"') return "<phone>";
      return "0";
    });
  }
  redacted = redacted.replace(
    /("(?:authorization|cookie|csrf|password|secret|session|sid|token)"\s*:\s*")[^"]+(")/gi,
    "$1<redacted>$2",
  );
  if (redacted.length > maxBodyChars) {
    redacted = `${redacted.slice(0, maxBodyChars)}...`;
  }
  return redacted;
}

function hostMatches(url, host) {
  if (!host) return true;
  const hostParts = String(host)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!hostParts.length) return true;
  try {
    const urlHost = new URL(url).host;
    return hostParts.some((item) => urlHost.includes(item));
  } catch {
    return false;
  }
}

function targetSummary(targetInfo = {}, keepPhones = false) {
  return {
    id: targetInfo.targetId,
    type: targetInfo.type,
    title: targetInfo.title,
    url: redactUrl(targetInfo.url || "", keepPhones),
  };
}

class CdpRecorder {
  constructor(opts) {
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.targetToSession = new Map();
    this.attachPending = new Set();
    this.requests = new Map();
    this.stream = null;
    this.ws = null;
  }

  async start() {
    const outPath = resolve(this.opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    this.stream = createWriteStream(outPath, { flags: "a", encoding: "utf8" });

    const versionUrl = `${this.opts.cdpUrl.replace(/\/$/, "")}/json/version`;
    let version;
    try {
      version = await fetchJson(versionUrl);
    } catch (error) {
      console.error(`Cannot reach Chrome DevTools at ${versionUrl}.`);
      console.error("Start Chrome with --remote-debugging-port=9223, then run this recorder again.");
      throw error;
    }

    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener("open", resolveOpen, { once: true });
      this.ws.addEventListener("error", rejectOpen, { once: true });
    });

    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      this.write({ event: "browser-disconnected" });
      process.exitCode = 1;
    });

    await this.send("Target.setDiscoverTargets", { discover: true });
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: this.opts.pauseNewTabs,
      flatten: true,
    });

    const targets = await this.send("Target.getTargets");
    for (const targetInfo of targets.targetInfos || []) {
      await this.attachIfInspectableTarget(targetInfo);
    }

    this.write({
      event: "recorder-started",
      cdpUrl: this.opts.cdpUrl,
      host: this.opts.host,
      pauseNewTabs: this.opts.pauseNewTabs,
      keepPhones: this.opts.keepPhones,
      includeResponseBodies: this.opts.includeResponseBodies,
      durationMs: this.opts.durationMs,
      stopFile: this.opts.stopFile,
    });

    console.log(`Recording ${this.opts.host || "all hosts"} to ${outPath}`);
    if (this.opts.durationMs > 0) {
      console.log(`Recorder will stop after ${this.opts.durationMs} ms.`);
    } else if (this.opts.stopFile) {
      console.log(`Recorder will stop when ${this.opts.stopFile} exists.`);
    } else {
      console.log("Press Ctrl+C to stop.");
    }
  }

  async attachIfInspectableTarget(targetInfo) {
    if (!targetInfo || !["page", "iframe"].includes(targetInfo.type)) return;
    if (this.targetToSession.has(targetInfo.targetId)) return;
    if (this.attachPending.has(targetInfo.targetId)) return;

    this.attachPending.add(targetInfo.targetId);
    try {
      await this.send("Target.attachToTarget", {
        targetId: targetInfo.targetId,
        flatten: true,
      });
    } catch (error) {
      this.write({
        event: "target-attach-failed",
        target: targetSummary(targetInfo, this.opts.keepPhones),
        error: String(error.message || error),
      });
    } finally {
      this.attachPending.delete(targetInfo.targetId);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    this.handleEvent(message).catch((error) => {
      this.write({ event: "recorder-error", error: String(error.message || error) });
    });
  }

  async handleEvent(message) {
    const { method, params = {}, sessionId } = message;

    if (method === "Target.targetCreated") {
      await this.attachIfInspectableTarget(params.targetInfo);
      return;
    }

    if (method === "Target.attachedToTarget") {
      const targetInfo = params.targetInfo || {};
      this.sessions.set(params.sessionId, targetInfo);
      this.targetToSession.set(targetInfo.targetId, params.sessionId);
      this.write({
        event: "target-attached",
        sessionId: params.sessionId,
        target: targetSummary(targetInfo, this.opts.keepPhones),
      });

      await this.send("Network.enable", { maxPostDataSize: 1024 * 1024 }, params.sessionId);
      await this.send("Page.enable", {}, params.sessionId).catch(() => {});
      if (this.opts.pauseNewTabs) {
        await this.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
      }
      return;
    }

    if (method === "Target.detachedFromTarget") {
      const targetInfo = this.sessions.get(params.sessionId);
      this.sessions.delete(params.sessionId);
      if (targetInfo?.targetId) this.targetToSession.delete(targetInfo.targetId);
      this.write({
        event: "target-detached",
        sessionId: params.sessionId,
        target: targetSummary(targetInfo, this.opts.keepPhones),
      });
      return;
    }

    if (!sessionId || !method?.startsWith("Network.")) return;

    const targetInfo = this.sessions.get(sessionId) || {};
    if (method === "Network.requestWillBeSent") {
      const request = params.request || {};
      if (!hostMatches(request.url, this.opts.host)) return;

      const requestKey = `${sessionId}:${params.requestId}`;
      this.requests.set(requestKey, {
        url: request.url,
        method: request.method,
        targetInfo,
        response: null,
      });

      this.write({
        event: "request",
        sessionId,
        requestId: params.requestId,
        resourceType: params.type,
        target: targetSummary(targetInfo, this.opts.keepPhones),
        documentURL: redactUrl(params.documentURL || "", this.opts.keepPhones),
        initiatorType: params.initiator?.type,
        method: request.method,
        url: redactUrl(request.url, this.opts.keepPhones),
        headers: redactHeaders(request.headers, this.opts.keepPhones),
        postData: redactBody(request.postData || "", this.opts.maxBodyChars, this.opts.keepPhones),
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params.response || {};
      if (!hostMatches(response.url, this.opts.host)) return;

      this.write({
        event: "response",
        sessionId,
        requestId: params.requestId,
        resourceType: params.type,
        target: targetSummary(targetInfo, this.opts.keepPhones),
        url: redactUrl(response.url, this.opts.keepPhones),
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        headers: redactHeaders(response.headers, this.opts.keepPhones),
      });

      const requestKey = `${sessionId}:${params.requestId}`;
      const request = this.requests.get(requestKey);
      if (request) {
        request.response = {
          status: response.status,
          mimeType: response.mimeType,
        };
      }
      return;
    }

    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const requestKey = `${sessionId}:${params.requestId}`;
      const request = this.requests.get(requestKey);
      if (!request || !hostMatches(request.url, this.opts.host)) return;

      this.write({
        event: method === "Network.loadingFinished" ? "finished" : "failed",
        sessionId,
        requestId: params.requestId,
        target: targetSummary(request.targetInfo, this.opts.keepPhones),
        method: request.method,
        url: redactUrl(request.url, this.opts.keepPhones),
        encodedDataLength: params.encodedDataLength,
        errorText: params.errorText,
        canceled: params.canceled,
      });

      if (method === "Network.loadingFinished" && this.opts.includeResponseBodies) {
        await this.writeResponseBody(sessionId, params.requestId, request);
      }

      this.requests.delete(requestKey);
    }
  }

  async writeResponseBody(sessionId, requestId, request) {
    const mimeType = request.response?.mimeType || "";
    try {
      const responseBody = await this.send("Network.getResponseBody", { requestId }, sessionId);
      if (responseBody.base64Encoded) {
        this.write({
          event: "response-body",
          sessionId,
          requestId,
          target: targetSummary(request.targetInfo, this.opts.keepPhones),
          method: request.method,
          url: redactUrl(request.url, this.opts.keepPhones),
          mimeType,
          base64Encoded: true,
          body: "<base64 response omitted>",
        });
        return;
      }

      this.write({
        event: "response-body",
        sessionId,
        requestId,
        target: targetSummary(request.targetInfo, this.opts.keepPhones),
        method: request.method,
        url: redactUrl(request.url, this.opts.keepPhones),
        mimeType,
        base64Encoded: false,
        body: redactBody(responseBody.body || "", this.opts.maxResponseBodyChars, this.opts.keepPhones),
      });
    } catch (error) {
      this.write({
        event: "response-body-failed",
        sessionId,
        requestId,
        target: targetSummary(request.targetInfo, this.opts.keepPhones),
        method: request.method,
        url: redactUrl(request.url, this.opts.keepPhones),
        mimeType,
        error: String(error.message || error),
      });
    }
  }

  write(event) {
    if (!this.stream) return;
    this.stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  }

  close() {
    this.write({ event: "recorder-stopped" });
    this.stream?.end();
    this.ws?.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const recorder = new CdpRecorder(opts);

  process.on("SIGINT", () => {
    console.log("\nStopping recorder...");
    recorder.close();
    setTimeout(() => process.exit(0), 100);
  });

  await recorder.start();
  if (opts.durationMs > 0) {
    setTimeout(() => {
      console.log("\nStopping recorder after duration...");
      recorder.close();
      setTimeout(() => process.exit(0), 100);
    }, opts.durationMs);
  }
  if (opts.stopFile) {
    const stopPath = resolve(opts.stopFile);
    const timer = setInterval(() => {
      if (existsSync(stopPath)) {
        clearInterval(timer);
        console.log("\nStopping recorder after stop file...");
        recorder.close();
        setTimeout(() => process.exit(0), 100);
      }
    }, 1000);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
