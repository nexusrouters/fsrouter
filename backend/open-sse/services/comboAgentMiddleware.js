const CACHE_TAG_PATTERN = /<omniModel>([^<]+)<\/omniModel>/;
const CACHE_TAG_PATTERN_GLOBAL = /(?:\\n|\n|\r){0,16}<omniModel>([^<]+)<\/omniModel>(?:\\n|\n|\r){0,16}/g;
function injectModelTag(messages, providerModel) {
  const cleaned = messages.map((msg2) => {
    if (msg2.role === "assistant" && typeof msg2.content === "string") {
      return { ...msg2, content: msg2.content.replace(CACHE_TAG_PATTERN_GLOBAL, "").trimEnd() };
    }
    return msg2;
  });
  const lastAssistantIdx = cleaned.map((m) => m.role).lastIndexOf("assistant");
  if (lastAssistantIdx === -1) {
    return [...cleaned, { role: "assistant", content: `<omniModel>${providerModel}</omniModel>` }];
  }
  const msg = cleaned[lastAssistantIdx];
  if (typeof msg.content !== "string") {
    return [...cleaned, { role: "assistant", content: `<omniModel>${providerModel}</omniModel>` }];
  }
  const tagged = [...cleaned];
  tagged[lastAssistantIdx] = {
    ...msg,
    content: `${msg.content}<omniModel>${providerModel}</omniModel>`
  };
  return tagged;
}
function extractPinnedModel(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const match = CACHE_TAG_PATTERN.exec(msg.content);
      if (match) return match[1];
    }
  }
  return null;
}
function applySystemMessageOverride(messages, systemMessage) {
  const filtered = messages.filter((m) => m.role !== "system");
  return [{ role: "system", content: systemMessage }, ...filtered];
}
function applyToolFilter(tools, pattern) {
  if (!tools || !pattern) return tools;
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch {
    console.warn(`[ComboAgent] Invalid tool_filter_regex: "${pattern}"`);
    return tools;
  }
  return tools.filter((tool) => {
    const t = tool;
    const name = t.function?.name ?? t.name ?? "";
    return regex.test(String(name));
  });
}
function stripModelTags(messages) {
  return messages.map((msg) => {
    if (typeof msg.content === "string" && CACHE_TAG_PATTERN.test(msg.content)) {
      return { ...msg, content: msg.content.replace(CACHE_TAG_PATTERN_GLOBAL, "").trimEnd() };
    }
    return msg;
  });
}
function applyComboAgentMiddleware(body, comboConfig, providerModel) {
  if (!comboConfig) return { body, pinnedModel: null };
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let pinnedModel = null;
  pinnedModel = null;
  if (comboConfig.system_message && comboConfig.system_message.trim()) {
    messages = applySystemMessageOverride(messages, comboConfig.system_message);
  }
  const filteredTools = applyToolFilter(
    body.tools,
    comboConfig.tool_filter_regex
  );
  messages = stripModelTags(messages);
  return {
    body: {
      ...body,
      messages,
      ...filteredTools !== body.tools && { tools: filteredTools }
    },
    pinnedModel
  };
}
export {
  applyComboAgentMiddleware,
  applySystemMessageOverride,
  applyToolFilter,
  extractPinnedModel,
  injectModelTag,
  stripModelTags
};
