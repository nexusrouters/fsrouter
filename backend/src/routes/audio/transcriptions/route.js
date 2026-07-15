import { handleAudioTranscription } from "../../../open-sse/handlers/audioTranscription.js";
import { getProviderCredentials } from "../../../sse/services/auth.js";

export async function POST_handler(req, res) {
  const credentials = await getProviderCredentials(req.body.model?.split("/")?.[0] || "openai");
  return handleAudioTranscription({ req, res, credentials });
}
