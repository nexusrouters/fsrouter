# FSRouter — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use FSRouter for you.

> Tip: start with the **fsrouter** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-image/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/nexusrouters/fsrouter/refs/heads/main/skills/fsrouter/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export FSROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export FSROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $FSROUTER_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/nexusrouters/fsrouter
- Dashboard: https://fsrouter.com
