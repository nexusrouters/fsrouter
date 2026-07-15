import { useState, useRef } from "react";
import { Button } from "@/shared/components";

export default function BackupRestorePage() {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInputRef = useRef(null);

  const handleBackup = () => {
    // Navigate directly to download the backup file
    window.location.href = "/api/db";
  };

  const handleRestoreClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // File format check
    if (!file.name.endsWith(".fud") && !file.name.endsWith(".json")) {
      setError("Format file tidak didukung. Harap gunakan file berekstensi .fud");
      return;
    }

    if (!window.confirm("PERINGATAN: Memulihkan database akan MENIMPA semua data, pengaturan, dan provider saat ini! Server akan di-restart otomatis. Lanjutkan?")) {
      event.target.value = ""; // reset input
      return;
    }

    setError("");
    setSuccess("");
    setRestoring(true);

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = e.target.result;
          const payload = JSON.parse(content);

          const res = await fetch("/api/db", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          const data = await res.json();
          if (res.ok && data.success) {
            setSuccess("Restore berhasil! Server sedang merestart, harap tunggu beberapa saat...");
            setTimeout(() => {
              window.location.reload();
            }, 5000);
          } else {
            setError(data.error || "Gagal melakukan restore.");
            setRestoring(false);
          }
        } catch (err) {
          setError("File backup corrupt atau tidak valid.");
          setRestoring(false);
        }
      };
      reader.readAsText(file);
    } catch (err) {
      setError("Gagal membaca file.");
      setRestoring(false);
    }
    
    // Reset file input
    event.target.value = "";
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-text-main flex items-center gap-2">
          <span className="material-symbols-outlined text-[28px] text-primary">backup</span>
          Backup & Restore
        </h1>
        <p className="text-xs text-text-muted">
          Amankan seluruh data FSRouter Anda ke dalam satu file .fud, atau pulihkan data dari file backup sebelumnya.
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
        {/* Backup Section */}
        <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col gap-4">
          <div className="flex items-center gap-3 text-text-main">
            <div className="size-10 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center">
              <span className="material-symbols-outlined text-xl">cloud_download</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Buat Backup</h2>
              <p className="text-[11px] text-text-muted">Simpan data ke perangkat Anda</p>
            </div>
          </div>
          
          <div className="text-xs text-text-muted leading-relaxed flex-1">
            <p className="mb-2">File backup (.fud) berisi keseluruhan state sistem:</p>
            <ul className="list-disc list-inside space-y-1 ml-1">
              <li>Konfigurasi Providers & Endpoint</li>
              <li>Riwayat Penggunaan & Limits</li>
              <li>Akun Otomatis & FSmail</li>
              <li>Proxy Pools & Identitas Perangkat</li>
            </ul>
          </div>

          <Button 
            variant="primary" 
            fullWidth 
            onClick={handleBackup}
            icon="download"
          >
            Download Backup (.fud)
          </Button>
        </div>

        {/* Restore Section */}
        <div className="p-6 rounded-[14px] border border-border-subtle bg-surface flex flex-col gap-4">
          <div className="flex items-center gap-3 text-text-main">
            <div className="size-10 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center">
              <span className="material-symbols-outlined text-xl">restore</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold">Pulihkan Backup</h2>
              <p className="text-[11px] text-text-muted">Timpa data dari file .fud</p>
            </div>
          </div>
          
          <div className="text-xs text-text-muted leading-relaxed flex-1">
            <p className="mb-2 text-amber-500/90 font-medium">Perhatian sebelum memulihkan:</p>
            <p>
              Proses restore akan menghapus dan menimpa database yang berjalan saat ini dengan database yang ada di file backup.
              FSRouter akan melakukan restart layanan setelah proses restore selesai.
            </p>
          </div>

          <input 
            type="file" 
            accept=".fud,.json" 
            ref={fileInputRef} 
            onChange={handleFileChange}
            className="hidden" 
          />

          <Button 
            variant="secondary" 
            fullWidth 
            onClick={handleRestoreClick}
            disabled={restoring}
            icon={restoring ? "sync" : "upload"}
          >
            {restoring ? "Sedang Memulihkan..." : "Pilih File & Restore"}
          </Button>
        </div>
      </div>
    </div>
  );
}
