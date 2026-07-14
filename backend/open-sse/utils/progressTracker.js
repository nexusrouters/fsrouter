const DEFAULT_INTERVAL_MS = 2e3;
function createProgressTransform({
  intervalMs = DEFAULT_INTERVAL_MS,
  signal
} = {}) {
  let tokenCount = 0;
  let startTime = Date.now();
  let intervalId;
  let writer;
  const encoder = new TextEncoder();
  return new TransformStream(
    {
      start(controller) {
        writer = controller;
        startTime = Date.now();
        intervalId = setInterval(() => {
          if (signal?.aborted) {
            clearInterval(intervalId);
            return;
          }
          const progressEvent = `event: progress
data: ${JSON.stringify({
            tokens_generated: tokenCount,
            elapsed_ms: Date.now() - startTime
          })}

`;
          try {
            controller.enqueue(encoder.encode(progressEvent));
          } catch {
            clearInterval(intervalId);
          }
        }, intervalMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearInterval(intervalId);
          },
          { once: true }
        );
      },
      transform(chunk, controller) {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
        tokenCount += dataLines.length;
        controller.enqueue(chunk);
      },
      flush() {
        clearInterval(intervalId);
        if (writer) {
          try {
            const finalEvent = `event: progress
data: ${JSON.stringify({
              tokens_generated: tokenCount,
              elapsed_ms: Date.now() - startTime,
              done: true
            })}

`;
            writer.enqueue(encoder.encode(finalEvent));
          } catch {
          }
        }
      },
      cancel() {
        clearInterval(intervalId);
      }
    },
    { highWaterMark: 16384 },
    { highWaterMark: 16384 }
  );
}
function wantsProgress(headers) {
  if (!headers) return false;
  const get = typeof headers.get === "function" ? (k) => headers.get(k) : (k) => headers[k];
  return get("x-omniroute-progress") === "true";
}
export {
  createProgressTransform,
  wantsProgress
};
