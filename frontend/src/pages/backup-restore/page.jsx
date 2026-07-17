import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/shared/components";

export default function BackupRestorePage() {
  const [restoring, setRestoring] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [logs, setLogs] = useState([]);
  const [pasteText, setPasteText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [dbInfo, setDbInfo] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetch("/api/db/info").then(r => r.ok ? r.json() : null).then(d => {
      if (d) {
        setDbInfo(d);
        setFilePath(d.examplePath || "");
      }
    }).catch(() => {});
  }, []);

  const appendLog = useCallback((msg, level = "info") => {
    setLogs((prev) => [...prev.slice(-300), { msg, level, ts: new Date().toLocaleTimeString() }]);
  }, []);

  // ── Backup (logical .fud) with progress ───────────────────────────────────
  const handleBackup = useCallback(async () => {
    setBackingUp(true);
    setError("");
    appendLog("Memulai backup data (logical)...");
    try {
      const res = await fetch("/api/db");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("Content-Length")) || 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (total) setProgress(Math.min(99, Math.round((received / total) * 100)));
        buf += decoder.decode(value, { stream: true });
      }
      const payload = JSON.parse(buf);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "fsrouter-backup.fud";
      a.click();
      URL.revokeObjectURL(url);
      setProgress(100);
      appendLog("✓ Backup selesai: fsrouter-backup.fud", "info");
    } catch (e) {
      appendLog("ERROR: " + e.message, "error");
      setError("Gagal backup: " + e.message);
    } finally {
      setBackingUp(false);
    }
  }, [appendLog]);

  // ── Backup raw database file (.sqlite) ─────────────────────────────────────
  const handleBackupRaw = useCallback(async () => {
    setBackingUp(true);
    setError("");
    appendLog("Memulai backup database mentah (.sqlite)...");
    try {
      const res = await fetch("/api/db/raw");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("Content-Length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (total) setProgress(Math.min(99, Math.round((received / total) * 100)));
        chunks.push(value);
      }
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fsrouter-db-raw-${Date.now()}.sqlite`;
      a.click();
      URL.revokeObjectURL(url);
      setProgress(100);
      appendLog("✓ Backup mentah selesai", "info");
    } catch (e) {
      appendLog("ERROR: " + e.message, "error");
      setError("Gagal backup mentah: " + e.message);
    } finally {
      setBackingUp(false);
    }
  }, [appendLog]);

  // ── Restore (SSE streaming) ────────────────────────────────────────────────
  const runRestore = useCallback(async (payload) => {
    setError("");
    setSuccess("");
    setLogs([]);
    setProgress(0);
    setProgressLabel("Memulai restore...");
    setRestoring(true);
    try {
      const res = await fetch("/api/db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const readerStream = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await readerStream.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const chunk of parts) {
          const lines = chunk.split("\n");
          let evt = "message";
          let dataStr = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) evt = ln.slice(6).trim();
            else if (ln.startsWith("data:")) dataStr = ln.slice(5).trim();
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (evt === "progress") {
            setProgress(data.percent || 0);
            setProgressLabel(data.label || "");
            appendLog(`[${data.percent}%] ${data.label}`, "info");
          } else if (evt === "log") {
            appendLog(data.message, data.level || "info");
          } else if (evt === "error") {
            appendLog(`ERROR: ${data.message}`, "error");
            setError(data.message);
          } else if (evt === "done") {
            appendLog("✓ " + (data.message || "Selesai"), "info");
            setSuccess("Restore berhasil! Server sedang merestart, harap tunggu beberapa saat...");
            finished = true;
            setTimeout(() => window.location.reload(), 5000);
          }
        }
      }
      if (!finished) {
        setSuccess("Restore selesai. Server sedang merestart...");
        setTimeout(() => window.location.reload(), 5000);
      }
    } catch (err) {
      appendLog("ERROR: " + (err.message || err), "error");
      setError(err.message || "File backup corrupt atau tidak valid.");
      setRestoring(false);
    }
  }, [appendLog]);

  const startRestoreFromFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.name.endsWith(".fud") && !file.name.endsWith(".json") && !file.name.endsWith(".sqlite")) {
      setError("Format tidak didukung (.fud / .json / .sqlite)");
      return;
    }
    if (!window.confirm("PERINGATAN: Restore akan MENIMPA semua data saat ini! Lanjutkan?")) return;
    if (file.name.endsWith(".sqlite")) {
      // Raw sqlite: wrap into legacy backup envelope
      const b64 = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(btoa(new Uint8Array(fr.result).reduce((s, b) => s + String.fromCharCode(b), "")));
        fr.readAsArrayBuffer(file);
      });
      return runRestore({ signature: "FUDROUTER_BACKUP", version: 1, files: { "db/data.sqlite": b64 } });
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const payload = JSON.parse(e.target.result);
        await runRestore(payload);
      } catch {
        setError("File backup corrupt atau tidak valid.");
        setRestoring(false);
      }
    };
    reader.readAsText(file);
  }, [runRestore]);

  const handleFileChange = (e) => startRestoreFromFile(e.target.files[0]);

  const handlePasteRestore = useCallback(async () => {
    if (!pasteText.trim()) { setError("Textarea kosong."); return; }
    if (!window.confirm("PERINGATAN: Restore akan MENIMPA semua data saat ini! Lanjutkan?")) return;
    try {
      const payload = JSON.parse(pasteText);
      await runRestore(payload);
    } catch {
      setError("JSON tidak valid.");
      setRestoring(false);
    }
  }, [pasteText, runRestore]);

  const handlePathRestore = useCallback(async () => {
    if (!filePath.trim()) { setError("Path kosong."); return; }
    if (!window.confirm("PERINGATAN: Restore akan MENIMPA semua data saat ini! Lanjutkan?")) return;
    try {
      const res = await fetch("/api/db/restore-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath.trim() })
      });
      // The server streams progress on this same response
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const readerStream = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      setError(""); setSuccess(""); setLogs([]); setProgress(0); setProgressLabel("Memulai restore dari path..."); setRestoring(true);
      while (!finished) {
        const { done, value } = await readerStream.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const chunk of parts) {
          const lines = chunk.split("\n");
          let evt = "message", dataStr = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) evt = ln.slice(6).trim();
            else if (ln.startsWith("data:")) dataStr = ln.slice(5).trim();
          }
          if (!dataStr) continue;
          let data; try { data = JSON.parse(dataStr); } catch { continue; }
          if (evt === "progress") { setProgress(data.percent || 0); setProgressLabel(data.label || ""); appendLog(`[${data.percent}%] ${data.label}`); }
          else if (evt === "log") appendLog(data.message, data.level || "info");
          else if (evt === "error") { appendLog("ERROR: " + data.message, "error"); setError(data.message); }
          else if (evt === "done") { appendLog("✓ " + (data.message || "Selesai")); setSuccess("Restore berhasil! Server merestart..."); finished = true; setTimeout(() => window.location.reload(), 5000); }
        }
      }
    } catch (err) {
      appendLog("ERROR: " + (err.message || err), "error");
      setError(err.message || "Gagal restore dari path.");
      setRestoring(false);
    }
  }, [filePath, appendLog]);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-text-main flex items-center gap-2">
          <span className="material-symbols-outlined text-[28px] text-primary">backup</span>
          Backup & Restore
        </h1>
        <p className="text-xs text-text-muted">
          Amankan seluruh data FSRouter (provider, connections, akun automation, proxy, api keys) ke satu file, atau pulihkan dari file/teks/path.
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-500 text-sm rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">error</span>
          {error}
        </div>
      )}
      {success && (
        <div className="p-4 bg-green-500/10 border border-green-500/20 text-green-500 text-sm rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">check_circle</span>
          {success}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ── Backup ── */}
        <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col gap-4">
          <div className="flex items-center gap-3 text-text-main">
            <div className="size-10 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center">
              <span className="material-symbols-outlined text-xl">cloud_download</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Buat Backup</h2>
              <p className="text-[11px] text-text-muted">Simpan data ke perangkat</p>
            </div>
          </div>
          <div className="text-xs text-text-muted leading-relaxed flex-1">
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li><b>Portabel (.fud)</b>: semua data sebagai JSON — bisa dipulihkan di OS berbeda.</li>
              <li><b>Mentah (.sqlite)</b>: copy langsung file database — paling akurat, sama OS.</li>
            </ul>
          </div>
          <Button variant="primary" fullWidth onClick={handleBackup} disabled={backingUp} icon="download">
            {backingUp ? `Membackup... ${progress}%` : "Download Backup (.fud)"}
          </Button>
          <Button variant="secondary" fullWidth onClick={handleBackupRaw} disabled={backingUp} icon="storage">
            Download Database Mentah (.sqlite)
          </Button>
          {backingUp && (
            <div className="w-full h-2.5 rounded-full bg-sidebar overflow-hidden">
              <div className="h-full bg-gradient-to-r from-primary to-emerald-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>

        {/* ── Restore ── */}
        <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col gap-4">
          <div className="flex items-center gap-3 text-text-main">
            <div className="size-10 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center">
              <span className="material-symbols-outlined text-xl">restore</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Pulihkan Backup</h2>
              <p className="text-[11px] text-text-muted">Timpa data dari file/teks/path</p>
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); startRestoreFromFile(e.dataTransfer.files[0]); }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-border-subtle hover:border-primary/50"}`}
          >
            <span className="material-symbols-outlined text-3xl text-text-muted">upload_file</span>
            <p className="text-xs text-text-muted mt-1">Klik atau seret file .fud / .json / .sqlite ke sini</p>
          </div>
          <input type="file" accept=".fud,.json,.sqlite" ref={fileInputRef} onChange={handleFileChange} className="hidden" />

          {/* Paste */}
          <div className="space-y-1">
            <label className="text-[11px] text-text-muted">Atau tempel (paste) isi file backup JSON:</label>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder='{ "signature": "FUDROUTER_BACKUP", ... }'
              className="w-full h-20 text-[11px] font-mono bg-black/40 border border-border-subtle rounded p-2 text-text-main resize-none"
            />
            <Button variant="secondary" fullWidth onClick={handlePasteRestore} disabled={restoring} icon="content_paste">
              Restore dari Teks
            </Button>
          </div>

          {/* Path */}
          <div className="space-y-1">
            <label className="text-[11px] text-text-muted">
              Atau path file di server{dbInfo ? ` (${dbInfo.isWindows ? "Windows" : dbInfo.platform}):` : ":"}
            </label>
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder={dbInfo?.examplePath || "C:\\Users\\fud\\AppData\\Roaming\\fsrouter\\backups\\fsrouter-backup.fud"}
              className="w-full text-[11px] bg-black/40 border border-border-subtle rounded p-2 text-text-main"
            />
            {dbInfo && (
              <p className="text-[10px] text-text-muted">
                Folder backup default: <code className="text-primary">{dbInfo.defaultBackupDir}</code>
              </p>
            )}
            <Button variant="secondary" fullWidth onClick={handlePathRestore} disabled={restoring} icon="folder_open">
              Restore dari Path
            </Button>
          </div>

          {restoring && (
            <div className="mt-2 space-y-3">
              <div>
                <div className="flex justify-between text-[11px] text-text-muted mb-1">
                  <span>{progressLabel || "Memproses..."}</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-sidebar overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-primary to-emerald-400 transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div className="bg-black/80 rounded-lg p-3 h-48 overflow-y-auto font-mono text-[10px] leading-relaxed">
                {logs.length === 0 ? (
                  <div className="text-text-muted">Menunggu output restore...</div>
                ) : (
                  logs.map((l, i) => (
                    <div key={i} className={l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-amber-400" : "text-green-300"}>
                      <span className="text-text-muted">[{l.ts}]</span> {l.msg}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
