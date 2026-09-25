import { ssrInterpolate, ssrRenderAttr, ssrRenderAttrs, ssrRenderList, ssrRenderStyle } from "vue/server-renderer";
import { computed, onMounted, ref, useSSRContext } from "vue";
//#region download.md
var __pageData = JSON.parse("{\"title\":\"Download\",\"description\":\"\",\"frontmatter\":{\"title\":\"Download\"},\"headers\":[],\"relativePath\":\"download.md\",\"filePath\":\"download.md\"}");
var _sfc_main = /*@__PURE__*/ Object.assign({ name: "download.md" }, {
	__ssrInlineRender: true,
	setup(__props) {
		const rel = ref(null);
		const failed = ref(false);
		const targets = [
			{
				icon: "/os/linux.svg",
				label: "Linux",
				arch: "x86-64",
				key: "-linux-x64.",
				note: "AppImage, .deb or .rpm"
			},
			{
				icon: "/os/linux.svg",
				label: "Linux",
				arch: "ARM 64",
				key: "-linux-arm64.",
				note: "AppImage, .deb or .rpm"
			},
			{
				icon: "/os/windows.svg",
				label: "Windows",
				arch: "x86-64",
				key: "-win-x64.",
				note: "NSIS installer"
			},
			{
				icon: "/os/windows.svg",
				label: "Windows",
				arch: "ARM 64",
				key: "-win-arm64.",
				note: "NSIS installer"
			},
			{
				icon: "/os/macos.svg",
				label: "macOS",
				arch: "Apple Silicon (ARM 64)",
				key: "-mac-arm64.",
				note: ".dmg (or .zip)"
			}
		];
		const rows = computed(() => targets.map((t) => ({
			...t,
			assets: (rel.value?.assets ?? []).filter((a) => a.name.includes(t.key) && !a.name.endsWith(".blockmap"))
		})));
		function mb(bytes) {
			return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
		}
		onMounted(async () => {
			try {
				const res = await fetch("https://api.github.com/repos/loumalouomega/KKSS/releases/latest");
				if (!res.ok) throw new Error(String(res.status));
				rel.value = await res.json();
			} catch {
				failed.value = true;
			}
		});
		return (_ctx, _push, _parent, _attrs) => {
			_push(`<div${ssrRenderAttrs(_attrs)}><h1 id="download-kkss" tabindex="-1">Download KKSS <a class="header-anchor" href="#download-kkss" aria-label="Permalink to “Download KKSS”">​</a></h1><p>KKSS is built for every release tag by the <a href="https://github.com/loumalouomega/KKSS/blob/master/.github/workflows/release.yml" target="_blank" rel="noreferrer">release workflow</a> and published to <a href="https://github.com/loumalouomega/KKSS/releases" target="_blank" rel="noreferrer">GitHub Releases</a>.</p>`);
			if (rel.value) {
				_push(`<p> Latest release: <a${ssrRenderAttr("href", rel.value.html_url)}><strong>${ssrInterpolate(rel.value.tag_name)}</strong></a>`);
				if (rel.value.published_at) _push(`<span> · ${ssrInterpolate(new Date(rel.value.published_at).toLocaleDateString())}</span>`);
				else _push(`<!---->`);
				_push(`</p>`);
			} else if (failed.value) _push(`<p> Could not query the GitHub API from your browser — grab the installers directly from the <a${ssrRenderAttr("href", "https://github.com/loumalouomega/KKSS/releases/latest")}><strong>latest release page</strong></a>. </p>`);
			else _push(`<p>Loading the latest release…</p>`);
			_push(`<table><thead><tr><th>Platform</th><th>Architecture</th><th>Files</th></tr></thead><tbody><!--[-->`);
			ssrRenderList(rows.value, (t) => {
				_push(`<tr><td><img${ssrRenderAttr("src", t.icon)} alt="" width="22" height="22" style="${ssrRenderStyle({
					"vertical-align": "middle",
					"margin-right": "7px"
				})}"> ${ssrInterpolate(t.label)}</td><td>${ssrInterpolate(t.arch)}</td><td>`);
				if (t.assets.length) {
					_push(`<!--[-->`);
					ssrRenderList(t.assets, (a) => {
						_push(`<div><a${ssrRenderAttr("href", a.browser_download_url)}>${ssrInterpolate(a.name)}</a> (${ssrInterpolate(mb(a.size))}) </div>`);
					});
					_push(`<!--]-->`);
				} else _push(`<!--[-->${ssrInterpolate(t.note)} — see the <a${ssrRenderAttr("href", "https://github.com/loumalouomega/KKSS/releases/latest")}>release page</a><!--]-->`);
				_push(`</td></tr>`);
			});
			_push(`<!--]--></tbody></table><div class="tip custom-block"><p class="custom-block-title">Which file do I want?</p><ul><li><strong>Linux</strong>: the <code>.AppImage</code> runs anywhere without installation (<code>chmod +x</code> it); <code>.deb</code> integrates with apt-based distributions and <code>.rpm</code> with Fedora/openSUSE package tools. Updates to installed packages are manual.</li><li><strong>Windows</strong>: the <code>.exe</code> is a standard NSIS installer (choose your install directory during setup).</li><li><strong>macOS</strong>: open the <code>.dmg</code> and drag KKSS to Applications. Release builds are currently <strong>unsigned</strong> — right-click the app and choose <em>Open</em> the first time to bypass Gatekeeper.</li></ul></div><p>Older versions and release notes live on the <a href="https://github.com/loumalouomega/KKSS/releases" target="_blank" rel="noreferrer">releases page</a>.</p></div>`);
		};
	}
});
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("download.md");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
//#endregion
export { __pageData, _sfc_main as default };
