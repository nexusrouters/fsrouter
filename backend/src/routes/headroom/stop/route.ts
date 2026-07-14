import { stopHeadroomProxy } from "../../../lib/headroom/process.js";

export async function POST(req, res) {
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return res.status(status).json({ ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message, code: error.code || null });
  }
}
