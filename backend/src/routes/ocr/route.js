
import { POST_handler as ocrHandler } from "../../../../open-sse/handlers/ocr.js";
export async function POST_handler(req, res) {
  return ocrHandler(req, res);
}
