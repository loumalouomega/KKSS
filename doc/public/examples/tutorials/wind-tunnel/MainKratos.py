# Kratos applications this case needs; checked before anything is read or written.
import importlib.util as _kkss_find
import sys as _kkss_sys

_KKSS_REQUIRED_APPLICATIONS = ["FluidDynamicsApplication","RANSApplication"]


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

def CreateAnalysisStageWithFlushInstance(cls, global_model, parameters):
    class AnalysisStageWithFlush(cls):

        def __init__(self, model, project_parameters, flush_frequency=10.0):
            super().__init__(model, project_parameters)
            self.flush_frequency = flush_frequency
            self.last_flush = time.time()
            sys.stdout.flush()

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

    with open("ProjectParameters.json", 'r') as parameter_file:
        parameters = KratosMultiphysics.Parameters(parameter_file.read())

    analysis_stage_module_name = parameters["analysis_stage"].GetString()
    analysis_stage_class_name = analysis_stage_module_name.split('.')[-1]
    # Acronym stages: title-casing gives RansAnalysis, but the class is RANSAnalysis.
    analysis_stage_class_name = {"rans_analysis": "RANSAnalysis"}.get(
        analysis_stage_class_name,
        ''.join(x.title() for x in analysis_stage_class_name.split('_')))

    analysis_stage_module = importlib.import_module(analysis_stage_module_name)
    analysis_stage_class = getattr(analysis_stage_module, analysis_stage_class_name)

    global_model = KratosMultiphysics.Model()
    simulation = CreateAnalysisStageWithFlushInstance(analysis_stage_class, global_model, parameters)
    simulation.Run()
