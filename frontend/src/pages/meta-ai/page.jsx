import { useState } from "react";
import { Card, Button } from "@/shared/components";

export default function MetaAiPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [birthday, setBirthday] = useState("1990-01-15");
  const [proxy, setProxy] = useState("");
  const [fsmailKey, setFsmailKey] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  async function startSignup() {
    if (!email || !password) {
      setResult({ ok: false, error: "Email & password wajib diisi." });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch("/api/automation/meta-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "signup",
          email,
          password,
          birthday,
          proxy,
          fsmailApiKey: fsmailKey,
        }),
      });
      const data = await r.json();
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="text-lg font-semibold mb-1">Auto-create Meta AI (dev.meta.ai)</h3>
        <p className="text-text-muted text-sm mb-4">
          Buat akun Meta + akses Meta Model API lewat email. Flow: email → birthday (18+) →
          password → OTP email. dev.meta.ai region-locked — butuh residential proxy
          (US/EU) di field Proxy agar tidak kena "Model API isn't available in your region".
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-muted">Email</label>
            <input
              className="w-full mt-1 px-3 py-2 rounded-lg bg-bg-subtle border border-border-subtle text-text-main"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted">Password</label>
            <input
              className="w-full mt-1 px-3 py-2 rounded-lg bg-bg-subtle border border-border-subtle text-text-main"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted">Birthday (YYYY-MM-DD, 18+)</label>
            <input
              className="w-full mt-1 px-3 py-2 rounded-lg bg-bg-subtle border border-border-subtle text-text-main"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted">Residential Proxy (http://user:pass@host:port)</label>
            <input
              className="w-full mt-1 px-3 py-2 rounded-lg bg-bg-subtle border border-border-subtle text-text-main"
              placeholder="wajib untuk region US/EU"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-text-muted">Fsmail API Key (buat baca OTP)</label>
            <input
              className="w-full mt-1 px-3 py-2 rounded-lg bg-bg-subtle border border-border-subtle text-text-main"
              placeholder="fsmail api key (jika pakai email fsmail)"
              value={fsmailKey}
              onChange={(e) => setFsmailKey(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={startSignup} disabled={running}>
            {running ? "Memproses…" : "Start Auto-Create"}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-5">
          <h4 className="font-semibold mb-2">Result</h4>
          <pre className="text-xs bg-bg-subtle p-3 rounded-lg overflow-auto whitespace-pre-wrap">
            {JSON.stringify(result, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
