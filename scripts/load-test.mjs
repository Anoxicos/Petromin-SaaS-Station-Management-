// Read-only authenticated pilot benchmark. No application records are created or changed.
const target = new URL(process.env.LOAD_TEST_BASE_URL || "http://localhost:3000");
const token = process.env.LOAD_TEST_TOKEN;
const clientId = process.env.LOAD_TEST_CLIENT_ID;
const localNow = new Date();
const localDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
const date = process.env.LOAD_TEST_DATE || localDate;
const requests = Number(process.env.LOAD_TEST_REQUESTS || 200);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY || 20);
const timeoutMs = Number(process.env.LOAD_TEST_TIMEOUT_MS || 20_000);

if (!token || !clientId) throw new Error("Set LOAD_TEST_TOKEN and LOAD_TEST_CLIENT_ID for the pilot account.");
const parsedDate = new Date(`${date}T00:00:00Z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) throw new Error("LOAD_TEST_DATE must use a valid YYYY-MM-DD calendar date.");
if (!Number.isInteger(requests) || requests < 1 || requests > 10000) throw new Error("LOAD_TEST_REQUESTS must be from 1 to 10000.");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200 || concurrency > requests) throw new Error("LOAD_TEST_CONCURRENCY must be from 1 to min(200, requests).");
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("LOAD_TEST_TIMEOUT_MS must be from 100 to 120000.");
if (!new Set(["http:", "https:"]).has(target.protocol)) throw new Error("Load-test target must use HTTP or HTTPS.");
if (!["localhost", "127.0.0.1", "::1"].includes(target.hostname) && process.env.LOAD_TEST_ALLOW_REMOTE !== "1") {
  throw new Error("Remote load targets require explicit LOAD_TEST_ALLOW_REMOTE=1.");
}

const endpoint = new URL(`/reports/daily-state?date=${encodeURIComponent(date)}`, target);
const headers = { authorization: `Bearer ${token}`, "x-client-id": clientId, accept: "application/json" };
async function once() {
  const start = performance.now();
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const elapsed = performance.now() - start;
    if (response.status !== 200) return { status: response.status, ms: elapsed, bytes: Buffer.byteLength(text), error: `Expected HTTP 200, received ${response.status}` };
    if (!contentType.toLowerCase().includes("application/json")) return { status: response.status, ms: elapsed, bytes: Buffer.byteLength(text), error: `Expected JSON response, received ${contentType || "no content type"}` };
    let body;
    try { body = JSON.parse(text); } catch { return { status: response.status, ms: elapsed, bytes: Buffer.byteLength(text), error: "Response body was not valid JSON" }; }
    if (body.clientId !== clientId || body.businessDate !== date || !Array.isArray(body.stations)) {
      return { status: response.status, ms: elapsed, bytes: Buffer.byteLength(text), error: "Report payload did not match the requested client/date or station-list schema" };
    }
    return { status: response.status, ms: elapsed, bytes: Buffer.byteLength(text), stationCount: body.stations.length };
  } catch (error) {
    return { status: 0, ms: performance.now() - start, bytes: 0, error: error instanceof Error ? error.message : "Request failed" };
  }
}

for (let i = 0; i < 3; i++) {
  const warm = await once();
  if (warm.error) throw new Error(`Warm-up request failed: ${warm.error}; check the token and client access.`);
}

const samples = [];
let cursor = 0;
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < requests) {
    const index = cursor++;
    samples[index] = await once();
  }
}));
const elapsed = performance.now() - started;
const failures = samples.filter(sample => sample.error);
const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
console.log(JSON.stringify({
  endpoint: `${target.origin}/reports/daily-state`, businessDate: date,
  requests, concurrency, timeoutMs, stationCount: samples.find(sample => !sample.error)?.stationCount ?? 0,
  responseBytes: samples.length ? Number((samples.reduce((sum, sample) => sum + sample.bytes, 0) / samples.length).toFixed(0)) : 0,
  failures: failures.length,
  latencyMs: { min: Number(sorted[0].toFixed(1)), mean: Number(mean.toFixed(1)), p50: Number(percentile(0.5).toFixed(1)), p95: Number(percentile(0.95).toFixed(1)), max: Number(sorted.at(-1).toFixed(1)) },
  requestsPerSecond: Number((requests / (elapsed / 1000)).toFixed(2)),
  failedStatuses: [...new Set(failures.map(sample => sample.status))],
  failureExamples: failures.slice(0, 10).map(({status,error})=>({status,error})),
}, null, 2));
if (failures.length) process.exitCode = 1;
