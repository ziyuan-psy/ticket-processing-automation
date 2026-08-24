#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ALLOWED_TEMPLATE_IDS = new Set([
  "CT20231226000001",
  "CT20231223000003",
  "CT20250710000002",
  "CT20231226000002",
  "CT20240105000003",
  "CT20260616000005",
  "CT20260129000001",
  "CT20240220000001",
  "CT20231224000002",
  "CT20231220000010",
  "CT20260420000004",
  "CT20260814000011",
  "CT20260224000001",
  "CT20231215000003",
  "CT20260408000010",
  "CT20260622000007",
  "CT20240104000001",
]);

function parseArgs(argv) {
  const opts = {
    cdpUrl: process.env.CDP_URL || "http://127.0.0.1:9223",
    dryRunFile: "tmp/coupon-ticket-dry-run.json",
    out: "tmp/coupon-ticket-submit-result.json",
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
  if (!opts.confirmSubmit) throw new Error("Refusing to submit without --confirm-submit");
  return opts;
}

function printHelp() {
  console.log(`Usage:
  node scripts/coupon-ticket-submit.mjs --dry-run-file <path> --confirm-submit

Options:
  --cdp-url <url>       Chrome remote debugging URL. Default: http://127.0.0.1:9223
  --out <path>          Write submit result JSON. Default: tmp/coupon-ticket-submit-result.json
  --confirm-submit      Required. Calls /manualActivity/djSave via the shared submit script.
`);
}

function validateDryRun(path) {
  const result = JSON.parse(readFileSync(path, "utf8"));
  if (result?.workOrder?.workflowType !== "coupon_ticket") {
    throw new Error("Input file does not look like a coupon-ticket dry run");
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [result.payload];
  if (!payloads.length) throw new Error("Dry-run file has no payloads");
  for (const payload of payloads) {
    const templateId = payload?.couponTemplateSaveParamList?.[0]?.templateNo;
    if (!ALLOWED_TEMPLATE_IDS.has(templateId)) {
      throw new Error(`Unexpected coupon template id for coupon ticket: ${templateId}`);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dryRunFile = resolve(opts.dryRunFile);
  validateDryRun(dryRunFile);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const inviteSubmit = resolve(scriptDir, "invite-ticket-submit.mjs");
  const completed = spawnSync(
    process.execPath,
    [
      inviteSubmit,
      "--cdp-url",
      opts.cdpUrl,
      "--dry-run-file",
      dryRunFile,
      "--out",
      opts.out,
      "--confirm-submit",
    ],
    { encoding: "utf8" },
  );
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  process.exitCode = completed.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
