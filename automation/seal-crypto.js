import { createDecipheriv } from "node:crypto";
const ALG = "aes-256-gcm";
export function parseKeyB64(keyB64) {
    const key = Buffer.from(keyB64.trim(), "base64");
    if (key.length !== 32) {
        throw new Error(`SEAL key must be 32 bytes (base64), got ${key.length}`);
    }
    return key;
}
export function parseSealedJson(raw) {
    const blob = JSON.parse(raw);
    if (!blob || blob.v !== 1 || !blob.iv || !blob.tag || !blob.ct) {
        throw new Error("invalid sealed JSON");
    }
    return blob;
}
export function unsealUtf8(blob, key) {
    if (blob.v !== 1 || blob.alg !== "AES-256-GCM") {
        throw new Error(`unsupported sealed format v=${blob.v} alg=${blob.alg}`);
    }
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    const ct = Buffer.from(blob.ct, "base64");
    if (iv.length !== 12)
        throw new Error("bad iv length");
    if (tag.length !== 16)
        throw new Error("bad tag length");
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
