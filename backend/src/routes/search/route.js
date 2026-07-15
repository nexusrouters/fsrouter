
import { POST_handler as searchHandler } from "../../../open-sse/handlers/search.js";
export async function POST_handler(req, res) {
  return searchHandler(req, res);
}
