import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import { auggieProvider } from "../config/providers/registry/auggie/index.ts";
const AUGGIE_URL = "auggie://cli/stdio";
const AUGGIE_MODEL_ALLOWLIST = new Set(auggieProvider.models.map((m) => m.id));
const DEFAULT_AUGGIE_MODEL = auggieProvider.models[0]?.id ?? "claude-sonnet-4.6";
function resolveAuggieModel(model) {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return { ok: true, model: DEFAULT_AUGGIE_MODEL };
  if (requested.startsWith("-")) {
    return {
      ok: false,
      error: `Invalid Auggie model "${requested}": model must not start with "-".`
    };
  }
  if (!AUGGIE_MODEL_ALLOWLIST.has(requested)) {
    return {
      ok: false,
      error: `Unknown Auggie model "${requested}". Supported models: ${[
        ...AUGGIE_MODEL_ALLOWLIST
      ].join(", ")}.`
    };
  }
  return { ok: true, model: requested };
}
function buildAuggieArgs(model) {
  return ["--print", "--quiet", "--model", model, "--"];
}
function resolveAuggieBin() {
  const envBin = (process.env.AUGGIE_BIN || process.env.CLI_AUGGIE_BIN || "").trim();
  if (envBin) return envBin;
  const isWin = process.platform === "win32";
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const winPath = path.join(localAppData, "auggie", "bin", "auggie.exe");
    if (fs.existsSync(winPath)) return winPath;
  }
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".local", "share", "auggie", "bin", "auggie"),
    path.join(home, ".auggie", "bin", "auggie")
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return isWin ? "auggie.cmd" : "auggie";
}
function buildAuggiePrompt(messages) {
  const lines = [];
  for (const m of messages) {
    const role = String(m.role || "user");
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p === "object" && p.type === "text") {
          text += String(p.text || "");
        }
      }
    }
    if (!text.trim()) continue;
    if (role === "system") {
      lines.push(`[System]
${text}`);
    } else if (role === "assistant") {
      lines.push(`[Assistant]
${text}`);
    } else {
      lines.push(`[User]
${text}`);
    }
  }
  return lines.join("\n\n") || "(empty)";
}
function isEnoentLike(message) {
  return message.includes("ENOENT") || message.includes("not found");
}
function checkAuggieCliVersion(timeoutMs = 5e3) {
  const bin = resolveAuggieBin();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(bin, ["--version"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      settle({ ok: false, error: isEnoentLike(message) ? cliNotFoundMessage(bin) : message });
      return;
    }
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      settle({ ok: false, error: "Auggie CLI version check timed out" });
    }, timeoutMs);
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const message = err?.message || String(err);
      settle({ ok: false, error: isEnoentLike(message) ? cliNotFoundMessage(bin) : message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        settle({ ok: true, version: stdout.trim().slice(0, 200) });
      } else {
        settle({ ok: false, error: `Auggie CLI exited with code ${code}` });
      }
    });
  });
}
function cliNotFoundMessage(bin) {
  return sanitizeErrorMessage(
    `Auggie CLI not found: ${bin}. Install it and run "auggie login", or set AUGGIE_BIN to an absolute path.`
  );
}
class AuggieExecutor extends BaseExecutor {
  constructor() {
    super("auggie", { id: "auggie", baseUrl: "" });
  }
  buildUrl() {
    return AUGGIE_URL;
  }
  buildHeaders() {
    return {};
  }
  transformRequest() {
    return null;
  }
  /** No-op — auggie has no OmniRoute-managed credentials to refresh. */
  async refreshCredentials(_credentials) {
    return null;
  }
  async execute({ model, body, stream, signal, log }) {
    const b = body ?? {};
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const promptText = buildAuggiePrompt(messages);
    const auggieBin = resolveAuggieBin();
    const wantsStream = stream !== false;
    const modelResolution = resolveAuggieModel(model);
    if (!modelResolution.ok) {
      const response2 = wantsStream ? buildAuggieSseError(modelResolution.error) : errorResponse(400, modelResolution.error);
      return { response: response2, url: AUGGIE_URL, headers: {}, transformedBody: { error: true } };
    }
    const safeModel = modelResolution.model;
    log?.info?.(
      "AUGGIE",
      `auggie --print \u2192 model=${safeModel}, bin=${auggieBin}, stream=${wantsStream}`
    );
    const response = wantsStream ? this.runStreaming(auggieBin, safeModel, promptText, signal, log) : await this.runNonStreaming(auggieBin, safeModel, promptText, signal, log);
    return {
      response,
      url: AUGGIE_URL,
      headers: {},
      transformedBody: { model: safeModel, promptLength: promptText.length }
    };
  }
  spawnAuggie(auggieBin, model, promptText) {
    const child = spawn(auggieBin, buildAuggieArgs(model), {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.on("error", () => {
    });
    try {
      child.stdin.write(promptText);
      child.stdin.end();
    } catch {
    }
    return child;
  }
  runStreaming(auggieBin, model, promptText, signal, log) {
    const responseId = `chatcmpl-auggie-${Date.now()}`;
    const created = Math.floor(Date.now() / 1e3);
    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const emit = (data) => controller.enqueue(enc.encode(data));
        let closed = false;
        let roleEmitted = false;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
            }
          }
        };
        const emitDelta = (delta) => {
          if (!delta) return;
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }
                ]
              })}

`
            );
            roleEmitted = true;
          }
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            })}

`
          );
        };
        const emitError = (message) => {
          emit(`data: ${JSON.stringify(buildErrorBody(502, message))}

`);
          emit("data: [DONE]\n\n");
          finish();
        };
        const emitStop = () => {
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}

`
          );
          emit("data: [DONE]\n\n");
          finish();
        };
        let child;
        try {
          child = spawn(auggieBin, buildAuggieArgs(model), {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"]
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitError(
            isEnoentLike(message) ? cliNotFoundMessage(auggieBin) : sanitizeErrorMessage(message)
          );
          return;
        }
        child.stdin.on("error", () => {
        });
        try {
          child.stdin.write(promptText);
          child.stdin.end();
        } catch {
        }
        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
            finish();
          });
        }
        child.on("error", (err) => {
          const message = err?.message || String(err);
          emitError(
            isEnoentLike(message) ? cliNotFoundMessage(auggieBin) : sanitizeErrorMessage(message)
          );
        });
        let stderrTail = "";
        child.stdout?.on("data", (chunk) => {
          emitDelta(chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk) => {
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2e3);
          log?.debug?.("AUGGIE", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
        });
        child.on("close", (code) => {
          if (finished) return;
          if (code !== 0) {
            emitError(
              sanitizeErrorMessage(
                `Auggie CLI exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`
              )
            );
            return;
          }
          emitStop();
        });
      },
      cancel() {
      }
    });
    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  }
  runNonStreaming(auggieBin, model, promptText, signal, log) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnAuggie(auggieBin, model, promptText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve(
          buildAuggieErrorResponse(
            isEnoentLike(message) ? cliNotFoundMessage(auggieBin) : sanitizeErrorMessage(message)
          )
        );
        return;
      }
      let stdout = "";
      let stderrTail = "";
      let settled = false;
      const settle = (response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      if (signal) {
        signal.addEventListener("abort", () => {
          if (!child.killed) child.kill("SIGTERM");
          settle(buildAuggieErrorResponse(sanitizeErrorMessage("Auggie CLI request aborted")));
        });
      }
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2e3);
        log?.debug?.("AUGGIE", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
      });
      child.on("error", (err) => {
        const message = err?.message || String(err);
        settle(
          buildAuggieErrorResponse(
            isEnoentLike(message) ? cliNotFoundMessage(auggieBin) : sanitizeErrorMessage(message)
          )
        );
      });
      child.on("close", (code) => {
        if (code !== 0) {
          settle(
            buildAuggieErrorResponse(
              sanitizeErrorMessage(
                `Auggie CLI exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`
              )
            )
          );
          return;
        }
        settle(buildChatCompletionResponse(model, promptText, stdout));
      });
    });
  }
}
function buildChatCompletionResponse(model, promptText, content) {
  const trimmed = content.trim();
  const body = {
    id: `chatcmpl-auggie-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: trimmed },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: Math.ceil(promptText.length / 4),
      completion_tokens: Math.ceil(trimmed.length / 4),
      total_tokens: Math.ceil((promptText.length + trimmed.length) / 4),
      estimated: true
    }
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
function buildAuggieErrorResponse(message) {
  return errorResponse(502, message);
}
function buildAuggieSseError(message) {
  const enc = new TextEncoder();
  const sseStream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify(buildErrorBody(400, message))}

`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(sseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}
export {
  AuggieExecutor,
  buildAuggiePrompt,
  checkAuggieCliVersion,
  resolveAuggieBin,
  resolveAuggieModel
};
