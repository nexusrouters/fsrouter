
import { handleRerank as rerankHandler } from '../../../dist/open-sse/handlers/rerank.js';
export async function POST_handler(req, res) {
  return rerankHandler(req, res);
}
