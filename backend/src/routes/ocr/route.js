
import { handleOcr as ocrHandler } from '../../../dist/open-sse/handlers/ocr.js';
export async function POST_handler(req, res) {
  return ocrHandler(req, res);
}
