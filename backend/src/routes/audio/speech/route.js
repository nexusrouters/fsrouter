
import { POST_handler as speechHandler } from "../../../../open-sse/handlers/audioSpeech.js";
export async function POST_handler(req, res) {
  return speechHandler(req, res);
}
