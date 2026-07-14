import { useState } from "react";

export default function AudioPage() {
  const [tab, setTab] = useState("tts");
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleTTS = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, model: "tts-1", voice: "alloy" }),
      });
      if (res.ok) {
        const blob = await res.blob();
        setResult({ audio: URL.createObjectURL(blob) });
      } else {
        setResult({ error: await res.text() });
      }
    } catch (e) { setResult({ error: e.message }); }
    setLoading(false);
  };

  const handleSTT = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("model", "whisper-1");
    try {
      const res = await fetch("/api/audio/transcriptions", { method: "POST", body: form });
      setResult(await res.json());
    } catch (err) { setResult({ error: err.message }); }
    setLoading(false);
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Audio</h1>
      <div className="flex gap-2">
        <button onClick={() => setTab("tts")} className={`px-4 py-2 rounded-lg ${tab === "tts" ? "bg-primary text-white" : "bg-black/5"}`}>Text to Speech</button>
        <button onClick={() => setTab("stt")} className={`px-4 py-2 rounded-lg ${tab === "stt" ? "bg-primary text-white" : "bg-black/5"}`}>Speech to Text</button>
      </div>
      {tab === "tts" && (
        <div className="space-y-4">
          <textarea className="w-full p-3 rounded-lg border h-40" placeholder="Enter text to convert to speech..." value={text} onChange={e => setText(e.target.value)} />
          <button onClick={handleTTS} disabled={loading} className="px-4 py-2 bg-primary text-white rounded-lg">{loading ? "Generating..." : "Generate Speech"}</button>
          {result?.audio && <audio controls src={result.audio} className="w-full" />}
        </div>
      )}
      {tab === "stt" && (
        <div className="space-y-4">
          <input type="file" accept="audio/*" onChange={handleSTT} className="block" />
          {loading && <p>Transcribing...</p>}
        </div>
      )}
      {result?.error && <p className="text-red-500">{result.error}</p>}
      {result?.text && <pre className="p-4 bg-black/5 rounded-lg text-sm">{result.text}</pre>}
    </div>
  );
}
