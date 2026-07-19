import { getProviderConnections } from "./backend/src/lib/localDb.js";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "./backend/src/shared/constants/providers.js";

function isUsageEligible(connection) {
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) && (
    connection.authType === "oauth" ||
    connection.authType === "cookie" ||
    USAGE_APIKEY_PROVIDERS.includes(connection.provider)
  );
}

async function test() {
  const allConnections = await getProviderConnections();
  const eligibleConnections = allConnections.filter(isUsageEligible);
  console.log("Total Connections:", allConnections.length);
  console.log("Eligible Connections:", eligibleConnections.length);
  
  const providerFilteredConnections = eligibleConnections.filter(c => true);
  const accountFilteredConnections = providerFilteredConnections.filter(c => true);
  
  console.log("accountFilteredConnections count:", accountFilteredConnections.length);
  console.log("First 3 Eligible Providers:", eligibleConnections.slice(0, 3).map(c => c.provider));
  
  const grok = allConnections.find(c => c.provider === "grok-cli");
  console.log("Grok CLI connection:", grok ? grok.provider : "Not found", grok ? grok.authType : "");
  console.log("Grok CLI Eligible:", grok ? isUsageEligible(grok) : "N/A");
}

test().catch(console.error);