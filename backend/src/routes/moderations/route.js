
import { handleModeration as moderationHandler } from '../../../dist/open-sse/handlers/moderations.js';
export async function POST_handler(req, res) {
  return moderationHandler(req, res);
}
