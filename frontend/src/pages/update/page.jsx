import { useState, useEffect, useRef } from "react";

export default function UpdatePage() {
  const [versionInfo, setVersionInfo] = useState({
    currentVersion: "",
    latestVersion: "",
    hasUpdate: false,
  });
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateStatus, setUpdateStatus] = useState("");
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const logEndRef = useRef(null);

  const fetchVersion = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/version");
      const data = await res.json();
      setVersionInfo(data);
    } catch (err) {
      console.error(err);
      setError("Gagal memuat informasi versi.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVersion();
  }, []);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const handleAutoUpdate = async () => {
    if (!window.confirm("Apakah Anda yakin ingin memulai update otomatis?")) {
      return;
    }

    setUpdating(true);
    setProgress(0);
    setLogs([]);
    setUpdateStatus("Menghubungi server untuk memulai update...");
    setError("");

    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        // Connect to SSE stream
        const eventSource = new EventSource("/api/version/update");

        eventSource.onmessage = (event) => {
          const payload = JSON.parse(event.data);
          setProgress(payload.progress || 0);
          setLogs(payload.logs || []);

          if (payload.status === "updating") {
            setUpdateStatus(`Sedang memproses update... (${payload.progress}%)`);
          } else if (payload.status === "done" || payload.progress === 100) {
            eventSource.close();
            setUpdateStatus("Update berhasil diselesaikan! Server sedang merestart...");
            
            // Poll for server to come back online
            let checkCount = 0;
            const interval = setInterval(async () => {
              checkCount++;
              setUpdateStatus(`Menunggu server online kembali... (Mencoba menghubungkan: ${checkCount}s)`);
              try {
                const testRes = await fetch("/api/health");
                if (testRes.ok) {
                  clearInterval(interval);
                  setUpdateStatus("Update Selesai! Halaman akan dimuat ulang...");
                  setTimeout(() => {
                    window.location.reload();
                  }, 1500);
                }
              } catch (e) {
                // Ignore failure during restart
              }
              if (checkCount > 90) { // 3 minutes max
                clearInterval(interval);
                setUpdating(false);
                setError("Server memakan waktu terlalu lama untuk online kembali. Silakan periksa status PM2 Anda secara manual.");
              }
            }, 2000);
          }
        };

        eventSource.onerror = (err) => {
          console.error("EventSource error:", err);
          // If it disconnects because server went down to restart, that's expected
          if (progress > 80) {
            eventSource.close();
            // Let the health check interval handle it
          } else {
            eventSource.close();
            setError("Koneksi ke server terputus saat proses update berjalan.");
            setUpdating(false);
          }
        };
      } else {
        setError(data.message || "Gagal memulai update otomatis.");
        setUpdating(false);
      }
    } catch (err) {
      console.error(err);
      setError("Koneksi gagal saat memulai update.");
      setUpdating(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-text-main flex items-center gap-2">
          <span className="material-symbols-outlined text-[28px] text-primary">system_update</span>
          FSRouter System Update
        </h1>
        <p className="text-xs text-text-muted">
          Kelola dan perbarui versi FSRouter Anda langsung dari repositori GitHub atau NPM registry.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-12 border border-border-subtle rounded-[14px] bg-surface">
          <div className="flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-4xl animate-spin text-primary">sync</span>
            <span className="text-sm text-text-muted">Memuat informasi versi...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-text-main">Detail Versi</h2>
            
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <span className="text-xs text-text-muted">Versi Saat Ini</span>
              <span className="text-sm font-mono font-semibold text-text-main">
                v{versionInfo.currentVersion || "0.0.0"}
              </span>
            </div>

            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <span className="text-xs text-text-muted">Versi Terbaru di GitHub</span>
              <span className="text-sm font-mono font-semibold text-text-main">
                v{versionInfo.latestVersion || "0.0.0"}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">Status</span>
              {versionInfo.hasUpdate ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Update Tersedia
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/10 text-green-500 border border-green-500/20">
                  Versi Terbaru
                </span>
              )}
            </div>
          </div>

          <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col justify-between gap-4">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-text-main">Aksi Pembaruan</h2>
              <p className="text-xs text-text-muted leading-relaxed">
                {versionInfo.hasUpdate
                  ? "Versi baru tersedia! Update otomatis akan menginstal versi terbaru, memperbarui dependensi, membangun ulang kode, dan me-restart server FSRouter Anda secara mulus."
                  : "FSRouter Anda sudah menggunakan versi terbaru. Tidak ada pembaruan yang diperlukan saat ini."}
              </p>
            </div>

            {updating ? (
              <div className="p-4 rounded-lg bg-primary/5 border border-primary/20 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                  <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
                  Proses Update Sedang Berjalan: {progress}%
                </div>
                {/* Progress bar */}
                <div className="w-full bg-border-subtle rounded-full h-2.5 overflow-hidden">
                  <div 
                    className="bg-primary h-2.5 rounded-full transition-all duration-500" 
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-[11px] text-text-muted leading-relaxed">
                  {updateStatus}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {error && (
                  <p className="text-xs text-red-500 font-semibold bg-red-500/10 border border-red-500/20 p-3 rounded-lg">
                    {error}
                  </p>
                )}

                <div className="flex items-center gap-3">
                  <button
                    disabled={!versionInfo.hasUpdate}
                    onClick={handleAutoUpdate}
                    className={`flex-1 py-2 px-4 rounded-lg text-xs font-semibold text-white transition-colors flex items-center justify-center gap-2 ${
                      versionInfo.hasUpdate
                        ? "bg-primary hover:bg-primary/90 cursor-pointer"
                        : "bg-border-subtle text-text-muted cursor-not-allowed"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">download</span>
                    Otomatis Update Sekarang
                  </button>
                  <button
                    onClick={fetchVersion}
                    className="py-2 px-3 rounded-lg border border-border-subtle text-text-main text-xs hover:bg-surface-2 transition-colors cursor-pointer"
                    title="Periksa Ulang"
                  >
                    <span className="material-symbols-outlined text-[16px] block">refresh</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Real-time console logs when updating */}
      {updating && logs.length > 0 && (
        <div className="p-4 rounded-[14px] border border-border-subtle bg-black text-green-400 font-mono text-xs overflow-hidden flex flex-col gap-2">
          <div className="flex items-center justify-between pb-2 border-b border-green-900/50">
            <span className="text-green-500 font-semibold flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-green-500 animate-pulse" />
              Logs Konsol Pembaruan
            </span>
            <span className="text-[10px] text-green-600">FSRouter Updater</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto space-y-1 custom-scrollbar">
            {logs.map((log, index) => (
              <pre key={index} className="whitespace-pre-wrap leading-relaxed break-all font-mono">
                {log}
              </pre>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
