import { handleWebFetch } from '../../../../dist/open-sse/handlers/webFetch.js';
import { getProviderCredentials } from "../../../sse/services/auth.js";

export async function POST_handler(req, res) {
  const provider = req.body.provider || "firecrawl";
  const credentials = await getProviderCredentials(provider);
  const result = await handleWebFetch(req.body, credentials, provider);
  if (result.success === false) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.status(200).json(result.data);
}
