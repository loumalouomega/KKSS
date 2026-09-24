import { t as _plugin_vue_export_helper_default } from "./plugin-vue_export-helper.BOaGB7Aw.js";
import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
//#region guide/flatpak-probe.md
var __pageData = JSON.parse("{\"title\":\"Flatpak feasibility probe\",\"description\":\"\",\"frontmatter\":{},\"headers\":[],\"relativePath\":\"guide/flatpak-probe.md\",\"filePath\":\"guide/flatpak-probe.md\"}");
var _sfc_main = { name: "guide/flatpak-probe.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
	_push(`<div${ssrRenderAttrs(_attrs)}><h1 id="flatpak-feasibility-probe" tabindex="-1">Flatpak feasibility probe <a class="header-anchor" href="#flatpak-feasibility-probe" aria-label="Permalink to “Flatpak feasibility probe”">​</a></h1><p>Run <code>npm run build:app &amp;&amp; npm run flatpak:probe</code> on a Linux host with Flatpak installed. The probe checks that the unpacked <code>out/</code> tree contains Electron&#39;s workers and WASM, confirms the native <code>node-pty</code> module, and prints the sandbox permissions that still need to be narrowed.</p><p>KKSS currently ships <code>asar: false</code> because its worker threads and WASM loaders read files beside the main bundle. A Flatpak would need to preserve that layout and provide a reproducible node-pty build. Solver launchers such as <code>uv</code>, Kratos and OpenFOAM also need an explicit host or sandbox boundary. Until those contracts are tested in a real runtime, Flatpak remains an evaluation item and no Flatpak artifact is published.</p></div>`);
}
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("guide/flatpak-probe.md");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
var flatpak_probe_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
//#endregion
export { __pageData, flatpak_probe_default as default };
