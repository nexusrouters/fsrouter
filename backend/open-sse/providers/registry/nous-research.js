export default {
  id: "nous-research",
  priority: 100,
  alias: "nous",
  uiAlias: "nous",
  display: {
    name: "Nous Research",
    icon: "hub",
    color: "#2563EB",
    textIcon: "NO",
    website: "https://portal.nousresearch.com",
    notice: {
      text: "Free tier: 50 RPM, 500K TPM — no credit card.",
      apiKeyUrl: "https://portal.nousresearch.com",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  oauth: {
    clientId: "hermes-cli",
    deviceCodeUrl: "https://portal.nousresearch.com/api/oauth/device/code",
    tokenUrl: "https://portal.nousresearch.com/api/oauth/token",
    refreshUrl: "https://portal.nousresearch.com/api/oauth/token",
    scope: "inference:invoke",
    refreshLeadMs: 5 * 60 * 1000,
  },
  transport: {
    baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
    format: "openai",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "tencent/hy3:free", name: "Tencent: Hy3 (Free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1 (Free)" },
    { id: "stepfun/step-3.7-flash:free", name: "StepFun: Step 3.7 Flash (Free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Poolside: Laguna XS 2.1 (Free)" },
  ],
};