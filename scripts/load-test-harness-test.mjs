import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let responseMode = "valid";
const clientId = "load-harness-client";
const businessDate = "2026-10-14";
let active = 0;
let maximumActive = 0;
let reportCount = 0;
const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/reports/daily-state")) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    reportCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    response.writeHead(200, { "content-type": responseMode === "content-type" ? "text/plain" : "application/json" });
    response.end(JSON.stringify(responseMode === "payload" ? {
      clientId: "unexpected-client",
      businessDate,
      stations: [],
    } : {
      clientId,
      businessDate,
      stations: [{ stationId: "station-one" }],
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const environment = {
  ...process.env,
  LOAD_TEST_BASE_URL: `http://127.0.0.1:${port}`,
  LOAD_TEST_TOKEN: "local-test-token",
  LOAD_TEST_CLIENT_ID: clientId,
  LOAD_TEST_DATE: businessDate,
  LOAD_TEST_REQUESTS: "12",
  LOAD_TEST_CONCURRENCY: "3",
  LOAD_TEST_TIMEOUT_MS: "2000",
};

function runHarness(overrides = {}, inheritOutput = false) {
  responseMode = overrides.LOAD_HARNESS_TEST_MODE ?? "valid";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/load-test.mjs"], {
      cwd: process.cwd(),
      env: { ...environment, ...overrides },
      stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  const result = await runHarness();
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.requests, 12);
  assert.equal(summary.concurrency, 3);
  assert.equal(summary.failures, 0);
  assert.equal(summary.stationCount, 1);
  assert.equal(summary.failedStatuses.length, 0);
  assert.ok(summary.latencyMs.p50 >= 0 && summary.latencyMs.p95 >= summary.latencyMs.p50);
  assert.ok(summary.latencyMs.max >= summary.latencyMs.p95);
  assert.ok(summary.requestsPerSecond > 0);
  assert.equal(reportCount, 15, "three warm-up requests and twelve measured requests are expected");
  assert.ok(maximumActive <= 3, `configured concurrency was exceeded (${maximumActive})`);
  assert.ok(maximumActive > 1, "harness did not exercise concurrent requests");
  console.log("PASS load-test request count, warm-up, concurrency, payload validation, and metrics");

  reportCount = 0;
  maximumActive = 0;
  const badPayload = await runHarness({ LOAD_HARNESS_TEST_MODE: "payload" });
  assert.equal(badPayload.code, 1, "mismatched client payload must fail the benchmark");
  assert.equal(reportCount, 1, "invalid warm-up payload must stop immediately before measured requests");
  assert.match(badPayload.stderr, /Warm-up request failed: Report payload did not match/);
  console.log("PASS warm-up stops on tenant/date/schema mismatch");

  const badContentType = await runHarness({ LOAD_HARNESS_TEST_MODE: "content-type" });
  assert.equal(badContentType.code, 1, "non-JSON response must fail the benchmark");
  assert.match(badContentType.stderr, /Warm-up request failed: Expected JSON response/);
  console.log("PASS warm-up stops on a non-JSON response");

  const unsafeTarget = await runHarness({ LOAD_TEST_BASE_URL: "https://example.invalid" });
  assert.notEqual(unsafeTarget.code, 0, "remote benchmark must require explicit opt-in");
  assert.match(unsafeTarget.stderr, /LOAD_TEST_ALLOW_REMOTE=1/);
  console.log("PASS remote-target opt-in guard");

  const invalidConcurrency = await runHarness({ LOAD_TEST_CONCURRENCY: "13" });
  assert.notEqual(invalidConcurrency.code, 0, "concurrency above request count must be rejected");
  assert.match(invalidConcurrency.stderr, /LOAD_TEST_CONCURRENCY/);
  console.log("PASS load-test input bounds");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
