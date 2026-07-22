import { handleAudioTranslation } from '../../../../dist/open-sse/handlers/audioTranslation.js';
import { getProviderCredentials } from "../../../sse/services/auth.js";

export async function POST_handler(req, res) {
  const credentials = await getProviderCredentials(req.body.model?.split("/")?.[0] || "openai");
  return handleAudioTranslation({ req, res, credentials });
}
