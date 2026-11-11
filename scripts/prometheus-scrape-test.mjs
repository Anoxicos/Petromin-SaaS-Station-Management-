import assert from "node:assert/strict";

const appOrigin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const prometheusOrigin = process.env.PROMETHEUS_ORIGIN ?? "http://prometheus:9090";
const deadline = Date.now() + 45_000;
let lastError;

const health = await fetch(`${appOrigin}/health`);
assert.equal(health.status, 200, "the station app must be healthy before scrape verification");

async function query(expression) {
  const url = new URL("/api/v1/query", prometheusOrigin);
  url.searchParams.set("query", expression);
  const response = await fetch(url);
  assert.equal(response.status, 200, "Prometheus query API must respond");
  const payload = await response.json();
  assert.equal(payload.status, "success");
  return payload.data.result;
}

while (Date.now() < deadline) {
  try {
    const target = await query('up{job="station-platform-app"}');
    const processMetric = await query('station_platform_process_uptime_seconds{job="station-platform-app"}');
    if (target.length === 1 && target[0].value[1] === "1" && processMetric.length === 1) {
      assert.equal(target[0].metric.instance, "app:9464");
      console.log("PASS Prometheus scraped the private app target and stored process metrics");
      process.exit(0);
    }
  } catch (error) {
    lastError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

assert.fail(`Prometheus did not scrape station-platform-app within 45 seconds: ${lastError instanceof Error ? lastError.message : "target remained absent or down"}`);
