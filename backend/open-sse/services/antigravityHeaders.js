import { platform, arch } from "os";
import {
  ANTIGRAVITY_FALLBACK_VERSION,
  getCachedAntigravityVersion,
  resolveAntigravityVersion,
} from "./antigravityVersion.js";

const ANTIGRAVITY_VERSION = ANTIGRAVITY_FALLBACK_VERSION;
export const ANTIGRAVITY_CHROME_VERSION = "142.0.7444.175";
export const ANTIGRAVITY_ELECTRON_VERSION = "39.2.3";
export const ANTIGRAVITY_LOAD_CODE_ASSIST_USER_AGENT = `vscode/1.X.X (Antigravity/${ANTIGRAVITY_FALLBACK_VERSION})`;
export const ANTIGRAVITY_LOAD_CODE_ASSIST_API_CLIENT = "";
export const ANTIGRAVITY_NODE_API_CLIENT = "google-api-nodejs-client/10.3.0";
export const ANTIGRAVITY_CREDIT_PROBE_API_CLIENT = "gl-node/22.21.1";
export const ANTIGRAVITY_API_CLIENT = ANTIGRAVITY_CREDIT_PROBE_API_CLIENT;

function withOptionalBearerAuth(headers, accessToken) {
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function getAntigravityPlatformInfo(platformName = platform()) {
  switch (platformName) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    case "linux":
    default:
      return "X11; Linux x86_64";
  }
}

export function antigravityUserAgent(version = getCachedAntigravityVersion(), platformName = platform()) {
  return `Antigravity/${version} (${getAntigravityPlatformInfo(platformName)}) Chrome/${ANTIGRAVITY_CHROME_VERSION} Electron/${ANTIGRAVITY_ELECTRON_VERSION}`;
}

export async function resolveAntigravityUserAgent(platformName = platform()) {
  const version = await resolveAntigravityVersion();
  return antigravityUserAgent(version, platformName);
}

export function antigravityNativeOAuthUserAgent() {
  return `vscode/1.X.X (Antigravity/${getCachedAntigravityVersion()})`;
}

export function getAntigravityLoadCodeAssistMetadata() {
  return {
    ideType: "ANTIGRAVITY",
  };
}

export function getAntigravityLoadCodeAssistClientMetadata() {
  return JSON.stringify(getAntigravityLoadCodeAssistMetadata());
}

export function getAntigravityHeaders(profile, accessToken) {
  switch (profile) {
    case "loadCodeAssist":
      return withOptionalBearerAuth(
        {
          "Content-Type": "application/json",
          "User-Agent": antigravityNativeOAuthUserAgent(),
        },
        accessToken
      );
    case "fetchAvailableModels":
    case "models":
      return withOptionalBearerAuth(
        {
          "Content-Type": "application/json",
          "User-Agent": antigravityUserAgent(),
        },
        accessToken
      );
    default:
      return withOptionalBearerAuth({ "Content-Type": "application/json" }, accessToken);
  }
}

export function getAntigravityCreditProbeApiClientHeader() {
  return ANTIGRAVITY_CREDIT_PROBE_API_CLIENT;
}

export function getAntigravityApiClientHeader() {
  return ANTIGRAVITY_API_CLIENT;
}

export { ANTIGRAVITY_VERSION };
