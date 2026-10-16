# Kratos applications this case needs; checked before anything is read or written.
import importlib.util as _kkss_find
import sys as _kkss_sys

_KKSS_REQUIRED_APPLICATIONS = ["CoSimulationApplication","FluidDynamicsApplication","MappingApplication","MeshMovingApplication","StructuralMechanicsApplication"]


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
import json
import math

import KratosMultiphysics
from KratosMultiphysics.CoSimulationApplication.co_simulation_analysis import CoSimulationAnalysis

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

KKSS_ADAPTER = "kkss.cosim-convergence"


class KkssCoSimObserver:
    def __init__(self, solver):
        self.solver = solver
        self.criteria = list(getattr(solver, "convergence_criteria_list", None) or [])
        self.strong = len(self.criteria) > 0
        self.begin()
        for index, wrapper in enumerate(self.criteria):
            outer = getattr(wrapper, "IsConverged", None)
            if callable(outer):
                def counted(*args, _index=index, _outer=outer, **kwargs):
                    if _index == 0:
                        self._close_iteration()
                        self.iterations += 1
                    return _outer(*args, **kwargs)
                wrapper.IsConverged = counted
            inner = getattr(wrapper, "conv_crit", None)
            original = getattr(inner, "IsConverged", None)
            if callable(original):
                def checked(residual, current_data, *args, _index=index, _original=original, **kwargs):
                    self._observe(_index, residual)
                    return _original(residual, current_data, *args, **kwargs)
                inner.IsConverged = checked

    def begin(self):
        self.iterations = 0
        self.residuals = []
        self.current = None

    def _observe(self, index, residual):
        try:
            import numpy
            values = numpy.asarray(residual, dtype=float)
            norm = KkssFinite(float(numpy.linalg.norm(values)) / math.sqrt(values.size)) if values.size else None
        except Exception:
            norm = None
        if norm is not None:
            self.current = norm if self.current is None else max(self.current, norm)

    def _close_iteration(self):
        if self.iterations > 0:
            self.residuals.append(self.current)
        self.current = None

    def collect(self):
        self._close_iteration()
        self.iterations, done = 0, self.iterations
        return done

    def parameters(self):
        out = {}
        count = getattr(self.solver, "num_coupling_iterations", None)
        if isinstance(count, int):
            out["num_coupling_iterations"] = count
        if self.criteria:
            inner = getattr(self.criteria[0], "conv_crit", None)
            for name in ("abs_tolerance", "rel_tolerance"):
                value = KkssFinite(getattr(inner, name, None))
                if value is not None:
                    out[name] = value
        return out

class CoSimulationAnalysisWithStop(CoSimulationAnalysis):

    def Initialize(self):
        super().Initialize()
        self._kkss_observer = KkssCoSimObserver(self._GetSolver())

    def SolveSolutionStep(self):
        observer = self._kkss_observer
        observer.begin()
        try:
            result = super().SolveSolutionStep()
        except Exception as error:
            self._kkss_write_step(observer, None, error)
            raise
        self._kkss_write_step(observer, result)
        return result

    def _kkss_write_step(self, observer, result, error=None):
        iterations = observer.collect()
        solver_result = result if isinstance(result, bool) else None
        if observer.strong:
            criterion = "relative_norm_previous_residual"
            converged = solver_result if error is None else None
            unavailable = "The coupled solver's criteria did not expose a readable residual."
        else:
            criterion = "none (weak coupling)"
            converged = None
            iterations = 1
            unavailable = "Weak coupling exchanges the interface data once per step and evaluates no convergence criterion."
        KkssCouplingRecord(self.step, self.time, converged, solver_result, criterion, observer.residuals, iterations,
                           observer.parameters(), "The largest |r|/sqrt(n) over the coupled solver's convergence criteria at each coupling iteration, r the change of the coupled interface data; residual is the last iteration. Physical units are undeclared.", unavailable, error)

    def Finalize(self):
        super().Finalize()
        KkssWriteRecord(KKSS_ADAPTER, {"event": "end", "completed": True})

    def KeepAdvancingSolutionLoop(self):
        if not super().KeepAdvancingSolutionLoop():
            return False
        if StopRequested():
            # Leaving the loop here runs the normal Finalize, which closes the
            # last result file instead of truncating it.
            print("[stop requested - finalizing]")
            sys.stdout.flush()
            return False
        return True

if __name__ == "__main__":

    KkssResetConvergence()

    with open("ProjectParametersCoSim.json", 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    simulation = CoSimulationAnalysisWithStop(parameters)
    simulation.Run()
