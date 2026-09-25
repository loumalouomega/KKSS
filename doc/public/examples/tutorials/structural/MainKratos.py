import sys
import time
import importlib
import json
import os
import math

import KratosMultiphysics

def CreateAnalysisStageWithFlushInstance(cls, global_model, parameters):
    class AnalysisStageWithFlush(cls):

        def __init__(self, model, project_parameters, flush_frequency=10.0):
            super().__init__(model, project_parameters)
            self.flush_frequency = flush_frequency
            self.last_flush = time.time()
            sys.stdout.flush()

        def SolveSolutionStep(self):
            try:
                solver_result = super().SolveSolutionStep()
            except Exception as error:
                self._kkss_write_convergence(None, None, error)
                raise
            solver = self._GetSolver()
            settings = solver.settings
            analysis_type = settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"
            convergence = solver_result if analysis_type == "non_linear" and isinstance(solver_result, bool) else None
            self._kkss_write_convergence(convergence, solver_result if isinstance(solver_result, bool) else None)
            return solver_result

        def _kkss_monitor_record(self, record):
            record.update({"adapter": "kkss.structural-convergence", "version": 2})
            with open(os.path.join(os.path.dirname(__file__), "kkss-convergence-v2.jsonl"), "a", encoding="utf-8") as monitor:
                monitor.write(json.dumps(record, sort_keys=True, allow_nan=False) + "\n")
                monitor.flush()

        def _kkss_write_convergence(self, converged, solver_result, error=None):
            solver = self._GetSolver()
            info = solver.GetComputingModelPart().ProcessInfo
            settings = solver.settings
            analysis_type = settings["analysis_type"].GetString() if settings.Has("analysis_type") else "unavailable"
            criterion = settings["convergence_criterion"].GetString() if settings.Has("convergence_criterion") else "unavailable"
            record = {
                "event": "step",
                "iteration": int(info[KratosMultiphysics.STEP]),
                "time": float(info[KratosMultiphysics.TIME]),
                "converged": converged,
                "solverStepResult": solver_result,
                "analysisType": analysis_type,
                "criterion": criterion,
                "residualDefinition": "For residual_criterion: Kratos ResidualCriteria L2 norm of the free-DOF RHS divided by active DOF count; convergence_ratio is current/reference norm. Physical units are undeclared.",
                "runtime": {"kratosVersion": KratosMultiphysics.KratosGlobals.Kernel.Version(), "pythonVersion": sys.version.split()[0]},
            }
            for name in ["residual_relative_tolerance", "residual_absolute_tolerance", "displacement_relative_tolerance", "displacement_absolute_tolerance", "max_iteration"]:
                if settings.Has(name):
                    record.setdefault("criterionParameters", {})[name] = settings[name].GetDouble() if name != "max_iteration" else settings[name].GetInt()
            # Only ResidualCriteria owns these ProcessInfo values. Other
            # criteria may leave old values from a prior step in place.
            residual_criterion = analysis_type == "non_linear" and criterion.lower() == "residual_criterion"
            variables = [("nonlinearIteration", "NL_ITERATION_NUMBER")]
            if residual_criterion:
                variables = [("residual", "RESIDUAL_NORM"), ("convergenceRatio", "CONVERGENCE_RATIO")] + variables
            for key, name in variables:
                variable = getattr(KratosMultiphysics, name, None)
                if variable is not None and info.Has(variable):
                    value = float(info[variable])
                    if math.isfinite(value) and value >= 0:
                        record[key] = int(value) if key == "nonlinearIteration" else value
            if "residual" not in record:
                if analysis_type == "linear":
                    record["residualUnavailableReason"] = "The linear strategy completed without evaluating an iterative convergence criterion."
                elif criterion.lower() != "residual_criterion":
                    record["residualUnavailableReason"] = "The selected convergence criterion does not publish a residual norm."
                else:
                    record["residualUnavailableReason"] = "The solver did not publish RESIDUAL_NORM for this step."
            if error is not None:
                record["error"] = str(error)
            self._kkss_monitor_record(record)

        def Finalize(self):
            super().Finalize()
            self._kkss_monitor_record({"event": "end", "completed": True})

        def Initialize(self):
            super().Initialize()
            sys.stdout.flush()

        def FinalizeSolutionStep(self):
            super().FinalizeSolutionStep()

            if self.parallel_type == "OpenMP":
                now = time.time()
                if now - self.last_flush > self.flush_frequency:
                    sys.stdout.flush()
                    self.last_flush = now

    return AnalysisStageWithFlush(global_model, parameters)

if __name__ == "__main__":

    try:
        os.remove(os.path.join(os.path.dirname(__file__), "kkss-convergence-v2.jsonl"))
    except FileNotFoundError:
        pass

    with open("ProjectParameters.json", 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    analysis_stage_module_name = parameters["analysis_stage"].GetString()
    analysis_stage_class_name = analysis_stage_module_name.split('.')[-1]
    analysis_stage_class_name = ''.join(x.title() for x in analysis_stage_class_name.split('_'))

    analysis_stage_module = importlib.import_module(analysis_stage_module_name)
    analysis_stage_class = getattr(analysis_stage_module, analysis_stage_class_name)

    global_model = KratosMultiphysics.Model()
    simulation = CreateAnalysisStageWithFlushInstance(analysis_stage_class, global_model, parameters)
    simulation.Run()
