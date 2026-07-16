import { getSettings } from "../../../lib/db/repos/settingsRepo.js";
import { DEFAULT_HEADROOM_URL, isLoopbackHeadroomUrl } from "../../../lib/headroom/detect.js";
import { restartHeadroomProxy } from "../../../lib/headroom/process.js";

function parsePortFromUrl(url) {
  try {
    const u = new URL(url);
    const p = parseInt(u.port, 10);
    if (p > 0 && p < 65536) return p;
  } catch {}
  return null;
}

export async function POST(req, res) {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    if (!isLoopbackHeadroomUrl(url)) {
      return res.status(400).json({ error: "External Headroom proxies must be started outside AMRouter", code: "EXTERNAL_PROXY" });
    }
    const port = parsePortFromUrl(url) || 8787;
    const result = await restartHeadroomProxy({
      port,
      codeAware: settings.headroomCodeAware === true,
      kompress: settings.headroomKompress !== false,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" ? 400 : 500;
    return res.status(status).json({ error: error.message, code: error.code || null });
  }
}
