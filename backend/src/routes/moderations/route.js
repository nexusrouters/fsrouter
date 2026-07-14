
import { POST_handler as moderationHandler } from "../../../../open-sse/handlers/moderations.js";
export async function POST_handler(req, res) {
  return moderationHandler(req, res);
}
