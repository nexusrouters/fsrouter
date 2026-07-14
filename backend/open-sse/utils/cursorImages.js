import crypto from "node:crypto";
import dns from "node:dns";
import { isIP } from "node:net";
import {
  parseAndValidatePublicUrl,
  isPrivateHost,
  OutboundUrlGuardError
} from "@/shared/network/outboundUrlGuard";
const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;
const MAX_CURSOR_IMAGES = 12;
const IMAGE_FETCH_TIMEOUT_MS = (() => {
  const parsed = parseInt(process.env.CURSOR_IMAGE_FETCH_TIMEOUT_MS || "15000", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 15e3;
})();
const MAX_IMAGE_REDIRECTS = 3;
class CursorImageError extends Error {
  status;
  constructor(message, status = 400) {
    super(message);
    this.name = "CursorImageError";
    this.status = status;
  }
}
function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (comma < 0) {
    throw new CursorImageError("Image data URL is malformed.");
  }
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const mimeType = (header.split(";")[0] || "").trim().toLowerCase() || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new CursorImageError("Image data URL must have an image/* media type.");
  }
  if (!isBase64) {
    throw new CursorImageError("Image data URL must be base64-encoded.");
  }
  if (payload.length > MAX_CURSOR_IMAGE_BYTES * 2) {
    throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
  }
  const normalized = payload.replace(/\s/g, "");
  if (Math.floor(normalized.length * 3 / 4) > MAX_CURSOR_IMAGE_BYTES) {
    throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
  }
  let data;
  try {
    data = Buffer.from(normalized, "base64");
  } catch {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  if (normalized.length > 0 && data.length === 0) {
    throw new CursorImageError("Image data URL contains invalid base64 data.");
  }
  return { data, mimeType };
}
function validatePublicImageUrl(url) {
  try {
    return parseAndValidatePublicUrl(url);
  } catch (err) {
    if (err instanceof OutboundUrlGuardError) {
      throw new CursorImageError(
        err.code === "OUTBOUND_URL_INVALID" ? "Image URL is invalid or uses an unsupported scheme." : "Image URL points to a blocked address."
      );
    }
    throw new CursorImageError("Image URL is invalid.");
  }
}
function assertResolvedAddressesPublic(addresses) {
  for (const addr of addresses) {
    if (isPrivateHost(addr)) {
      throw new CursorImageError("Image URL points to a blocked address.");
    }
  }
}
async function assertHostnameResolvesPublic(hostname) {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) return;
  let resolved;
  try {
    resolved = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new CursorImageError("Image URL host could not be resolved.");
  }
  assertResolvedAddressesPublic(resolved.map((r) => r.address));
}
async function fetchImageBytes(url) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const parsed = validatePublicImageUrl(currentUrl);
    await assertHostnameResolvesPublic(parsed.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(parsed.toString(), {
        method: "GET",
        signal: controller.signal,
        redirect: "manual"
      });
    } catch {
      clearTimeout(timer);
      throw new CursorImageError("Could not fetch the image URL.");
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new CursorImageError("Image URL redirect is missing a destination.");
        }
        try {
          currentUrl = new URL(location, parsed.toString()).toString();
        } catch {
          throw new CursorImageError("Image URL redirect destination is invalid.");
        }
        continue;
      }
      if (!response.ok) {
        throw new CursorImageError(`Could not fetch the image URL (status ${response.status}).`);
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const mimeType = contentType.split(";")[0].trim();
      if (!mimeType.startsWith("image/")) {
        throw new CursorImageError("Image URL did not return an image content type.");
      }
      const declaredLen = Number(response.headers.get("content-length") || "0");
      if (Number.isFinite(declaredLen) && declaredLen > MAX_CURSOR_IMAGE_BYTES) {
        throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
      }
      const data = await readCapped(response, MAX_CURSOR_IMAGE_BYTES);
      return { data, mimeType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CursorImageError("Image URL has too many redirects.");
}
async function readCapped(response, cap) {
  const body = response.body;
  if (!body) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  const pushCapped = (chunk) => {
    total += chunk.byteLength;
    if (total > cap) {
      throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
    }
    chunks.push(Buffer.from(chunk));
  };
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      pushCapped(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) pushCapped(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > cap) {
    throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
  }
  return buf;
}
async function resolveCursorImages(imageUrls) {
  if (imageUrls.length > MAX_CURSOR_IMAGES) {
    throw new CursorImageError(
      `Too many images in one request (max ${MAX_CURSOR_IMAGES}).`
    );
  }
  const out = [];
  for (const url of imageUrls) {
    if (typeof url !== "string" || !url) {
      throw new CursorImageError("Image URL is missing.");
    }
    const { data, mimeType } = url.toLowerCase().startsWith("data:") ? decodeDataUrl(url) : await fetchImageBytes(url);
    if (!data.length) {
      throw new CursorImageError("Image input is empty.");
    }
    if (data.length > MAX_CURSOR_IMAGE_BYTES) {
      throw new CursorImageError("Image input is too large (max 1 MiB). Resize and retry.");
    }
    out.push({ data, mimeType, uuid: crypto.randomUUID() });
  }
  return out;
}
function extractImageUrls(content) {
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "image_url") {
      const imageUrl = part.image_url;
      if (typeof imageUrl === "string") {
        urls.push(imageUrl);
      } else if (imageUrl && typeof imageUrl === "object" && typeof imageUrl.url === "string") {
        urls.push(imageUrl.url);
      }
    }
  }
  return urls;
}
export {
  CursorImageError,
  MAX_CURSOR_IMAGES,
  MAX_CURSOR_IMAGE_BYTES,
  assertResolvedAddressesPublic,
  extractImageUrls,
  resolveCursorImages
};
