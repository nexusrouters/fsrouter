
import { POST_handler as fetchHandler } from "../../../../open-sse/handlers/webFetch.js";
export async function POST_handler(req, res) {
  return fetchHandler(req, res);
}
