# Kratos applications this case needs; checked before anything is read or written.
import importlib.util as _kkss_find
import sys as _kkss_sys

_KKSS_REQUIRED_APPLICATIONS = ["FSIApplication","FluidDynamicsApplication","MappingApplication","MeshMovingApplication","StructuralMechanicsApplication"]


def _kkss_missing_applications():
    if _kkss_find.find_spec("KratosMultiphysics") is None:
        return ["KratosMultiphysics"]
    missing = []
    for name in _KKSS_REQUIRED_APPLICATIONS:
        try:
            found = _kkss_find.find_spec("KratosMultiphysics." + name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(name)
    return missing


_kkss_missing = _kkss_missing_applications()
if _kkss_missing:
    print("Missing Kratos applications: " + ", ".join(_kkss_missing), file=_kkss_sys.stderr)
    print("Install them (pip install Kratos<Name>, e.g. KratosFluidDynamicsApplication) or point kratos.installPath at a build that has them.", file=_kkss_sys.stderr)
    _kkss_sys.exit(3)

import sys
import os
import time
import importlib
import json
import math

import KratosMultiphysics

def StopRequested():
    # Cooperative stop: the launcher names a file (KRATOS_PREVIEW_STOP_FILE) and
    # the run it addresses (KRATOS_PREVIEW_RUN_ID). Only a file holding THIS
    # run's id counts, so a leftover from an earlier run cannot stop this one.
    # Standalone launches set neither variable and this is a no-op.
    stop_file = os.environ.get("KRATOS_PREVIEW_STOP_FILE")
    run_id = os.environ.get("KRATOS_PREVIEW_RUN_ID")
    if not stop_file or not run_id:
        return False
    try:
        with open(stop_file, "r") as handle:
            return handle.read().strip() == run_id
    except OSError:
        return False

KKSS_CONVERGENCE_FILE = "kkss-convergence-v2.jsonl"


def KkssConvergencePath():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), KKSS_CONVERGENCE_FILE)


def KkssResetConvergence():
    try:
        os.remove(KkssConvergencePath())
    except FileNotFoundError:
        pass


def KkssFinite(value):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def KkssRuntime():
    try:
        version = KratosMultiphysics.KratosGlobals.Kernel.Version()
    except Exception:
        version = "unavailable"
    return {"kratosVersion": version, "pythonVersion": sys.version.split()[0]}


def KkssWriteRecord(adapter, record):
    record.update({"adapter": adapter, "version": 2})
    with open(KkssConvergencePath(), "a", encoding="utf-8") as monitor:
        monitor.write(json.dumps(record, sort_keys=True, allow_nan=False) + "\n")
        monitor.flush()


def KkssCouplingRecord(step, time, converged, solver_result, criterion, residuals, iterations, parameters, definition, unavailable, error=None):
    # One coupled solve step. `converged` is the coupled solver's own answer
    # (None when no criterion was evaluated); `residuals` holds one value per
    # coupling iteration, None where it could not be read.
    record = {
        "event": "step",
        "iteration": int(step),
        "time": float(time),
        "converged": converged,
        "solverStepResult": solver_result,
        "analysisType": "coupled",
        "criterion": criterion,
        "residualDefinition": definition,
        "runtime": KkssRuntime(),
        "couplingResiduals": residuals,
    }
    if iterations is not None:
        record["nonlinearIteration"] = int(iterations)
    if parameters:
        record["criterionParameters"] = parameters
    last = residuals[-1] if residuals else None
    if last is not None:
        record["residual"] = last
    else:
        record["residualUnavailableReason"] = unavailable
    if error is not None:
        record["error"] = str(error)
    KkssWriteRecord(KKSS_ADAPTER, record)

KKSS_ADAPTER = "kkss.fsi-convergence"


class KkssFsiObserver:
    def __init__(self, solver):
        self.solver = solver
        self.residuals = []
        self.wrapped = False
        original = getattr(solver, "_CheckFSIConvergence", None)
        if callable(original):
            def checked(nl_it, residual_norm, *args, **kwargs):
                result = original(nl_it, residual_norm, *args, **kwargs)
                self.residuals.append(self._normalised(residual_norm))
                return result
            solver._CheckFSIConvergence = checked
            self.wrapped = True

    def _normalised(self, residual_norm):
        try:
            dofs = self.solver._GetPartitionedFSIUtilities().GetInterfaceResidualSize(self.solver._GetStructureInterfaceSubmodelPart())
            return KkssFinite(float(residual_norm) / math.sqrt(dofs)) if dofs > 0 else None
        except Exception:
            return None

    def begin(self):
        self.residuals = []

    def parameters(self):
        out = {}
        try:
            coupling = self.solver.settings["coupling_settings"]
            if coupling.Has("nl_tol"):
                out["nl_tol"] = coupling["nl_tol"].GetDouble()
            if coupling.Has("nl_max_it"):
                out["nl_max_it"] = coupling["nl_max_it"].GetInt()
        except Exception:
            pass
        return out

def CreateAnalysisStageWithFlushInstance(cls, global_model, parameters):
    class AnalysisStageWithFlush(cls):

        def __init__(self, model, project_parameters, flush_frequency=10.0):
            super().__init__(model, project_parameters)
            self.flush_frequency = flush_frequency
            self.last_flush = time.time()
            sys.stdout.flush()

        def Initialize(self):
            super().Initialize()
            self._kkss_observer = KkssFsiObserver(self._GetSolver())
            self._kkss_steps = 0
            sys.stdout.flush()

        def SolveSolutionStep(self):
            observer = self._kkss_observer
            observer.begin()
            self._kkss_steps += 1
            try:
                result = super().SolveSolutionStep()
            except Exception as error:
                self._kkss_write_step(observer, None, error)
                raise
            self._kkss_write_step(observer, result)
            return result

        def _kkss_write_step(self, observer, result, error=None):
            try:
                info = self._GetSolver().GetComputingModelPart().ProcessInfo
                step, time = int(info[KratosMultiphysics.STEP]), float(info[KratosMultiphysics.TIME])
            except Exception:
                step, time = self._kkss_steps, float(getattr(self, "time", 0.0))
            solver_result = result if isinstance(result, bool) else None
            converged = solver_result if error is None else None
            unavailable = ("The FSI solver did not expose a readable interface residual."
                           if observer.wrapped else
                           "This FSIApplication does not expose _CheckFSIConvergence, so the coupling residual cannot be observed.")
            KkssCouplingRecord(step, time, converged, solver_result, "fsi_interface_residual", observer.residuals,
                               len(observer.residuals) if observer.wrapped else None, observer.parameters(),
                               "FSIApplication's interface displacement residual |res|/sqrt(nDOFS) at each coupling check (PartitionedFSIBaseSolver); residual is the last check. Physical units are undeclared.", unavailable, error)

        def Finalize(self):
            super().Finalize()
            KkssWriteRecord(KKSS_ADAPTER, {"event": "end", "completed": True})

        def FinalizeSolutionStep(self):
            super().FinalizeSolutionStep()

            if self.parallel_type == "OpenMP":
                now = time.time()
                if now - self.last_flush > self.flush_frequency:
                    sys.stdout.flush()
                    self.last_flush = now

        def KeepAdvancingSolutionLoop(self):
            if not super().KeepAdvancingSolutionLoop():
                return False
            if StopRequested():
                # Leaving the loop here runs the normal Finalize, which closes
                # the last result file instead of truncating it.
                print("[stop requested - finalizing]")
                sys.stdout.flush()
                return False
            return True

    return AnalysisStageWithFlush(global_model, parameters)

if __name__ == "__main__":

    KkssResetConvergence()

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
