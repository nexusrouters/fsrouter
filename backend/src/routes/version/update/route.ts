import { spawn } from "child_process";
import path from "path";
import fs from "fs";

let updateLogs: string[] = [];
let updateProgress = 0;
let isUpdating = false;

export async function GET(req: any, res: any) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!isUpdating) {
    sendEvent({ progress: 100, status: "idle", logs: updateLogs });
    res.end();
    return;
  }

  sendEvent({ progress: updateProgress, status: "updating", logs: updateLogs });

  const interval = setInterval(() => {
    if (!isUpdating) {
      sendEvent({ progress: 100, status: "done", logs: updateLogs });
      clearInterval(interval);
      res.end();
    } else {
      sendEvent({ progress: updateProgress, status: "updating", logs: updateLogs });
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
}

export async function POST(req: any, res: any) {
  try {
    if (isUpdating) {
      return res.json({ success: true, message: "Update already in progress." });
    }

    isUpdating = true;
    updateLogs = [];
    updateProgress = 0;

    const rootDir = path.resolve(process.cwd());
    const isGit = fs.existsSync(path.join(rootDir, ".git")) || fs.existsSync(path.join("/root/AMRouter", ".git"));

    res.json({ success: true, message: "Update process started." });

    let command = "";
    let args: string[] = [];
    let cwd = "";

    if (isGit) {
      command = /^win/.test(process.platform) ? "cmd.exe" : "sh";
      args = /^win/.test(process.platform) 
        ? ["/c", "git pull && npm install && npm run build --workspace=backend && npm run build --workspace=frontend && xcopy /E /Y /I frontend\\dist backend\\public"] 
        : ["-c", "git pull && npm install && npm run build --workspace=backend && npm run build --workspace=frontend && cp -r frontend/dist/* backend/public/"];
      cwd = fs.existsSync(path.join("/root/AMRouter", ".git")) ? "/root/AMRouter" : rootDir;
    } else {
      command = /^win/.test(process.platform) ? "npm.cmd" : "npm";
      args = ["install", "-g", "@fudrouter/fsrouter@latest", "--prefer-online"];
      cwd = process.cwd();
    }

    updateLogs.push("[Updater] Environment: " + (isGit ? "Git Repository" : "NPM Global Package"));
    updateLogs.push(`[Updater] Executing: ${command} ${args.join(" ")}`);
    updateProgress = 10;

    const proc = spawn(command, args, { cwd, shell: true });

    proc.stdout.on("data", (data) => {
      const text = data.toString();
      updateLogs.push(text);
      if (updateProgress < 85) updateProgress += 2;
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      updateLogs.push(text);
      if (updateProgress < 85) updateProgress += 1;
    });

    proc.on("close", (code) => {
      updateProgress = 100;
      updateLogs.push(`[Updater] Process exited with code ${code}`);
      isUpdating = false;

      if (!isGit && code === 0) {
        updateLogs.push("[Updater] Update successful! Restarting server process...");
        setTimeout(() => {
          process.exit(0); // Exit process, PM2 or parent runner will restart it
        }, 3000);
      }
    });

  } catch (error: any) {
    isUpdating = false;
    console.error("Error starting update:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
