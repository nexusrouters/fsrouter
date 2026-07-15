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
    const isWindows = /^win/.test(process.platform);

    res.json({ success: true, message: "Update process started." });

    let command = "";
    let args: string[] = [];
    let cwd = "";

    if (isGit) {
      command = isWindows ? "cmd.exe" : "sh";
      args = isWindows 
        ? ["/c", "git pull && npm install && npm run build --workspace=backend && npm run build --workspace=frontend && xcopy /E /Y /I frontend\\dist backend\\public"] 
        : ["-c", "git pull && npm install && npm run build --workspace=backend && npm run build --workspace=frontend && cp -r frontend/dist/* backend/public/"];
      cwd = fs.existsSync(path.join("/root/AMRouter", ".git")) ? "/root/AMRouter" : rootDir;
      
      updateLogs.push("[Updater] Environment: Git Repository");
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
      });

    } else {
      // Global npm update
      updateLogs.push("[Updater] Environment: NPM Global Package");
      
      if (isWindows) {
        updateLogs.push("[Updater] Windows OS Detected! EBUSY protection active.");
        updateLogs.push("[Updater] Server is safely detaching to perform npm install...");
        
        // Buat file update.bat untuk melepaskan file lock
        const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
        const batPath = path.join(tmpDir, "fsrouter_updater.bat");
        
        // Script update: tunggu 3 detik biar nodejs mati, lalu npm install, lalu restart PM2
        const batContent = `
@echo off
echo Menunggu FSRouter tertutup untuk mencegah EBUSY file lock...
timeout /t 3 /nobreak >nul
echo Mengunduh dan menginstal FSRouter versi terbaru...
call npm install -g @fudrouter/fsrouter@latest --prefer-online
echo Update selesai. Me-restart layanan FSRouter...
call pm2 restart fsrouter
del "%~f0"
`;
        fs.writeFileSync(batPath, batContent);
        
        updateLogs.push(`[Updater] Created detached script at ${batPath}`);
        updateProgress = 50;
        
        // Spawn detached
        const proc = spawn("cmd.exe", ["/c", batPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        proc.unref();

        updateLogs.push("[Updater] Handing over to detached updater. Server shutting down NOW...");
        updateProgress = 100;
        
        setTimeout(() => {
          isUpdating = false;
          process.exit(0);
        }, 1500);

      } else {
        // Linux Global NPM Update (Tidak ada EBUSY issue)
        command = "npm";
        args = ["install", "-g", "@fudrouter/fsrouter@latest", "--prefer-online"];
        cwd = process.cwd();

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

          if (code === 0) {
            updateLogs.push("[Updater] Update successful! Restarting server process...");
            setTimeout(() => {
              process.exit(0);
            }, 3000);
          }
        });
      }
    }

  } catch (error: any) {
    isUpdating = false;
    console.error("Error starting update:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
