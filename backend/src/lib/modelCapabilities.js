/**
 * Stub: modelCapabilities — model capability detection.
 * TODO: Wire to actual model capability DB when available.
 */

export function getResolvedModelCapabilities(model) {
  return { supportsThinking: undefined, supportsToolCalling: undefined };
}

export function supportsReasoning(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return (
    m.includes('claude') ||
    m.includes('o1') || m.includes('o3') || m.includes('o4') ||
    m.includes('gemini') ||
    m.endsWith('-thinking') ||
    m.includes('thinking')
  );
}

export function supportsToolCalling(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return (
    m.includes('claude') ||
    m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4') ||
    m.includes('gemini') ||
    m.includes('mistral')
  );
}

export function capThinkingBudget(model, budget) {
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : 10240;
}

export function getDefaultThinkingBudget(model) {
  return 10240;
}

export function getModelContextLimit(provider, model) {
  return null;
}
