import { errorResponse } from "../../utils/error.ts";
function buildTargetTimeoutRunner(deps) {
  const { handleSingleModel, comboTargetTimeoutMs, log } = deps;
  return async (b, modelStr, target) => {
    if (comboTargetTimeoutMs <= 0) {
      return handleSingleModel(b, modelStr, target).catch(
        (err) => errorResponse(502, err?.message ?? "Upstream model error")
      );
    }
    const timeoutController = new AbortController();
    let timeoutId;
    let timedOut = false;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        log.warn(
          "COMBO",
          `Model ${modelStr} exceeded ${comboTargetTimeoutMs}ms timeout \u2014 falling back`
        );
        timeoutController.abort(new Error("combo-per-model-timeout"));
        resolve(
          new Response(JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }), {
            status: 524,
            headers: { "Content-Type": "application/json" }
          })
        );
      }, comboTargetTimeoutMs);
    });
    const targetWithSignal = {
      ...target ?? {},
      modelAbortSignal: timeoutController.signal
    };
    const parentHedgeSignal = target?.modelAbortSignal ?? null;
    let onParentHedgeAbort = null;
    if (parentHedgeSignal) {
      if (parentHedgeSignal.aborted) {
        timeoutController.abort(new Error("hedge-cancelled"));
      } else {
        onParentHedgeAbort = () => {
          timeoutController.abort(new Error("hedge-cancelled"));
        };
        parentHedgeSignal.addEventListener("abort", onParentHedgeAbort, { once: true });
      }
    }
    try {
      return await Promise.race([
        handleSingleModel(b, modelStr, targetWithSignal).catch((err) => {
          if (timedOut) {
            return new Response(null, { status: 599 });
          }
          return errorResponse(502, err?.message ?? "Upstream model error");
        }),
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timeoutId);
      if (parentHedgeSignal && onParentHedgeAbort) {
        parentHedgeSignal.removeEventListener("abort", onParentHedgeAbort);
      }
    }
  };
}
export {
  buildTargetTimeoutRunner
};
