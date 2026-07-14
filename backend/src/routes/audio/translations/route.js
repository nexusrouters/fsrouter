
import { POST_handler as translationHandler } from "../../../../open-sse/handlers/audioTranslation.js";
export async function POST_handler(req, res) {
  return translationHandler(req, res);
}
