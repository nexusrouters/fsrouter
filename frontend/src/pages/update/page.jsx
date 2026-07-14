import { useState, useEffect } from "react";

export default function UpdatePage() {
  const [versionInfo, setVersionInfo] = useState({
    currentVersion: "",
    latestVersion: "",
    hasUpdate: false,
  });
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [error, setError] = useState("");

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

  const handleAutoUpdate = async () => {
    if (!window.confirm("Apakah Anda yakin ingin memulai update otomatis? Server akan memuat ulang kode dan melakukan build.")) {
      return;
    }
    
    setUpdating(true);
    setUpdateStatus("Menghubungi server untuk memulai update...");
    setError("");

    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        setUpdateStatus("Proses update dimulai di latar belakang... Mengunduh kode dari GitHub dan membangun ulang aplikasi. Halaman akan kehilangan koneksi sementara saat PM2 me-restart server.");
        
        // Poll backend to check when it comes back online
        let checkCount = 0;
        const interval = setInterval(async () => {
          checkCount++;
          setUpdateStatus(`Membangun ulang aplikasi dan merestart server... (Mencoba menghubungkan kembali: ${checkCount}s)`);
          try {
            const testRes = await fetch("/api/health");
            if (testRes.ok) {
              clearInterval(interval);
              setUpdateStatus("Update selesai! Server kembali online. Memuat ulang halaman...");
              setTimeout(() => {
                window.location.reload();
              }, 2000);
            }
          } catch (e) {
            // normal during restart
          }
          if (checkCount > 180) { // 3 minutes timeout
            clearInterval(interval);
            setUpdating(false);
            setError("Update memakan waktu terlalu lama. Silakan periksa status PM2 server Anda secara manual.");
          }
        }, 2000);
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
          Kelola dan perbarui versi FSRouter Anda langsung dari repositori GitHub.
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
                  ? "Versi baru tersedia di GitHub! Update otomatis akan melakukan 'git pull', menginstal dependensi baru, membangun ulang kode, dan me-restart layanan PM2 Anda secara mulus."
                  : "FSRouter Anda sudah menggunakan versi terbaru di GitHub. Tidak ada pembaruan yang diperlukan saat ini."}
              </p>
            </div>

            {updating ? (
              <div className="p-4 rounded-lg bg-primary/5 border border-primary/20 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                  <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
                  Proses Update Sedang Berjalan
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
    </div>
  );
}
