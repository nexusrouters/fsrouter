/**
 * Paleo Token Saver — inject system prompt to minimize output tokens.
 * Inspired by github.com/mocasus/paleo
 * 
 * Levels:
 *   lite   — gentle hints to be concise
 *   full   — strong compression instructions
 *   ultra  — extreme telegraphic, max savings
 */

import { injectSystemPrompt } from "./systemInject.js";

const PALEO_PROMPTS = {
  lite: [
    "Be concise. Skip filler phrases, unnecessary preambles, and redundant explanations. Get to the point directly.",
    "Do not repeat information already provided. Use minimal words to convey maximum meaning.",
  ].join("\n"),

  full: [
    "You are in token-saving mode. Follow these rules strictly:",
    "- NO filler: skip 'Certainly', 'Sure', 'Here is', 'Let me', 'I will', preamble, disclaimers.",
    "- NO repetition: never restate what the user said or what you already said.",
    "- Compress: use fragments, abbreviations, and terse phrasing when clarity permits.",
    "- Code: output ONLY the changed lines with minimal context. No full-file rewrites unless asked.",
    "- Lists: use short bullets, not full sentences.",
    "- If the answer is a single value, output ONLY that value.",
    "- Arrow causality for reasoning: X → Y → Z, not 'Because X, therefore Y, which leads to Z'.",
  ].join("\n"),

  ultra: [
    "TOKEN-SAVING ULTRA MODE. Rules enforced:",
    "- Absolute minimum output. Every token costs money.",
    "- Fragments OK. Articles/determiners optional (a, the, this).",
    "- No greeting, no sign-off, no filler, no hedging.",
    "- Code: diffs/patches only. No explanations unless asked.",
    "- Data: raw values, no wrapping prose.",
    "- If yes/no suffices, output only yes/no.",
    "- Chain reasoning: A→B→C. No connective tissue.",
    "- Max 50% of what you'd normally output. Prefer shorter.",
  ].join("\n"),
};

export function injectPaleo(body, format, level) {
  const prompt = PALEO_PROMPTS[level];
  if (!prompt) return;
  injectSystemPrompt(body, format, prompt);
}
