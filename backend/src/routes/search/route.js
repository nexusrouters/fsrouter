
import { handleSearch as searchHandler } from '../../../dist/open-sse/handlers/search.js';
export async function POST_handler(req, res) {
  return searchHandler(req, res);
}
