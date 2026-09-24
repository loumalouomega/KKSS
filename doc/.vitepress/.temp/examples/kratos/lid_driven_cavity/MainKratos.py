"""Run this case with the Python environment configured for Kratos."""

from __future__ import annotations

import importlib
import inspect
import os
from pathlib import Path

import KratosMultiphysics as KM


def main() -> None:
    case_dir = Path(__file__).resolve().parent
    os.chdir(case_dir)
    parameters = KM.Parameters((case_dir / "ProjectParameters.json").read_text(encoding="utf-8"))

    if parameters.Has("orchestrator") and parameters.Has("stages"):
        from KratosMultiphysics.project import Project

        project = Project(parameters)
        entry = KM.Registry[project.GetSettings()["orchestrator"]["name"].GetString()]
        module = importlib.import_module(entry["ModuleName"])
        getattr(module, entry["ClassName"])(project).Run()
        return

    module = importlib.import_module(parameters["analysis_stage"].GetString())
    stages = [
        cls
        for _, cls in inspect.getmembers(module, inspect.isclass)
        if cls.__module__ == module.__name__ and cls.__name__.endswith("Analysis")
    ]
    if not stages:
        raise RuntimeError(f"No AnalysisStage class found in {module.__name__}")
    analysis = max(stages, key=lambda cls: len(cls.__mro__))
    analysis(KM.Model(), parameters).Run()


if __name__ == "__main__":
    main()
