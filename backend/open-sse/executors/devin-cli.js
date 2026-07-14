import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.ts";
function resolveDevinBin() {
  const envBin = process.env.CLI_DEVIN_BIN?.trim();
  if (envBin) return envBin;
  const isWin = process.platform === "win32";
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const winPath = path.join(localAppData, "devin", "cli", "bin", "devin.exe");
    if (fs.existsSync(winPath)) return winPath;
  }
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".local", "share", "devin", "bin", "devin"),
    path.join(home, ".devin", "bin", "devin")
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return isWin ? "devin.exe" : "devin";
}
function rpc(method, params, id) {
  const msg = { jsonrpc: "2.0", method, params };
  if (id !== void 0) msg.id = id;
  return JSON.stringify(msg) + "\n";
}
function buildPromptText(messages) {
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
class DevinCliExecutor extends BaseExecutor {
  constructor() {
    super("devin-cli", { id: "devin-cli", baseUrl: "" });
  }
  buildUrl() {
    return "devin://acp/stdio";
  }
  buildHeaders() {
    return {};
  }
  transformRequest() {
    return null;
  }
  async execute({ model, body, stream: _stream, credentials, signal, log }) {
    const b = body ?? {};
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const promptText = buildPromptText(messages);
    const apiKey = credentials.apiKey || credentials.accessToken || process.env.WINDSURF_API_KEY || "";
    const devinBin = resolveDevinBin();
    log?.info?.("DEVIN", `devin acp \u2192 model=${model}, bin=${devinBin}`);
    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const emit = (data) => controller.enqueue(enc.encode(data));
        const env = { ...process.env };
        if (apiKey) env.WINDSURF_API_KEY = apiKey;
        const child = spawn(devinBin, ["acp", "--agent-type", "summarizer"], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          // On Windows, devin.exe may need shell resolution
          shell: process.platform === "win32"
        });
        let spawnError = null;
        let stdinClosed = false;
        child.on("error", (err) => {
          spawnError = err;
          const msg = err.message.includes("ENOENT") || err.message.includes("not found") ? `Devin CLI not found: ${devinBin}. Install via https://cli.devin.ai or set CLI_DEVIN_BIN env var.` : `Devin CLI spawn error: ${err.message}`;
          emit(
            `data: ${JSON.stringify({ error: { message: msg, type: "devin_cli_error", code: "spawn_failed" } })}

`
          );
          emit("data: [DONE]\n\n");
          controller.close();
        });
        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
          });
        }
        let idCounter = 1;
        let sessionId = null;
        let initDone = false;
        let sessionCreated = false;
        let promptSent = false;
        let responseId = `chatcmpl-devin-${Date.now()}`;
        let created = Math.floor(Date.now() / 1e3);
        let roleEmitted = false;
        let totalText = "";
        let finished = false;
        const sendRpc = (method, params) => {
          if (stdinClosed || child.stdin.destroyed) return;
          const id = idCounter++;
          try {
            child.stdin.write(rpc(method, params, id));
          } catch {
          }
          return id;
        };
        const finish = (error) => {
          if (finished) return;
          finished = true;
          if (error) {
            emit(
              `data: ${JSON.stringify({ error: { message: error, type: "devin_cli_error" } })}

`
            );
          } else {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: Math.ceil(promptText.length / 4),
                  completion_tokens: Math.ceil(totalText.length / 4),
                  total_tokens: Math.ceil((promptText.length + totalText.length) / 4),
                  estimated: true
                }
              })}

`
            );
          }
          emit("data: [DONE]\n\n");
          try {
            if (!stdinClosed) {
              stdinClosed = true;
              child.stdin.end();
            }
          } catch {
          }
          const killTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2e3);
          killTimer.unref?.();
          controller.close();
        };
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (!initDone && msg.result !== void 0 && !msg.method) {
              initDone = true;
              sendRpc("session/new", {
                cwd: process.cwd(),
                model: model || void 0
              });
              continue;
            }
            if (initDone && !sessionCreated && msg.result !== void 0 && !msg.method) {
              const res = msg.result;
              sessionId = res?.sessionId || null;
              if (!sessionId) {
                finish("Devin ACP: session/new returned no sessionId");
                return;
              }
              sessionCreated = true;
              promptSent = true;
              sendRpc("session/prompt", {
                sessionId,
                content: [{ type: "text", text: promptText }]
              });
              continue;
            }
            if (sessionCreated && promptSent && msg.result !== void 0 && !msg.method) {
              continue;
            }
            if (msg.method === "session/update" || msg.method === "$/update") {
              const params = msg.params;
              if (!params) continue;
              const type = params.type;
              if (type === "message_delta" || type === "text_delta" || type === "content_delta") {
                const delta = params.content || params.delta || params.text || "";
                if (delta) {
                  if (!roleEmitted) {
                    emit(
                      `data: ${JSON.stringify({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created,
                        model,
                        choices: [
                          {
                            index: 0,
                            delta: { role: "assistant", content: "" },
                            finish_reason: null
                          }
                        ]
                      })}

`
                    );
                    roleEmitted = true;
                  }
                  totalText += delta;
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
                }
              } else if (type === "message_stop" || type === "stop" || type === "done") {
                finish();
                return;
              } else if (type === "error") {
                finish(String(params.message || params.error || "Devin ACP error"));
                return;
              }
              continue;
            }
            if (promptSent && msg.result !== void 0 && !msg.method && !finished) {
              const res = msg.result;
              if (!roleEmitted && res) {
                const content = extractResultText(res);
                if (content) {
                  emit(
                    `data: ${JSON.stringify({
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: { role: "assistant", content: "" },
                          finish_reason: null
                        }
                      ]
                    })}

`
                  );
                  totalText = content;
                  emit(
                    `data: ${JSON.stringify({
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [{ index: 0, delta: { content }, finish_reason: null }]
                    })}

`
                  );
                }
              }
              const stopReason = res?.stopReason || "";
              if (stopReason && stopReason !== "cancelled") {
                finish();
              }
            }
            if (msg.error) {
              finish(`Devin ACP error ${msg.error.code}: ${msg.error.message}`);
              return;
            }
          }
        });
        child.stderr.on("data", (chunk) => {
          log?.debug?.("DEVIN", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
        });
        child.on("close", (code) => {
          if (!finished) {
            if (code !== 0 && !spawnError) {
              finish(roleEmitted ? void 0 : `Devin CLI exited with code ${code}`);
            } else {
              finish();
            }
          }
        });
        sendRpc("initialize", {
          protocolVersion: "0.3",
          clientInfo: { name: "omniroute", version: "1.0" },
          capabilities: {}
        });
      }
    });
    return {
      response: new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      }),
      url: "devin://acp/stdio",
      headers: {},
      transformedBody: { model, promptLength: body?.messages }
    };
  }
}
function extractResultText(result) {
  if (typeof result.content === "string") return result.content;
  if (typeof result.text === "string") return result.text;
  const msg = result.message;
  if (msg && typeof msg.content === "string") return msg.content;
  const msgs = result.messages;
  if (Array.isArray(msgs)) {
    return msgs.filter((m) => m.role === "assistant").map((m) => String(m.content || "")).join("\n");
  }
  return "";
}
export {
  DevinCliExecutor
};
