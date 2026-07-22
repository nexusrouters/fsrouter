import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * POST /api/automation/meta-ai
 *   body: { action: "signup", email, password, birthday?, proxy?, fsmailApiKey?, fsmailBaseUrl? }
 *     -> spawns backend/src/automation/meta_ai_signup.py
 * GET  /api/automation/meta-ai
 *     -> { ok, note }
 */
export async function GET(req: any, res: any) {
  return res.json({
    ok: true,
    note: "Meta AI auto-create. POST { action:'signup', email, password, birthday, proxy?, fsmailApiKey? }",
  });
}

export async function POST(req: any, res: any) {
  try {
    const body = req.body || {};
    const { action } = body;
    if (action !== "signup") {
      return res.status(400).json({ error: "Unknown action" });
    }
    const { email, password, birthday, proxy, fsmailApiKey, fsmailBaseUrl } = body;
    if (!email || !password) {
      return res.status(400).json({ error: "email & password required" });
    }

    const script = path.resolve(process.cwd(), "src/automation/meta_ai_signup.py");
    const args = [
      script,
      `--email=${email}`,
      `--password=${password}`,
      `--birthday=${birthday || "1990-01-15"}`,
      `--proxy=${proxy || ""}`,
      `--fsmail-api-key=${fsmailApiKey || ""}`,
      `--fsmail-base-url=${fsmailBaseUrl || "https://fsmail.nguprus.app"}`,
      `--headless=1`,
    ];

    const child = spawn("python3", args, { cwd: process.cwd() });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      let result: any = { ok: false };
      try {
        result = JSON.parse(out.trim().split("\n").pop() || "{}");
      } catch {
        result = { ok: false, raw: out.slice(-500), error: err.slice(-300) };
      }
      result.exit_code = code;
      return res.json(result);
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}
