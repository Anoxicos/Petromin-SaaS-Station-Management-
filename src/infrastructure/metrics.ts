import type { Pool } from "pg";

const httpBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const knownMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const processStartedAtSeconds = Date.now() / 1000;

type HttpAggregate = { count: number; sumSeconds: number; buckets: number[] };
const httpAggregates = new Map<string, HttpAggregate>();

export function recordHttpRequest(methodInput: string, route: string, statusCode: number, durationSeconds: number): void {
  const method = knownMethods.has(methodInput) ? methodInput : "OTHER";
  const statusClass = statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : "other";
  const key = `${method}|${route}|${statusClass}`;
  const aggregate = httpAggregates.get(key) ?? {
    count: 0,
    sumSeconds: 0,
    buckets: httpBuckets.map(() => 0),
  };
  aggregate.count += 1;
  aggregate.sumSeconds += durationSeconds;
  httpBuckets.forEach((bound, index) => {
    if (durationSeconds <= bound) aggregate.buckets[index] += 1;
  });
  httpAggregates.set(key, aggregate);
}

export function renderMetrics(databasePool: Pool): string {
  const lines = [
    "# HELP station_platform_http_requests_total Completed HTTP requests.",
    "# TYPE station_platform_http_requests_total counter",
    "# HELP station_platform_http_request_duration_seconds HTTP request duration in seconds.",
    "# TYPE station_platform_http_request_duration_seconds histogram",
  ];
  for (const [key, aggregate] of httpAggregates) {
    const [method, route, statusClass] = key.split("|");
    const labels = `method="${method}",route="${route}",status_class="${statusClass}"`;
    lines.push(`station_platform_http_requests_total{${labels}} ${aggregate.count}`);
    httpBuckets.forEach((bound, index) => {
      lines.push(`station_platform_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${aggregate.buckets[index]}`);
    });
    lines.push(`station_platform_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${aggregate.count}`);
    lines.push(`station_platform_http_request_duration_seconds_sum{${labels}} ${aggregate.sumSeconds}`);
    lines.push(`station_platform_http_request_duration_seconds_count{${labels}} ${aggregate.count}`);
  }

  const memory = process.memoryUsage();
  lines.push(
    "# HELP station_platform_process_uptime_seconds Process uptime in seconds.",
    "# TYPE station_platform_process_uptime_seconds gauge",
    `station_platform_process_uptime_seconds ${process.uptime()}`,
    "# HELP station_platform_process_start_time_seconds Process start time as Unix seconds.",
    "# TYPE station_platform_process_start_time_seconds gauge",
    `station_platform_process_start_time_seconds ${processStartedAtSeconds}`,
    "# HELP station_platform_process_resident_memory_bytes Resident memory in bytes.",
    "# TYPE station_platform_process_resident_memory_bytes gauge",
    `station_platform_process_resident_memory_bytes ${memory.rss}`,
    "# HELP station_platform_process_heap_used_bytes V8 heap used in bytes.",
    "# TYPE station_platform_process_heap_used_bytes gauge",
    `station_platform_process_heap_used_bytes ${memory.heapUsed}`,
    "# HELP station_platform_db_pool_connections Database pool connections by state.",
    "# TYPE station_platform_db_pool_connections gauge",
    `station_platform_db_pool_connections{state="total"} ${databasePool.totalCount}`,
    `station_platform_db_pool_connections{state="idle"} ${databasePool.idleCount}`,
    `station_platform_db_pool_connections{state="waiting"} ${databasePool.waitingCount}`,
  );
  return `${lines.join("\n")}\n`;
}
