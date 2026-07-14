import { BaseExecutor } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
class PuterExecutor extends BaseExecutor {
  constructor() {
    super("puter", PROVIDERS["puter"] || { format: "openai" });
  }
  buildUrl(_model, _stream, _urlIndex = 0, _credentials = null) {
    return "https://api.puter.com/puterai/openai/v1/chat/completions";
  }
  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json"
    };
    const key = credentials?.apiKey || credentials?.accessToken;
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    return headers;
  }
  transformRequest(model, body, _stream, _credentials) {
    return body;
  }
}
var puter_default = PuterExecutor;
export {
  PuterExecutor,
  puter_default as default
};
