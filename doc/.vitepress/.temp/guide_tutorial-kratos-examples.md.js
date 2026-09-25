import { t as _plugin_vue_export_helper_default } from "./plugin-vue_export-helper.BOaGB7Aw.js";
import { ssrRenderAttrs, ssrRenderStyle } from "vue/server-renderer";
import { useSSRContext } from "vue";
//#region guide/tutorial-kratos-examples.md
var __pageData = JSON.parse("{\"title\":\"Worked Kratos cases\",\"description\":\"\",\"frontmatter\":{},\"headers\":[],\"relativePath\":\"guide/tutorial-kratos-examples.md\",\"filePath\":\"guide/tutorial-kratos-examples.md\"}");
var _sfc_main = { name: "guide/tutorial-kratos-examples.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
	_push(`<div${ssrRenderAttrs(_attrs)}><h1 id="worked-kratos-cases" tabindex="-1">Worked Kratos cases <a class="header-anchor" href="#worked-kratos-cases" aria-label="Permalink to “Worked Kratos cases”">​</a></h1><p>These three small cases include their MDPA mesh, materials, solver parameters, runner, and VTK output from a completed Kratos solve. They start from an MDPA case so you can inspect real result fields in KKSS without first building a geometry or mesh.</p><p>The cases were rerun with Python 3.12 and Kratos Multiphysics 10.4.3 on Linux x86-64, using two OpenMP threads. The checked-in VTK files are the solver output from those runs. Each <code>MainKratos.py</code> reads the adjacent <code>ProjectParameters.json</code> and runs its AnalysisStage (or Kratos&#39; sequential orchestrator for the staged case).</p><p>To rerun a case, download or copy its directory to a writable location, then run it with a Python interpreter that can import the Kratos applications named in its parameters:</p><div class="language-sh"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">sh</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}">cd</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> cantilever</span></span>
<span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">python</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> MainKratos.py</span></span></code></pre></div><p>If you manage that interpreter with uv, select the existing Kratos Python explicitly:</p><div class="language-sh"><button title="Copy code" data-copied="Copied" class="copy"></button><span class="lang">sh</span><pre class="shiki shiki-themes github-light github-dark" style="${ssrRenderStyle({
		"--shiki-light": "#24292e",
		"--shiki-dark": "#e1e4e8",
		"--shiki-light-bg": "#fff",
		"--shiki-dark-bg": "#24292e"
	})}" tabindex="0" dir="ltr"><code><span class="line"><span style="${ssrRenderStyle({
		"--shiki-light": "#6F42C1",
		"--shiki-dark": "#B392F0"
	})}">uv</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> run</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --python</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> /path/to/kratos/python</span><span style="${ssrRenderStyle({
		"--shiki-light": "#005CC5",
		"--shiki-dark": "#79B8FF"
	})}"> --no-project</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> python</span><span style="${ssrRenderStyle({
		"--shiki-light": "#032F62",
		"--shiki-dark": "#9ECBFF"
	})}"> MainKratos.py</span></span></code></pre></div><p><code>uv</code> provides the runner; it does not by itself install Kratos or its applications. In KKSS, open <code>mesh.mdpa</code> in Post-Processing, run <code>MainKratos.py</code> from the embedded terminal, then open the generated VTK file to inspect the result. The supplied result file can be opened directly without rerunning.</p><h2 id="structural-cantilever" tabindex="-1">Structural cantilever <a class="header-anchor" href="#structural-cantilever" aria-label="Permalink to “Structural cantilever”">​</a></h2><p>This two-dimensional plane-strain model has 10 nodes and four quadrilateral elements. Its <code>left</code> SubModelPart is fixed, and its <code>right</code> SubModelPart carries a downward line load of 1 MN/m. The final VTK result reports a maximum vertical displacement of <code>-0.25312169 mm</code> at the free edge. The model uses SI units.</p><ul><li><a href="/KKSS/examples/kratos/cantilever/mesh.mdpa">Mesh</a></li><li><a href="/KKSS/examples/kratos/cantilever/Materials.json">Materials</a></li><li><a href="/KKSS/examples/kratos/cantilever/ProjectParameters.json">Project parameters</a></li><li><a href="/KKSS/examples/kratos/cantilever/MainKratos.py">MainKratos.py</a></li><li><a href="/KKSS/examples/kratos/cantilever/vtk_output/Structure_0_1.vtk">Solver-produced VTK result</a></li></ul><h2 id="lid-driven-cavity" tabindex="-1">Lid-driven cavity <a class="header-anchor" href="#lid-driven-cavity" aria-label="Permalink to “Lid-driven cavity”">​</a></h2><p>This two-dimensional monolithic fluid case has 121 nodes and 200 elements. Its included final output is at time 30 and contains <code>VELOCITY</code> and <code>PRESSURE</code> fields; the measured maximum speed in that result is <code>1.0</code> in the case&#39;s velocity units.</p><ul><li><a href="/KKSS/examples/kratos/lid_driven_cavity/mesh.mdpa">Mesh</a></li><li><a href="/KKSS/examples/kratos/lid_driven_cavity/Materials.json">Materials</a></li><li><a href="/KKSS/examples/kratos/lid_driven_cavity/ProjectParameters.json">Project parameters</a></li><li><a href="/KKSS/examples/kratos/lid_driven_cavity/MainKratos.py">MainKratos.py</a></li><li><a href="/KKSS/examples/kratos/lid_driven_cavity/vtk_output/FluidModelPart_0_30.vtk">Final VTK result</a></li></ul><h2 id="two-stage-structural-load" tabindex="-1">Two-stage structural load <a class="header-anchor" href="#two-stage-structural-load" aria-label="Permalink to “Two-stage structural load”">​</a></h2><p>This structural case has two stages on the same 55-node, 40-element mesh. The second stage doubles the line load. The solver-produced results show maximum vertical displacement magnitudes of <code>0.39978517 mm</code> and <code>0.79957047 mm</code> for stages one and two.</p><ul><li><a href="/KKSS/examples/kratos/multistage_load_steps/mesh.mdpa">Mesh</a></li><li><a href="/KKSS/examples/kratos/multistage_load_steps/Materials.json">Materials</a></li><li><a href="/KKSS/examples/kratos/multistage_load_steps/ProjectParameters.json">Project parameters</a></li><li><a href="/KKSS/examples/kratos/multistage_load_steps/MainKratos.py">MainKratos.py</a></li><li><a href="/KKSS/examples/kratos/multistage_load_steps/vtk_stage_1/Structure_0_1.vtk">Stage one result</a></li><li><a href="/KKSS/examples/kratos/multistage_load_steps/vtk_stage_2/Structure_0_1.vtk">Stage two result</a></li></ul><p>The case inputs are from <code>kratos-mcp-server</code> 0.3.0; its MIT license and attribution are included in <code>doc/public/examples/kratos/</code>. The reported results are generated output, not analytical references or a claim of formal solver validation.</p></div>`);
}
var _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
	const ssrContext = useSSRContext();
	(ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("guide/tutorial-kratos-examples.md");
	return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
var tutorial_kratos_examples_default = /*#__PURE__*/ _plugin_vue_export_helper_default(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
//#endregion
export { __pageData, tutorial_kratos_examples_default as default };
