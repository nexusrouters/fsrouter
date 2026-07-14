const KNOWN_OFFENDING_FIELDS = [
  "reasoning_budget",
  "chat_template",
  "reasoning_content",
  "context_management"
];
function findOffendingField(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return null;
  for (const field of KNOWN_OFFENDING_FIELDS) {
    if (bodyText.includes(field)) return field;
  }
  return null;
}
function stripGroqUnsupportedFields(body) {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  delete next.logprobs;
  delete next.logit_bias;
  delete next.top_logprobs;
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((m) => {
      if (m && typeof m === "object" && "name" in m) {
        const { name: _name, ...rest } = m;
        return rest;
      }
      return m;
    });
  }
  return next;
}
export {
  KNOWN_OFFENDING_FIELDS,
  findOffendingField,
  stripGroqUnsupportedFields
};
