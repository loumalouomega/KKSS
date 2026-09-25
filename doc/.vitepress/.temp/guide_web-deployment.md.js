import { t as _plugin_vue_export_helper_default } from "./plugin-vue_export-helper.BOaGB7Aw.js";
import { ssrRenderAttrs, ssrRenderStyle } from "vue/server-renderer";
import { useSSRContext } from "vue";
//#region guide/web-deployment.md
var __pageData = JSON.parse("{\"title\":\"Web Deployment (Docker)\",\"description\":\"\",\"frontmatter\":{},\"headers\":[],\"relativePath\":\"guide/web-deployment.md\",\"filePath\":\"guide/web-deployment.md\"}");
var _sfc_main = { name: "guide/web-deployment.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
	_push(`<div${ssrRenderAttrs(_attrs)}><h1 id="web-deployment-docker" tabindex="-1">Web Deployment (Docker) <a class="header-anchor" href="#web-deployment-docker" aria-label="Permalink to “Web Deployment (Docker)”">​</a></h1><p>KKSS can run &quot;as a web app&quot;: the unmodified desktop application runs headless inside a Docker container (Xvfb virtual display + SwiftShader software rendering — the same configuration the CI smoke test exercises) and the desktop is streamed to a browser tab via <a href="https://novnc.com/" target="_blank" rel="noreferrer">noVNC</a>. The browser is fronted by an authenticated gateway; Caddy handles TLS and WebSocket proxying. Nothing in the app viewer changes; the browser shows the real Electron window.</p><p>The default Compose file is a single-user deployment. For multiple users, the reference broker in <code>docker-compose.multi.yml</code> starts one isolated container, workspace volume and file-browser companion per authenticated session.</p><p>The gateway uses Caddy for the public edge because its <a href="https://caddyserver.com/docs/automatic-https" target="_blank" rel="noreferrer">automatic HTTPS</a> and <a href="https://caddyserver.com/docs/caddyfile/directives/reverse_proxy" target="_blank" rel="noreferrer">WebSocket-capable reverse proxy</a> cover both edge concerns in one component. nginx would require a separate certificate lifecycle configuration here, while oauth2-proxy covers OIDC but leaves local accounts, stream tracking and broker ownership to another service. The direct TLS overlay accepts mounted <code>KKSS_TLS_CERT</code>/<code>KKSS_TLS_KEY</code> files or uses <code>KKSS_PUBLIC_URL</code> for ACME; the proxy overlay is for operators who already terminate TLS upstream.</p><h2 id="three-ways-to-start-it" tabindex="-1">Three ways to start it <a class="header-anchor" href="#three-ways-to-start-it" aria-label="Permalink to “Three ways to start it”">​</a></h2><p>Every release publishes a <strong>linux/amd64 + linux/arm64</strong> image to both <a href="https://github.com/loumalouomega/KKSS/pkgs/container/kkss" target="_blank" rel="noreferrer">GitHub Container Registry</a> (<code>ghcr.io/loumalouomega/kkss</code>) and <a href="https://hub.docker.com/r/vmataix/kkss" target="_blank" rel="noreferrer">Docker Hub</a> (<code>vmataix/kkss</code>). The two are the same image; use whichever you prefer.</p><h3 id="_1-prebuilt-one-command" tabindex="-1">1. Prebuilt, one command <a class="header-anchor" href="#_1-prebuilt-one-command" aria-label="Permalink to “1. Prebuilt, one command”">​</a></h3><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> run</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -d</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --name</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> kkss</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --restart</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> unless-stopped</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> \\</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">  -p</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> 6080:6080</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --shm-size=1g</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> \\</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">  -v</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> /path/to/your/simulations:/workspace</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> \\</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">  ghcr.io/loumalouomega/kkss:latest</span></span></code></pre></div><h3 id="_2-prebuilt-with-compose" tabindex="-1">2. Prebuilt, with compose <a class="header-anchor" href="#_2-prebuilt-with-compose" aria-label="Permalink to “2. Prebuilt, with compose”">​</a></h3><p>No checkout needed beyond the one file — download <a href="https://github.com/loumalouomega/KKSS/blob/master/docker-compose.ghcr.yml" target="_blank" rel="noreferrer"><code>docker-compose.ghcr.yml</code></a> and:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> compose</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -f</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> docker-compose.ghcr.yml</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> up</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -d</span></span></code></pre></div><h3 id="_3-build-it-yourself" tabindex="-1">3. Build it yourself <a class="header-anchor" href="#_3-build-it-yourself" aria-label="Permalink to “3. Build it yourself”">​</a></h3><p>Needs a checkout <strong>with initialized submodules</strong> — the image builds from them:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">git</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> clone</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> https://github.com/loumalouomega/KKSS.git</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">cd</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> KKSS</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">git</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> submodule</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> update</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --init</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --recursive</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> compose</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> up</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --build</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -d</span></span></code></pre></div><p>The first build takes a while (it downloads Electron, compiles node-pty from source, and packages the app); later builds reuse cached layers. <code>npm run docker:build</code> / <code>docker:up</code> / <code>docker:down</code> / <code>docker:logs</code> are shorthands.</p><p><strong>Then, whichever path you took</strong>: open <a href="http://localhost:6080/" target="_blank" rel="noreferrer">http://localhost:6080/</a>. Sign in with the generated startup credential printed by the container, or with the bcrypt user file supplied through <code>KKSS_AUTH_USERS_FILE</code>. The page reconnects the VNC stream automatically and provides Files and Sign out links.</p><p>For Compose, mount the user file with a small override (the multi-user reference already does this with a Docker secret):</p><div class="language-yaml"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">yaml</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">services</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">:</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">  kkss</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">:</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">    environment</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">:</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">      KKSS_AUTH_USERS_FILE</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">: </span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">/run/secrets/users</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">    secrets</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">: [</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">users</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">]</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">secrets</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">:</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">  users</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">:</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#11782a",
		"--shiki-dark": "#85E89D"
	})}">    file</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">: </span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">./users.htpasswd</span></span></code></pre></div><p>Tags are the release version (<code>1.2.0</code>, …) plus a <code>latest</code> alias. Pin a version with <code>KKSS_TAG</code> (compose) or by using the full tag in <code>docker run</code>.</p><p>The default image keeps the desktop image lean and uses app-local <code>uv</code> for the Kratos MCP server when it is available. Releases also publish an amd64-only <code>&lt;version&gt;-kratos</code> variant with Python 3.12, Kratos 10.4.3, the pinned MCP server, and the five supported application wheels preinstalled. It runs without package downloads; use it on an x86-64 host when browser sessions need the solver environment.</p><h2 id="where-it-runs" tabindex="-1">Where it runs <a class="header-anchor" href="#where-it-runs" aria-label="Permalink to “Where it runs”">​</a></h2><p>The image is <strong>multi-stage</strong>: one stage builds and packages the app, and the final image carries only that packaged output plus the X/VNC stack — no npm, no source tree, and none of the submodules&#39; build dependencies. That puts it at about <strong>2 GB</strong> (linux/amd64), down from 5.5 GB before the split. It runs as the unprivileged <code>kkss</code> user (uid 1000), not root, and the app&#39;s own files are root-owned so the running process cannot modify them.</p><h2 id="environment-variables" tabindex="-1">Environment variables <a class="header-anchor" href="#environment-variables" aria-label="Permalink to “Environment variables”">​</a></h2><p>Container settings — set with <code>-e</code> on <code>docker run</code>, or in the <code>environment:</code> block of either compose file:</p><table tabindex="0"><thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead><tbody><tr><td><code>DISPLAY_SIZE</code></td><td><code>1920x1080</code></td><td>Virtual screen geometry, fixed per container start</td></tr><tr><td><code>KKSS_AUTH_USERS_FILE</code></td><td><em>(unset)</em></td><td>Newline-separated <code>user:bcrypt-hash</code> entries; mount this as a Docker secret</td></tr><tr><td><code>KKSS_OIDC_ISSUER</code></td><td><em>(unset)</em></td><td>OIDC issuer; pair with client ID/secret and an email/group allowlist</td></tr><tr><td><code>KKSS_PUBLIC_URL</code></td><td><code>http://localhost:6080</code></td><td>Public origin used for OIDC callbacks and TLS selection</td></tr><tr><td><code>KKSS_IDLE_TIMEOUT</code></td><td><code>0</code></td><td>Disconnected idle timeout in seconds; tracked jobs and uploads inhibit it</td></tr><tr><td><code>KKSS_BASE_PATH</code></td><td><em>(empty)</em></td><td>URL prefix used when a reverse proxy mounts KKSS below a path</td></tr><tr><td><code>KKSS_GPU</code></td><td><code>0</code></td><td>Set to <code>1</code> only with the Intel/AMD <code>/dev/dri</code> overlay</td></tr><tr><td><code>KKSS_DISPLAY_BACKEND</code></td><td><code>xvfb</code></td><td><code>tigervnc</code> enables remote desktop resize after hardware validation; one active viewer is allowed</td></tr><tr><td><code>OPEN_FILE</code></td><td><em>(unset)</em></td><td>Absolute container path of a file to open at launch (for example <code>/workspace/model.mdpa</code>)</td></tr><tr><td><code>NOVNC_PORT</code></td><td><code>6080</code></td><td>Port noVNC listens on inside the container</td></tr></tbody></table><p>The LLM and application overlay accepts <code>KKSS_LLM_PROVIDER</code>, <code>KKSS_LLM_MODEL</code>, <code>KKSS_LLM_BASE_URL</code>, <code>KKSS_LLM_API_KEY_FILE</code>, <code>KKSS_CODEX_EXECUTABLE</code>, and <code>KKSS_CLAUDE_CODE_EXECUTABLE</code>, <code>KKSS_PROJECT_ROOT</code>, <code>KKSS_RESTORE_SESSION</code>, <code>KKSS_THEME</code> (3D scene), <code>KKSS_UI_THEME</code> (<code>system</code>/<code>dark</code>/<code>light</code>/<code>hcDark</code>/<code>hcLight</code>), <code>KKSS_ZOOM</code>, <code>KKSS_META_ENABLED</code>, <code>KKSS_META_PORT</code>, and <code>KKSS_META_TOKEN_FILE</code>. Secret files must be mounted read-only into the container. The gateway never logs their contents; the application does not write them to <code>state.json</code>.</p><p>Compose settings — read from your shell (or a <code>.env</code> file beside the compose file), not from the container:</p><table tabindex="0"><thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead><tbody><tr><td><code>KKSS_PORT</code></td><td><code>6080</code></td><td>Host port published for noVNC</td></tr><tr><td><code>KKSS_TAG</code></td><td><code>latest</code></td><td>Image tag (GHCR compose file only)</td></tr><tr><td><code>KKSS_WORKSPACE</code></td><td><code>./mesh/example</code> / named volume</td><td>Host path or named volume mounted at <code>/workspace</code></td></tr><tr><td><code>KKSS_DISPLAY_SIZE</code></td><td><code>1920x1080</code></td><td>Passed through as <code>DISPLAY_SIZE</code></td></tr></tbody></table><p>To serve on a different host port, for example 8080:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">KKSS_PORT</span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">=</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">8080</span><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}"> docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> compose</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -f</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> docker-compose.ghcr.yml</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> up</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -d</span></span></code></pre></div><div class="language-powershell"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">powershell</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">\$</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">env:</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">KKSS_PORT </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">=</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> &quot;8080&quot;</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">docker compose </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-f</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}"> docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">compose.ghcr.yml up </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">d</span></span></code></pre></div><h2 id="files-and-volumes" tabindex="-1">Files and volumes <a class="header-anchor" href="#files-and-volumes" aria-label="Permalink to “Files and volumes”">​</a></h2><p>The in-app file dialogs browse the <strong>container</strong> filesystem, not your host. Mount the data you want to work on at <code>/workspace</code>:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">KKSS_WORKSPACE</span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">=</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">/path/to/your/simulations</span><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}"> docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> compose</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -f</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> docker-compose.ghcr.yml</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> up</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -d</span></span></code></pre></div><div class="language-powershell"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">powershell</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">\$</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">env:</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">KKSS_WORKSPACE </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">=</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> &quot;C:\\path\\to\\your\\simulations&quot;</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">docker compose </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-f</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}"> docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">compose.ghcr.yml up </span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}">-</span><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">d</span></span></code></pre></div><p>The same variable also accepts a named volume (a bare word rather than a path), which is the GHCR file&#39;s default since there is no checkout to point at; the build compose file defaults to the repo&#39;s <code>mesh/example/</code> so there is something to open out of the box.</p><p>App settings (<code>state.json</code> — theme, zoom, LLM provider, …) persist across restarts through a named volume at <code>/home/kkss/.config/kkss</code>. Operator-managed values such as <code>KKSS_LLM_API_KEY_FILE</code>, <code>KKSS_PROJECT_ROOT</code>, <code>KKSS_RESTORE_SESSION</code>, <code>KKSS_THEME</code>, <code>KKSS_UI_THEME</code>, <code>KKSS_ZOOM</code>, and <code>KKSS_META_*</code> override the stored value, are shown as “set by the environment” in Settings, and are never written to that volume. A trusted session user can still inspect runtime environment values from the embedded terminal; hiding an operator key from an untrusted user requires an external LLM gateway.</p><div class="warning custom-block"><p class="custom-block-title">Upgrading from 1.1.0 or earlier</p><p>The container used to run as root and kept its settings in <code>/root/.config/kkss</code>. It now runs as the unprivileged <code>kkss</code> user, so the path moved. To carry old settings over:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> run</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --rm</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -v</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> kkss_kkss-userdata:/from</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -v</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> kkss_kkss-userdata-new:/to</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> \\</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}">  alpine</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> sh</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -c</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> &#39;cp -a /from/. /to/&#39;</span></span></code></pre></div><p>then point the volume at the new name — or just let it start fresh, since the only loss is UI preferences and any stored API key.</p></div><h2 id="access-from-another-machine" tabindex="-1">Access from another machine <a class="header-anchor" href="#access-from-another-machine" aria-label="Permalink to “Access from another machine”">​</a></h2><p>The compose files publish on localhost by default. Keep that binding for a private deployment. To allow another machine on the same network, override the port mapping in a Compose override (for example <code>0.0.0.0:\${KKSS_PORT:-6080}:6080</code>) and put TLS and an operator-managed login in front of it:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">hostname</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> -I</span><span style="${ssrRenderStyle({
		"--shiki-light": "#c62739",
		"--shiki-dark": "#F97583"
	})}"> |</span><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}"> awk</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> &#39;{print \$1}&#39;</span><span style="${ssrRenderStyle({
		"--shiki-light": "#62687b",
		"--shiki-dark": "#818e99"
	})}">   # Linux/macOS</span></span></code></pre></div><div class="language-powershell"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">powershell</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#24292E",
		"--shiki-dark": "#E1E4E8"
	})}">ipconfig     </span><span style="${ssrRenderStyle({
		"--shiki-light": "#62687b",
		"--shiki-dark": "#818e99"
	})}"># use the IPv4 Address of your active adapter</span></span></code></pre></div><p>Then browse to <code>http://&lt;that-ip&gt;:6080/</code> — using your own address, not the example. Sign in before opening the desktop; the embedded terminal is available to authenticated session users.</p><h2 id="troubleshooting" tabindex="-1">Troubleshooting <a class="header-anchor" href="#troubleshooting" aria-label="Permalink to “Troubleshooting”">​</a></h2><ul><li><p><strong><code>docker: command not found</code> / &quot;the daemon is not running&quot;</strong> — install Docker Desktop (or Docker Engine) and make sure it is started.</p></li><li><p><strong>&quot;port is already allocated&quot;</strong> — something else holds 6080; start with <code>KKSS_PORT=8080</code> and open that port instead.</p></li><li><p><strong>The page loads but stays black, or <em>Connect</em> fails</strong> — give it a moment on first start; the app boots before the stream is useful. If it persists, <code>docker logs kkss</code> shows the entrypoint&#39;s output, and this reports whether the container considers itself healthy:</p><div class="language-bash"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">docker</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> inspect</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --format</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> &#39;{{.State.Health.Status}}&#39;</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> kkss</span></span></code></pre></div></li><li><p><strong>The container keeps restarting</strong> — usually the WebGL renderer crashing under software rendering on a constrained host. Check <code>docker logs</code>, and try a smaller model or a smaller <code>DISPLAY_SIZE</code>.</p></li><li><p><strong>Old version keeps running</strong> — <code>docker compose down</code> then <code>docker compose -f docker-compose.ghcr.yml pull</code> before starting again; <code>latest</code> is only re-pulled explicitly.</p></li><li><p><strong><code>/workspace</code> is empty or read-only</strong> — check the path you mounted exists on the host. The container runs as uid 1000; a host directory owned by a different uid may need its permissions widened for writes.</p></li></ul><h2 id="caveats" tabindex="-1">Caveats <a class="header-anchor" href="#caveats" aria-label="Permalink to “Caveats”">​</a></h2><ul><li><strong>The embedded terminal is a real shell inside the container.</strong> Anyone who can reach an authenticated desktop can run commands in the container. It is an unprivileged shell (uid 1000, and the app&#39;s own files are root-owned and not writable by it), but it still reads and writes everything under <code>/workspace</code>. Keep the default localhost bind for a private deployment, or use TLS and an operator-managed local/OIDC login before publishing it.</li><li><strong>The base image&#39;s Kratos MCP server needs a runtime.</strong> It uses the ordinary app-local <code>uv</code> discovery path and does not download packages during image startup. Use the amd64 <code>-kratos</code> variant when an offline, preinstalled solver environment is required; the CAD and mesh tool servers are built in to both.</li><li><strong>Chat API keys:</strong> inside the container there is no OS keychain, so Electron&#39;s <code>safeStorage</code> falls back to basic (plaintext-equivalent) encryption of the stored key. Treat the userdata volume accordingly.</li><li><strong>File Browser maintenance:</strong> the pinned v2.63.23 companion is the final upstream release, which was archived on 2026-09-01. Keep it behind the KKSS gateway, leave command execution disabled, and review or replace the companion before exposing file transfer to an untrusted network.</li><li><strong>Software rendering:</strong> the default viewers run on SwiftShader (no GPU). Small and medium models are fine; very large meshes render slowly. On weak hosts the WebGL renderer can occasionally crash mid-frame — the Compose service restarts on failure; reload the browser tab.</li><li><strong>Display size:</strong> Xvfb keeps the existing fixed <code>DISPLAY_SIZE</code> behavior. <code>docker-compose.gpu.yml</code> selects the separately validated TigerVNC/EGL path, where <code>resizeSession</code> can request a new desktop size. Both VNC backends reject a second viewer while preserving the first connection. Treat that overlay as hardware-dependent until its Intel/AMD runner passes the rendering checks.</li><li><strong>Clipboard</strong> works through the noVNC sidebar panel, not the native Ctrl+C/Ctrl+V bridge.</li></ul><h2 id="licenses" tabindex="-1">Licenses <a class="header-anchor" href="#licenses" aria-label="Permalink to “Licenses”">​</a></h2><p>The image additionally distributes x11vnc (GPL-2.0) and noVNC (MPL-2.0), both compatible with distributing alongside the AGPL-3.0-or-later application.</p><h2 id="multi-user-reference-deployment" tabindex="-1">Multi-user reference deployment <a class="header-anchor" href="#multi-user-reference-deployment" aria-label="Permalink to “Multi-user reference deployment”">​</a></h2><p>The reference broker is deliberately operator-facing rather than a hosted service. Build <code>docker-compose.multi.yml</code> with a bcrypt users file and a Docker socket mount restricted to the broker. It applies one-running-session-per-user and ten-running-sessions-global defaults, persists session metadata under <code>broker-data</code>, reconciles labeled containers after restart, and never deletes a workspace when a session is stopped. Each desktop gets a companion File Browser at <code>/files/</code>; execution is disabled and external symlinks are rejected.</p><p>For clusters, <code>docker/web/kubernetes.go</code> uses the in-cluster service account to create a Pod, Service, PVCs and Secret with <code>runAsNonRoot</code>, dropped capabilities, resource limits and no service-account token in the user Pod. Apply equivalent namespace-scoped RBAC and network policy in the operator&#39;s cluster before using that reference backend.</p><p>The Kratos image is a separate amd64 build target (<code>runtime-kratos</code>). It pins Kratos 10.4.3 and <code>kratos-mcp-server</code> 0.5.0 with a hash-locked wheel set; the base multi-architecture image remains solver-free. <code>tools/lock-kratos.sh</code> regenerates the lock when these versions change.</p></div>`);
}
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("guide/web-deployment.md");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
var web_deployment_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
//#endregion
export { __pageData, web_deployment_default as default };
