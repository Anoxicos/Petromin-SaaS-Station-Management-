import assert from "node:assert/strict";

const appOrigin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const metricsOrigin = process.env.METRICS_ORIGIN ?? "http://127.0.0.1:9464";

const health = await fetch(`${appOrigin}/health`);
assert.equal(health.status, 200, "app health route must respond before the scrape");
const healthBody = await health.json();
assert.equal(healthBody.status, "ok");

const response = await fetch(`${metricsOrigin}/metrics`);
assert.equal(response.status, 200, "private metrics listener must expose the scrape endpoint");
assert.match(response.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/);
const metrics = await response.text();
assert.match(metrics, /# TYPE station_platform_http_requests_total counter/);
assert.match(metrics, /# TYPE station_platform_http_request_duration_seconds histogram/);
assert.match(metrics, /station_platform_http_requests_total\{method="GET",route="health",status_class="2xx"\} [1-9]\d*/);
assert.match(metrics, /station_platform_process_resident_memory_bytes \d+/);
assert.match(metrics, /station_platform_db_pool_connections\{state="total"\} \d+/);
assert.doesNotMatch(metrics, /\/health|clientId|client_id|userId|requestId|@/i);
for (const match of metrics.matchAll(/route="([^"]+)"/g)) {
  assert.ok([
    "health", "ui", "identity", "reports", "platform", "imports", "station_operations",
    "finance", "client_operations", "other",
  ].includes(match[1]), `route metric label must remain bounded: ${match[1]}`);
}

const unsupportedPath = await fetch(`${metricsOrigin}/internal`);
assert.equal(unsupportedPath.status, 404, "metrics listener must not serve other app routes");
console.log("PASS private bounded metrics, request counters/latency, process/database gauges, and path rejection");
