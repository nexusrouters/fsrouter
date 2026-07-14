import { BaseExecutor } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
const GEMINI_URL = "https://gemini.google.com/app";
function isMissingBrowserExecutable(message) {
  if (!message) return false;
  return /executable doesn't exist|executablenotfound|playwright install|chromium.*download/i.test(
    message
  );
}
const GEMINI_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
function formatChatCompletion(content, model, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}
function formatStreamChunk(content, model, finishReason = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }]
  };
}
function parseCookies(raw) {
  return raw.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) return null;
    const name = part.substring(0, eqIdx).trim();
    const value = part.substring(eqIdx + 1).trim();
    if (!name || !value) return null;
    const lowerName = name.toLowerCase();
    if (["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
      lowerName
    )) {
      return null;
    }
    return { name, value };
  }).filter(Boolean);
}
function parseStreamResponse(raw) {
  const lines = raw.split("\n");
  const textChunks = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      const responseArray = inner?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c) => typeof c === "string").join("");
      if (text) textChunks.push(text);
    } catch {
    }
  }
  return textChunks.join("");
}
function readCredentialString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}
function readProviderSpecificString(providerSpecificData, keys) {
  if (!providerSpecificData || typeof providerSpecificData !== "object" || Array.isArray(providerSpecificData)) {
    return "";
  }
  const data = providerSpecificData;
  for (const key of keys) {
    const value = readCredentialString(data[key]);
    if (value) return value;
  }
  return "";
}
function normalizeGeminiCookieInput(raw, cookieName = "__Secure-1PSID") {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}
function resolveGeminiWebCookie(credentials) {
  const directCookie = readCredentialString(credentials?.apiKey) || readCredentialString(credentials?.cookie);
  if (directCookie) return normalizeGeminiCookieInput(directCookie);
  const providerSpecificData = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(providerSpecificData, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);
  const psid = readProviderSpecificString(providerSpecificData, ["__Secure-1PSID"]);
  const psidts = readProviderSpecificString(providerSpecificData, ["__Secure-1PSIDTS"]);
  return [
    psid ? normalizeGeminiCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeGeminiCookieInput(psidts, "__Secure-1PSIDTS") : ""
  ].filter(Boolean).join("; ");
}
class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }
  async execute(input) {
    const { model, body, stream, credentials, signal } = input;
    const requestBody = body;
    const cookie = resolveGeminiWebCookie(credentials);
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body
      };
    }
    const messages = requestBody.messages || [];
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    const prompt = lastUserMsg?.content || "";
    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body
      };
    }
    let browser = null;
    let abortBrowser = null;
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      abortBrowser = () => {
        void browser?.close().catch(() => {
        });
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });
      const context = await browser.newContext({ userAgent: GEMINI_USER_AGENT });
      const cookiePairs = parseCookies(cookie);
      await context.addCookies(
        cookiePairs.map(({ name, value }) => ({
          name,
          value,
          domain: ".google.com",
          path: "/",
          secure: true
        }))
      );
      const page = await context.newPage();
      let responseText = "";
      let captured = false;
      const responsePromise = new Promise((resolve) => {
        page.on("response", async (resp) => {
          if (captured || !resp.url().includes("StreamGenerate")) return;
          captured = true;
          try {
            const raw = await resp.text();
            responseText = parseStreamResponse(raw);
          } catch {
          }
          resolve();
        });
      });
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 2e4 });
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      await page.waitForTimeout(3e3);
      const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
        timeout: 1e4
      });
      await inputEl.click();
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await Promise.race([responsePromise, page.waitForTimeout(3e4)]);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" }
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body
        };
      }
      const modelId = model || "gemini-2.5-pro";
      if (stream) {
        const encoder = new TextEncoder();
        const readable = new ReadableStream(
          {
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}

`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}

`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          },
          { highWaterMark: 16384 }
        );
        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive"
            }
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body
        };
      }
      return {
        response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      if (isMissingBrowserExecutable(rawMessage)) {
        return {
          response: new Response(
            JSON.stringify({
              error: "Gemini Web requires the Playwright Chromium browser, which is not installed. Run `npx playwright install chromium` on the host (or rebuild the Docker image with browsers)."
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown"
              }
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage)
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body
      };
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      if (browser) {
        try {
          await browser.close();
        } catch {
        }
      }
    }
  }
}
export {
  GeminiWebExecutor,
  isMissingBrowserExecutable,
  parseStreamResponse
};
