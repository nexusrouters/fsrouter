import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

// Fetch latest version from GitHub releases
function fetchLatestGitHubVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path: "/repos/nexusrouters/fsrouter/releases/latest",
      headers: {
        "User-Agent": "FSRouter-App"
      },
      timeout: 5000
    };

    const req = https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const release = JSON.parse(data);
          const tag = release.tag_name || ""; // e.g. "v0.6.5" or "0.6.5"
          const cleanVersion = tag.replace(/^v/, "");
          resolve(cleanVersion || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const numA = pa[i] || 0;
    const numB = pb[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

export async function GET(req: any, res: any) {
  try {
    const currentVersion = pkg.version;
    const latestVersion = await fetchLatestGitHubVersion();

    if (!latestVersion) {
      return res.json({
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false
      });
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return res.json({
      currentVersion,
      latestVersion,
      hasUpdate
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
