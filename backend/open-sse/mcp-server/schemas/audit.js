async function hashInput(input) {
  const data = JSON.stringify(input);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
function summarizeOutput(output, maxLength = 200) {
  if (output === null || output === void 0) return "(null)";
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "\u2026";
}
export {
  hashInput,
  summarizeOutput
};
