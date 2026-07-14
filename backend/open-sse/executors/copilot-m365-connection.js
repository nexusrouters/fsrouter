import { randomUUID, randomBytes } from "node:crypto";
const M365_INDIVIDUAL_DEFAULTS = {
  host: "substrate.office.com",
  source: "officeweb",
  product: "Office",
  agentHost: "Bizchat.FullScreen",
  licenseType: "Starter",
  agent: "web",
  scenario: "OfficeWebPaidConsumerCopilot"
};
const M365_EDU_OVERRIDES = {
  scenario: "OfficeWebIncludedCopilot",
  isEdu: "true",
  licenseType: "Starter"
};
const M365_ENTERPRISE_OVERRIDES = {
  agent: "work",
  scenario: "officeweb",
  licenseType: "Premium"
};
const M365_DEFAULT_VARIANTS = [
  "EnableMcpServerWidgets",
  "feature.EnableMcpServerWidgets",
  "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin",
  "EnableRequestPlugins",
  "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector",
  "feature.IsCustomEngineCopilotEnabled",
  "feature.bizchatfluxv3",
  "feature.enablechatpages",
  "feature.enableCodeCanvas",
  "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled",
  "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage",
  "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages",
  "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq",
  "feature.cwcfluxv3fe",
  "feature.cwcfluxv3fem",
  "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled",
  "feature.EnableCuaTakeControlApi",
  "SingletonEnvOn",
  "EnableComposeWidget",
  "feature.cwcallowedos",
  "feature.EnableMergingPureDeltas",
  "feature.disabledisallowedmsgs",
  "feature.enableCitationsForSynthesisData",
  "feature.EnableConversationShareApis",
  "feature.enableGenerateGraphicArtOptionsSet",
  "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableContentApiandDocTypeHtmlInRichAnswers",
  "cdxgrounding_api_v2_rich_web_answers_reference_bottom_force",
  "cdxenablerenderforisocomp",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot",
  "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor",
  "feature.EnableSkipRehydrationForSpeCIdImages",
  "feature.EnablePersonalizationForMSA",
  "agt_bizchat_enableRichResponses",
  "feature.EnableBase64DataInMessageAnnotations",
  "feature.EnableSkipEmittingMessageOnFlush",
  "feature.EnableRemoveEmptySourceAttributions",
  "feature.EnableRemoveStreamingMode"
];
function newChatSessionId() {
  return randomBytes(16).toString("hex");
}
function parsePastedCredential(raw) {
  const value = raw.trim();
  const parts = {};
  for (const segment of value.split(/[;\n]/)) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const key = segment.slice(0, separator).trim();
    const partValue = segment.slice(separator + 1).trim();
    if (key && partValue) parts[key] = partValue;
  }
  if (/^wss:\/\/substrate\.office\.com\/m365Copilot\/Chathub\//i.test(value)) {
    try {
      const url = new URL(value);
      parts.access_token ||= url.searchParams.get("access_token") || "";
      parts.chathubPath ||= decodeURIComponent(
        url.pathname.split("/m365Copilot/Chathub/")[1] || ""
      );
    } catch {
    }
  }
  return {
    accessToken: parts.access_token || parts.accessToken,
    chathubPath: parts.chathubPath || parts.userTenant
  };
}
function resolveConnectionParams(credentials) {
  const psd = credentials?.providerSpecificData ?? {};
  const parsedApiKey = typeof credentials?.apiKey === "string" ? parsePastedCredential(credentials.apiKey) : {};
  const accessToken = parsedApiKey.accessToken || typeof credentials?.apiKey === "string" && credentials.apiKey && !credentials.apiKey.includes("access_token=") && credentials.apiKey || typeof psd.accessToken === "string" && psd.accessToken || typeof psd.access_token === "string" && psd.access_token || "";
  if (!accessToken) {
    return { error: "Missing M365 Copilot access_token. Paste it as the provider credential." };
  }
  const chathubPath = parsedApiKey.chathubPath || typeof psd.chathubPath === "string" && psd.chathubPath || typeof psd.userTenant === "string" && psd.userTenant || "";
  if (!chathubPath || !chathubPath.includes("@")) {
    return {
      error: "Missing M365 Chathub path. Paste the '<user-oid>@<tenant-id>' segment from the WebSocket URL."
    };
  }
  const host = typeof psd.host === "string" && psd.host || M365_INDIVIDUAL_DEFAULTS.host;
  const variants = typeof psd.variants === "string" && psd.variants ? psd.variants : void 0;
  return { host, chathubPath, accessToken, variants, ...resolveTierOverrides(psd) };
}
function resolveTierOverrides(psd) {
  const tier = typeof psd.tier === "string" ? psd.tier.toLowerCase() : "";
  const isEduTier = tier === "edu" || tier === "included";
  const isEnterpriseTier = tier === "enterprise" || tier === "work";
  const psdIsEdu = typeof psd.isEdu === "string" && psd.isEdu || typeof psd.isEdu === "boolean" && String(psd.isEdu) || void 0;
  return {
    scenario: typeof psd.scenario === "string" && psd.scenario || (isEduTier ? M365_EDU_OVERRIDES.scenario : void 0) || (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.scenario : void 0),
    isEdu: psdIsEdu || (isEduTier ? M365_EDU_OVERRIDES.isEdu : void 0),
    licenseType: typeof psd.licenseType === "string" && psd.licenseType || (isEduTier ? M365_EDU_OVERRIDES.licenseType : void 0) || (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.licenseType : void 0),
    agent: typeof psd.agent === "string" && psd.agent || (isEnterpriseTier ? M365_ENTERPRISE_OVERRIDES.agent : void 0)
  };
}
function buildWsUrl(params) {
  const sessionKey = newChatSessionId();
  const query = new URLSearchParams({
    chatsessionid: sessionKey,
    XRoutingParameterSessionKey: sessionKey,
    clientrequestid: sessionKey,
    "X-SessionId": randomUUID(),
    ConversationId: randomUUID(),
    access_token: params.accessToken,
    variants: params.variants ?? M365_DEFAULT_VARIANTS.join(","),
    source: M365_INDIVIDUAL_DEFAULTS.source,
    product: M365_INDIVIDUAL_DEFAULTS.product,
    agentHost: M365_INDIVIDUAL_DEFAULTS.agentHost,
    licenseType: params.licenseType ?? M365_INDIVIDUAL_DEFAULTS.licenseType,
    isEdu: params.isEdu ?? "false",
    agent: params.agent ?? M365_INDIVIDUAL_DEFAULTS.agent,
    scenario: params.scenario ?? M365_INDIVIDUAL_DEFAULTS.scenario
  });
  return `wss://${params.host}/m365Copilot/Chathub/${params.chathubPath}?${query.toString()}`;
}
function redactWsUrl(wsUrl) {
  return wsUrl.replace(/access_token=[^&]*/i, "access_token=REDACTED");
}
function buildPrompt(body) {
  const messages = body?.messages || [];
  const systemMsgs = messages.filter((m) => m.role === "system");
  const userMsg = messages.filter((m) => m.role === "user").pop();
  const userText = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content ?? "");
  let prompt = "";
  if (systemMsgs.length > 0) {
    const sysText = systemMsgs.map((m) => typeof m.content === "string" ? m.content : "").filter(Boolean).join("\n");
    if (sysText) prompt += `[System Instructions]
${sysText}

`;
  }
  prompt += userText;
  return prompt;
}
export {
  M365_DEFAULT_VARIANTS,
  M365_EDU_OVERRIDES,
  M365_ENTERPRISE_OVERRIDES,
  M365_INDIVIDUAL_DEFAULTS,
  buildPrompt,
  buildWsUrl,
  newChatSessionId,
  redactWsUrl,
  resolveConnectionParams
};
