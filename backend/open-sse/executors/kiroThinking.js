function splitInlineThinking(state, raw, onContent, onReasoning) {
  let text = (state.pendingTag || "") + (raw || "");
  state.pendingTag = "";
  const PARTIAL_MAX = 11;
  while (text.length > 0) {
    const target = state.thinkingMode ? "</thinking>" : "<thinking>";
    const idx = text.indexOf(target);
    if (idx === -1) {
      let holdFrom = text.length;
      for (let i = Math.max(0, text.length - PARTIAL_MAX); i < text.length; i++) {
        const tail = text.slice(i);
        if (target.startsWith(tail) && tail.length > 0) {
          holdFrom = i;
          break;
        }
      }
      const flushable = text.slice(0, holdFrom);
      if (flushable) {
        if (state.thinkingMode) onReasoning(flushable);
        else onContent(flushable);
      }
      state.pendingTag = text.slice(holdFrom);
      return;
    }
    const before = text.slice(0, idx);
    if (before) {
      if (state.thinkingMode) onReasoning(before);
      else onContent(before);
    }
    state.thinkingMode = !state.thinkingMode;
    text = text.slice(idx + target.length);
  }
}
function flushPendingThinking(state, onContent, onReasoning) {
  if (!state.pendingTag) return;
  const leftover = state.pendingTag;
  state.pendingTag = "";
  if (state.thinkingMode) onReasoning(leftover);
  else onContent(leftover);
}
export {
  flushPendingThinking,
  splitInlineThinking
};
