import { antigravityUserAgent } from "../services/antigravityHeaders.ts";
const GITHUB_COPILOT_API_VERSION = "2026-06-01";
const GITHUB_COPILOT_EDITOR_VERSION = "vscode/1.126.0";
const GITHUB_COPILOT_CHAT_PLUGIN_VERSION = "copilot-chat/0.54.0";
const GITHUB_COPILOT_CHAT_USER_AGENT = "GitHubCopilotChat/0.54.0";
const GITHUB_COPILOT_REFRESH_PLUGIN_VERSION = "copilot/1.388.0";
const GITHUB_COPILOT_REFRESH_USER_AGENT = "GithubCopilot/1.0";
const GITHUB_COPILOT_INTEGRATION_ID = "vscode-chat";
const GITHUB_COPILOT_OPENAI_INTENT = "conversation-panel";
const GITHUB_COPILOT_DEFAULT_INITIATOR = "user";
const GITHUB_COPILOT_USER_AGENT_LIBRARY = "electron-fetch";
const QWEN_CLI_VERSION = "0.19.3";
const QWEN_STAINLESS_LANG = "js";
const QWEN_STAINLESS_PACKAGE_VERSION = "5.11.0";
const QWEN_STAINLESS_RETRY_COUNT = "1";
const QWEN_STAINLESS_RUNTIME = "node";
const QWEN_ACCEPT_LANGUAGE = "*";
const QWEN_SEC_FETCH_MODE = "cors";
const QODER_DEFAULT_USER_AGENT = "Qoder-Cli";
const KIRO_SDK_USER_AGENT = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0";
const KIRO_AMZ_USER_AGENT = "aws-sdk-js/3.0.0 kiro-ide/1.0.0";
const KIRO_STREAMING_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const CURSOR_REGISTRY_VERSION = "3.9";
function getGitHubCopilotChatHeaders(accept = "application/json", initiator = GITHUB_COPILOT_DEFAULT_INITIATOR) {
  return {
    "copilot-integration-id": GITHUB_COPILOT_INTEGRATION_ID,
    "editor-version": GITHUB_COPILOT_EDITOR_VERSION,
    "editor-plugin-version": GITHUB_COPILOT_CHAT_PLUGIN_VERSION,
    "user-agent": GITHUB_COPILOT_CHAT_USER_AGENT,
    "openai-intent": GITHUB_COPILOT_OPENAI_INTENT,
    "x-github-api-version": GITHUB_COPILOT_API_VERSION,
    "x-vscode-user-agent-library-version": GITHUB_COPILOT_USER_AGENT_LIBRARY,
    "X-Initiator": initiator,
    Accept: accept,
    "Content-Type": "application/json"
  };
}
function getRuntimePlatform() {
  return typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "unknown";
}
function getRuntimeArch() {
  return typeof process !== "undefined" && typeof process.arch === "string" ? process.arch : "unknown";
}
function getRuntimeVersion() {
  return typeof process !== "undefined" && typeof process.version === "string" ? process.version : "unknown";
}
function normalizeStainlessPlatform(platform = getRuntimePlatform()) {
  const normalized = platform.toLowerCase();
  if (normalized.includes("ios")) return "iOS";
  if (normalized === "android") return "Android";
  if (normalized === "darwin") return "MacOS";
  if (normalized === "win32") return "Windows";
  if (normalized === "freebsd") return "FreeBSD";
  if (normalized === "openbsd") return "OpenBSD";
  if (normalized === "linux") return "Linux";
  return normalized ? `Other:${normalized}` : "Unknown";
}
function normalizeStainlessArch(arch = getRuntimeArch()) {
  if (arch === "x32") return "x32";
  if (arch === "x86_64" || arch === "x64") return "x64";
  if (arch === "arm") return "arm";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return arch ? `other:${arch}` : "unknown";
}
function getQwenCliUserAgent(version = QWEN_CLI_VERSION) {
  return `QwenCode/${version} (${getRuntimePlatform()}; ${getRuntimeArch()})`;
}
function getGitHubCopilotInternalUserHeaders(authorization) {
  return {
    Authorization: authorization,
    Accept: "application/json",
    "X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
    "User-Agent": GITHUB_COPILOT_CHAT_USER_AGENT,
    "Editor-Version": GITHUB_COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": GITHUB_COPILOT_CHAT_PLUGIN_VERSION
  };
}
function getGitHubCopilotRefreshHeaders(authorization) {
  return {
    Authorization: authorization,
    Accept: "application/json",
    "User-Agent": GITHUB_COPILOT_REFRESH_USER_AGENT,
    "Editor-Version": GITHUB_COPILOT_EDITOR_VERSION,
    "Editor-Plugin-Version": GITHUB_COPILOT_REFRESH_PLUGIN_VERSION
  };
}
function getQwenOauthHeaders() {
  const userAgent = getQwenCliUserAgent();
  return {
    "User-Agent": userAgent,
    "X-Dashscope-AuthType": "qwen-oauth",
    "X-Dashscope-CacheControl": "enable",
    "X-Dashscope-UserAgent": userAgent,
    "X-Stainless-Arch": normalizeStainlessArch(),
    "X-Stainless-Lang": QWEN_STAINLESS_LANG,
    "X-Stainless-Os": normalizeStainlessPlatform(),
    "X-Stainless-Package-Version": QWEN_STAINLESS_PACKAGE_VERSION,
    "X-Stainless-Retry-Count": QWEN_STAINLESS_RETRY_COUNT,
    "X-Stainless-Runtime": QWEN_STAINLESS_RUNTIME,
    "X-Stainless-Runtime-Version": getRuntimeVersion(),
    Connection: "keep-alive",
    "Accept-Language": QWEN_ACCEPT_LANGUAGE,
    "Sec-Fetch-Mode": QWEN_SEC_FETCH_MODE
  };
}
function getQoderDefaultHeaders() {
  return {
    "User-Agent": QODER_DEFAULT_USER_AGENT
  };
}
function getQoderDashscopeCompatHeaders() {
  const userAgent = getQwenCliUserAgent();
  return {
    "x-dashscope-authtype": "qwen-oauth",
    "x-dashscope-cachecontrol": "enable",
    "user-agent": userAgent,
    "x-dashscope-useragent": userAgent,
    "x-stainless-arch": normalizeStainlessArch(),
    "x-stainless-lang": QWEN_STAINLESS_LANG,
    "x-stainless-os": normalizeStainlessPlatform()
  };
}
function getAntigravityUserAgent() {
  return antigravityUserAgent();
}
function getAntigravityProviderHeaders() {
  return {
    "User-Agent": getAntigravityUserAgent()
  };
}
function getKiroServiceHeaders(accept = "application/vnd.amazon.eventstream") {
  return {
    "Content-Type": "application/json",
    Accept: accept,
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_AMZ_USER_AGENT
  };
}
function getCursorUserAgent(version) {
  return `Cursor/${version}`;
}
function getCursorRegistryHeaders(version = CURSOR_REGISTRY_VERSION) {
  return {
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": getCursorUserAgent(version)
  };
}
export {
  CURSOR_REGISTRY_VERSION,
  GITHUB_COPILOT_API_VERSION,
  GITHUB_COPILOT_CHAT_PLUGIN_VERSION,
  GITHUB_COPILOT_CHAT_USER_AGENT,
  GITHUB_COPILOT_DEFAULT_INITIATOR,
  GITHUB_COPILOT_EDITOR_VERSION,
  GITHUB_COPILOT_INTEGRATION_ID,
  GITHUB_COPILOT_OPENAI_INTENT,
  GITHUB_COPILOT_REFRESH_PLUGIN_VERSION,
  GITHUB_COPILOT_REFRESH_USER_AGENT,
  GITHUB_COPILOT_USER_AGENT_LIBRARY,
  KIRO_AMZ_USER_AGENT,
  KIRO_SDK_USER_AGENT,
  KIRO_STREAMING_TARGET,
  QODER_DEFAULT_USER_AGENT,
  QWEN_ACCEPT_LANGUAGE,
  QWEN_CLI_VERSION,
  QWEN_SEC_FETCH_MODE,
  QWEN_STAINLESS_LANG,
  QWEN_STAINLESS_PACKAGE_VERSION,
  QWEN_STAINLESS_RETRY_COUNT,
  QWEN_STAINLESS_RUNTIME,
  getAntigravityProviderHeaders,
  getAntigravityUserAgent,
  getCursorRegistryHeaders,
  getCursorUserAgent,
  getGitHubCopilotChatHeaders,
  getGitHubCopilotInternalUserHeaders,
  getGitHubCopilotRefreshHeaders,
  getKiroServiceHeaders,
  getQoderDashscopeCompatHeaders,
  getQoderDefaultHeaders,
  getQwenCliUserAgent,
  getQwenOauthHeaders,
  getRuntimeArch,
  getRuntimePlatform,
  getRuntimeVersion,
  normalizeStainlessArch,
  normalizeStainlessPlatform
};
