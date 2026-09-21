"""Record distribution licenses and refuse unexpected solver license metadata."""
import importlib.metadata as m
import json
names = ['KratosMultiphysics', 'KratosStructuralMechanicsApplication',
         'KratosFluidDynamicsApplication', 'KratosConvectionDiffusionApplication',
         'KratosCompressiblePotentialFlowApplication', 'KratosShallowWaterApplication']
result = []
for name in names:
    dist = m.distribution(name)
    license_name = dist.metadata.get('License-Expression') or dist.metadata.get('License', '')
    if 'BSD' not in license_name:
        raise RuntimeError(f'Unreviewed license for {name}: {license_name}')
    result.append({'name': name, 'version': dist.version, 'license': license_name,
                   'notices': [str(p) for p in (dist.files or []) if 'license' in str(p).lower()]})
print(json.dumps(result, indent=2))
