
import { POST_handler as rerankHandler } from "../../../../open-sse/handlers/rerank.js";
export async function POST_handler(req, res) {
  return rerankHandler(req, res);
}
