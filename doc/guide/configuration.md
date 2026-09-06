# Configuration

KKSS deliberately keeps configuration minimal ("Keep Kratos Simple Stupid").

## Scene theme

The mesh viewer's theme selector (Auto / Dark / Light / Scientific, in the Post-Processing toolbar) persists across sessions.

## Interface scale

The **scale picker** on the right of the shell toolbar (75 %–150 %) sets how large the whole application is drawn — the toolbar, both viewers, the terminal, and the chat sidebar all scale together, so the layout stays proportional on high-DPI or low-resolution displays. The choice persists across launches. It's also on the keyboard: `Ctrl +` / `Ctrl -` step through the presets and `Ctrl+Shift+0` resets to 100 % (mirrored under **View ▸ Zoom In / Zoom Out / Reset Zoom**).

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

## Cloud accounts

**Settings ▸ Cloud Accounts** connects KKSS to Google Drive, Dropbox or OneDrive, so
**File ▸ Open from Cloud…** can open a model directly — no desktop sync client required.
See [Getting Started ▸ Working from cloud storage](/guide/getting-started#working-from-cloud-storage)
for how a cloud document behaves once it is open.

**KKSS ships no OAuth credentials of its own.** You register a desktop/installed-app client
in your own provider console and paste its client ID into the menu. That means nothing here
routes through an application account you do not control — and it means there is a one-time
setup step per provider:

| Provider | Redirect URI to register | Client secret | Scopes requested |
| --- | --- | --- | --- |
| Google Drive | `http://127.0.0.1/callback` — Google accepts a loopback redirect on **any** port | Issued for a "Desktop app" client; paste it too | `https://www.googleapis.com/auth/drive` |
| Dropbox | `http://127.0.0.1:53682/callback` — **exactly this**, Dropbox matches the whole URI including the port | None (PKCE public client) | `files.metadata.read`, `files.content.read`, `files.content.write`, `account_info.read` |
| OneDrive | `http://localhost/callback` as a **Mobile & desktop** platform redirect | None (PKCE public client) | `Files.ReadWrite`, `offline_access`, `User.Read` |

Two things worth knowing before you start:

- **Google's testing-mode refresh tokens expire after seven days.** While your OAuth consent
  screen is in "Testing", you will have to reconnect weekly. Publishing the consent screen
  (even for a single-user app) removes the limit.
- **Google Drive asks for full `drive` scope, not `drive.file`.** The narrower scope only sees
  files the app itself created or that were picked through *Google's own* file picker, which
  KKSS does not use — with it, the Open from Cloud browser would show an empty Drive.

Client IDs are stored in `state.json`; client secrets and refresh tokens go through the same
encrypted store as the LLM API key. **Disconnect…** forgets the sign-in and offers to delete
the cached copies with it.

## Where state lives

| State | Location |
| --- | --- |
| App state (theme, interface scale, project folder, recent files, last session, one-time warnings) | `state.json` in the platform's user-data dir (`~/.config/KKSS` on Linux, `%APPDATA%/KKSS` on Windows, `~/Library/Application Support/KKSS` on macOS) |
| CAD parts / edits / mesh options | JSON sidecars next to the opened model — see [Pre-Processing mode](/guide/cad-mode#sidecar-files) |
| Mesh operation recipes | Saved explicitly via the Edit sidebar's Save/Load buttons |
| Cloud client IDs | `state.json` (public by OAuth's design) |
| Cloud client secrets and refresh tokens | `state.json`, encrypted with the OS keychain like the LLM API key |
| Cloud staging cache and its manifest | `cloud-cache/` beside `state.json` in the same user-data dir |

Note that the user-data dir is **not** inside your project folder, so syncing a project folder
never syncs your settings or your credentials.

## Command-line

`kkss <file>` opens the given model on startup in the mode the file's extension implies.
