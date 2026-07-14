import { errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import { extractTextContent } from "../translator/helpers/geminiHelper.ts";
const FUSION_DEFAULTS = {
  minPanel: 2,
  // answers needed before stragglers get a grace window
  stragglerGraceMs: 8e3,
  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 9e4
  // absolute cap so one hung model can't stall forever
};
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";
  const j = json;
  const choices = j.choices;
  const choice = choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }
  const claudeText = extractTextContent(j.content);
  if (claudeText.trim()) return claudeText;
  const candidates = j.candidates;
  const parts = candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => typeof p?.text === "string" ? p.text : "").join("");
    if (t.trim()) return t;
  }
  const output = j.output;
  if (Array.isArray(output)) {
    const t = output.flatMap(
      (o) => Array.isArray(o.content) ? o.content.map(
        (c) => typeof c?.text === "string" ? c.text : ""
      ) : []
    ).join("");
    if (t.trim()) return t;
  }
  return "";
}
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [
      ...body.contents,
      { role: "user", parts: [{ text }] }
    ];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}
function buildJudgePrompt(answers) {
  const panel = answers.map((a, i) => `[Source ${i + 1}]
${a.text}`).join("\n\n");
  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on \u2014 treat as higher-confidence), contradictions (where they disagree \u2014 resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis \u2014 more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request."
  ].join("\n");
}
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise).then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      resolve({ __error: e });
    });
  });
}
function collectPanel(calls, cfg) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, cfg.panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p).then((v) => {
        out[i] = v;
      }).catch((e) => {
        out[i] = { __error: e };
      }).finally(() => {
        settled++;
        const slot = out[i];
        if (slot && slot.ok) ok++;
        if (settled === calls.length) return finish();
        if (ok >= cfg.minPanel && !graceTimer) {
          graceTimer = setTimeout(finish, cfg.stragglerGraceMs);
        }
      });
    });
  });
}
async function handleFusionChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  judgeModel,
  tuning
}) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return errorResponse(400, "Fusion combo has no models");
  }
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }
  const cfg = {
    minPanel: tuning?.minPanel ?? FUSION_DEFAULTS.minPanel,
    stragglerGraceMs: tuning?.stragglerGraceMs ?? FUSION_DEFAULTS.stragglerGraceMs,
    panelHardTimeoutMs: tuning?.panelHardTimeoutMs ?? FUSION_DEFAULTS.panelHardTimeoutMs
  };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info(
    "FUSION",
    `Combo "${comboName ?? ""}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`
  );
  const { tools: _tools, tool_choice: _tc, ...rest } = body;
  void _tools;
  void _tc;
  const panelBody = { ...rest, stream: false };
  const t0 = Date.now();
  const calls = panel.map(
    (m) => withTimeout(handleSingleModel(panelBody, m), cfg.panelHardTimeoutMs)
  );
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);
  const answers = [];
  const rateLimited = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) {
      log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`);
      continue;
    }
    const sentinel = res;
    if (sentinel.__timeout) {
      log.warn("FUSION", `Panel ${model} timed out`);
      continue;
    }
    if (sentinel.__error) {
      log.warn("FUSION", `Panel ${model} threw`, {
        error: sanitizeErrorMessage(sentinel.__error)
      });
      continue;
    }
    const resp = res;
    if (!resp.ok) {
      if (resp.status === 429) {
        rateLimited.push(model);
        log.warn("FUSION", `Panel ${model} rate-limited`, { status: resp.status });
      } else {
        log.warn("FUSION", `Panel ${model} failed`, { status: resp.status });
      }
      continue;
    }
    try {
      const json = await resp.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, {
        error: sanitizeErrorMessage(e)
      });
    }
  }
  if (answers.length === 0) {
    const detail = rateLimited.length > 0 ? `${rateLimited.length} models rate-limited, ${panel.length - rateLimited.length} failed` : `all ${panel.length} models failed`;
    log.warn("FUSION", `No live models: ${detail}`);
    return errorResponse(503, `All fusion panel models failed (${detail})`);
  }
  if (answers.length === 1) {
    log.info(
      "FUSION",
      `Only ${answers[0].model} succeeded \u2014 answering directly (no fusion)`
    );
    return handleSingleModel(body, answers[0].model);
  }
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
export {
  FUSION_DEFAULTS,
  appendUserTurn,
  buildJudgePrompt,
  collectPanel,
  extractPanelText,
  handleFusionChat
};
