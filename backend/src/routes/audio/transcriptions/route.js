
import { POST_handler as transcriptionHandler } from "../../../../open-sse/handlers/audioTranscription.js";
export async function POST_handler(req, res) {
  return transcriptionHandler(req, res);
}
