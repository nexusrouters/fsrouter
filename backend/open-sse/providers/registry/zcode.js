export default {
  id: "zcode",
  priority: 145,
  alias: "zcode",
  uiAlias: "zcode",
  display: {
    name: "ZCode (Z.ai)",
    icon: "code",
    color: "#4F46E5",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "ZCode OAuth via Z.ai",
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    authorizeUrl: "https://chat.z.ai/auth",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
    refreshUrl: "https://zcode.z.ai/api/v1/oauth/token",
    redirectUri: "https://zcode.z.ai/app/oauth/login?redirect=zcode%3A%2F%2Foauth%2Fcallback",
    userinfoUrl: "https://zcode.z.ai/api/biz/customer/getCustomerInfo",
    scope: "openid profile email",
  },
  transport: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: {
      "anthropic-version": "2023-06-01",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: ["zcodeHeaders"],
    },
    usage: {
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
    },
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["zcodeHeaders"] },
    },
    {
      format: "claude",
      baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
      urlSuffix: "?beta=true",
      headers: {
        "anthropic-version": "2023-06-01",
      },
      auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["zcodeHeaders"] },
    },
  ],
  models: [
    { id: "GLM-5.2", name: "GLM 5.2" },
    { id: "GLM-5.1", name: "GLM 5.1" },
    { id: "GLM-5-Turbo", name: "GLM 5 Turbo" },
    { id: "glm-5.2", name: "GLM 5.2 (lower)" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo (lower)" },
  ],
};
