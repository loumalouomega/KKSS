import { t as _plugin_vue_export_helper_default } from "./plugin-vue_export-helper.BOaGB7Aw.js";
import { ssrRenderAttrs } from "vue/server-renderer";
import { useSSRContext } from "vue";
//#region public/examples/kratos/NOTICE.md
var __pageData = JSON.parse("{\"title\":\"\",\"description\":\"\",\"frontmatter\":{},\"headers\":[],\"relativePath\":\"public/examples/kratos/NOTICE.md\",\"filePath\":\"public/examples/kratos/NOTICE.md\"}");
var _sfc_main = { name: "public/examples/kratos/NOTICE.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
	_push(`<div${ssrRenderAttrs(_attrs)}><p>The <code>cantilever</code>, <code>lid_driven_cavity</code>, and <code>multistage_load_steps</code> input cases are from <code>kratos-mcp-server</code> 0.3.0, Copyright (c) 2026 Vicente Mataix Ferrándiz, and are distributed under the MIT License in this directory. Their VTK result files were generated locally with Kratos Multiphysics 10.4.3. <code>MainKratos.py</code> is a KKSS example runner using the standard Kratos Python API.</p></div>`);
}
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("public/examples/kratos/NOTICE.md");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
var NOTICE_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
//#endregion
export { __pageData, NOTICE_default as default };
