import { useState } from "react";

export default function OCRPage() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoading(true);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/ocr", { method: "POST", body: form });
      setResult(await res.json());
    } catch (err) { setResult({ error: err.message }); }
    setLoading(false);
  };

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">OCR</h1>
      <p className="text-text-muted">Extract text from images using Mistral OCR API</p>
      <input type="file" accept="image/*,.pdf" onChange={handleUpload} className="block" />
      {loading && <p>Processing...</p>}
      {result && <pre className="p-4 bg-black/5 rounded-lg text-sm overflow-auto max-h-96">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
