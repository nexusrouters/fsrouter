import v8 from "node:v8";
function computeHeapPressureThresholdMb(heapSizeLimitMb, override) {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const SHED_RATIO = 0.85;
  const FLOOR_MB = 400;
  return Math.max(Math.round(heapSizeLimitMb * SHED_RATIO), FLOOR_MB);
}
const HEAP_PRESSURE_THRESHOLD_MB = computeHeapPressureThresholdMb(
  v8.getHeapStatistics().heap_size_limit / (1024 * 1024),
  process.env.HEAP_PRESSURE_THRESHOLD_MB
);
const HEAP_PRESSURE_MESSAGE = "Service temporarily unavailable due to resource pressure. Retry shortly.";
function checkHeapPressureGuard(heapUsedMb, thresholdMb = HEAP_PRESSURE_THRESHOLD_MB) {
  if (heapUsedMb <= thresholdMb) return null;
  console.warn(
    `[chatCore] heap pressure guard tripped: ${Math.round(heapUsedMb)}MB > ${thresholdMb}MB; returning 503`
  );
  return {
    success: false,
    status: 503,
    error: HEAP_PRESSURE_MESSAGE,
    response: new Response(
      JSON.stringify({
        error: { message: HEAP_PRESSURE_MESSAGE, type: "server_error", code: "heap_pressure" }
      }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } }
    )
  };
}
export {
  HEAP_PRESSURE_THRESHOLD_MB,
  checkHeapPressureGuard,
  computeHeapPressureThresholdMb
};
