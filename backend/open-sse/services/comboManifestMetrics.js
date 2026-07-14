import { getLogger } from "log-wrapper";
function recordComboIntentWithSpecificity(comboName, specificityScore, specificityLevel, strategyModifier) {
  getLogger().info(
    { comboName, specificityScore, specificityLevel, strategyModifier },
    "combo manifest routing applied"
  );
}
export {
  recordComboIntentWithSpecificity
};
