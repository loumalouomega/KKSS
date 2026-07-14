# Configuration

KKSS deliberately keeps configuration minimal ("Keep Kratos Simple Stupid").

## Scene theme

The mesh viewer's theme selector (Auto / Dark / Light / Scientific, in the Post-Processing toolbar) persists across sessions.

## LLM assistant

**Settings ▸ LLM Assistant** configures the AI chat sidebar ([Getting Started ▸ AI assistant](/guide/getting-started#ai-assistant)):

| Setting | Meaning | Default |
| --- | --- | --- |
| Provider | `Anthropic (Claude)` or `OpenAI-compatible` | Anthropic |
| Anthropic API Key | stored encrypted (OS keychain via `safeStorage`) | — |
| Anthropic Model | any Claude model id | `claude-opus-4-8` |
| OpenAI-compatible API Key | optional (keyless backends like Ollama work) | — |
| OpenAI-compatible Base URL | any `chat/completions` endpoint | `https://api.openai.com/v1` |
| OpenAI-compatible Model | model name your backend expects | `gpt-4o` |

Changes apply to the next chat message — no restart. API keys are encrypted with the OS keychain when one is available; on systems without a keyring they fall back to plaintext in `state.json` (below). Entering an empty value clears a stored key.

## Where state lives

| State | Location |
| --- | --- |
| App state (theme, one-time warnings) | `state.json` in the platform's user-data dir (`~/.config/KKSS` on Linux, `%APPDATA%/KKSS` on Windows, `~/Library/Application Support/KKSS` on macOS) |
| CAD parts / edits / mesh options | JSON sidecars next to the opened model — see [Pre-Processing mode](/guide/cad-mode#sidecar-files) |
| Mesh operation recipes | Saved explicitly via the Edit sidebar's Save/Load buttons |

## Command-line

`kkss <file>` opens the given model on startup in the mode the file's extension implies.
