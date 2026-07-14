import { getSettings } from "../../../lib/db/repos/settingsRepo.js";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "../../../lib/headroom/detect.js";
import { getManagedPid } from "../../../lib/headroom/process.js";

export async function GET(req, res) {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();
    return res.json({ ...status, url, managedPid });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
