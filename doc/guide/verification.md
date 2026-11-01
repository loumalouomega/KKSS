# Verification

Every geometry-to-results [tutorial](/guide/tutorial-geometry-to-results) records what was checked against what when its case was generated and solved. This page collects those records in one table. Each row is an asserted check with its limit; a check that cannot fail is not counted as evidence, and other measured values stay on the tutorial's own page. These are tutorial checks with the tolerances shown, not formal solver certification.

The table is generated from each case's published `verification.json` (`tools/tutorials/verificationPage.mjs`; `test/verificationPage.test.ts` fails when it drifts). Re-running the solves after a submodule bump is still manual: see `doc/roadmap.md`.

<!-- verification:table:begin -->

| Case | Check | Measured | Limit | Kratos | Mesh |
|---|---|---|---|---|---|
| cosim | `inlet_velocity_error_m_per_s` | 0 | ≤ 0.000001 | 10.4.3 | 561 nodes / 1436 cells |
| cosim | `outlet_pressure_error_Pa` | 0 | ≤ 0.000001 | 10.4.3 | 561 nodes / 1436 cells |
| cosim | `inlet_face_mean_m_per_s` | 0.01 | ≤ 0.02 | 10.4.3 | 561 nodes / 1436 cells |
| cosim | `ale_mass_balance_error` | 0.1955442 | ≤ 0.35 | 10.4.3 | 561 nodes / 1436 cells |
| cosim | `peak_structure_displacement_m` | 0.001555044 | ≥ 1e-7 | 10.4.3 | 561 nodes / 1436 cells |
| cosim | `peak_structure_displacement_limit_m` | 0.001555044 | ≤ 0.02 | 10.4.3 | 561 nodes / 1436 cells |
| eigen | `first_lateral_frequency_relative_error` | 0.03737617 | ≤ 0.1 | 10.4.3 | 1048 nodes / 3896 cells |
| eigen | `second_vertical_frequency_relative_error` | 0.004749856 | ≤ 0.1 | 10.4.3 | 1048 nodes / 3896 cells |
| fluid | `inlet_velocity_error_m_per_s` | 0 | ≤ 0.000001 | 10.4.3 | 945 nodes / 1766 cells |
| fluid | `outlet_pressure_error_Pa` | 0 | ≤ 0.000001 | 10.4.3 | 945 nodes / 1766 cells |
| fluid | `flux_imbalance_m2_per_s` | 2.399739e-10 | ≤ 0.001 | 10.4.3 | 945 nodes / 1766 cells |
| fluid | `obstacle_no_slip_speed_m_per_s` | 0 | ≤ 0.00002 | 10.4.3 | 945 nodes / 1766 cells |
| fluid | `near_wake_velocity_deficit_m_per_s` | 0.1047505 | ≥ 0.025 | 10.4.3 | 945 nodes / 1766 cells |
| fluid | `pressure_range_Pa` | 16.51441 | ≥ 0.05 | 10.4.3 | 945 nodes / 1766 cells |
| fsi | `inlet_profile_error_m_per_s` | 2.573965e-9 | ≤ 0.000001 | 10.4.3 | 5632 nodes / 10569 cells |
| fsi | `outlet_pressure_error_Pa` | 0 | ≤ 0.000001 | 10.4.3 | 5632 nodes / 10569 cells |
| fsi | `ale_area_balance_error` | 0.001502732 | ≤ 0.02 | 10.4.3 | 5632 nodes / 10569 cells |
| fsi | `tip_ux_peak_m_minimum` | 0.0779333 | ≥ 0.03 | 10.4.3 | 5632 nodes / 10569 cells |
| fsi | `tip_ux_peak_vs_published_error_m` | 0.005066696 | ≤ 0.02 | 10.4.3 | 5632 nodes / 10569 cells |
| fsi | `tip_ux_final_vs_published_error_m` | 0.003946894 | ≤ 0.015 | 10.4.3 | 5632 nodes / 10569 cells |
| potential-flow | `potential_gradient_error_m_per_s` | 0.00003276014 | ≤ 0.001 | 10.4.3 | 150 nodes / 248 cells |
| rans | `inlet_velocity_error_m_per_s` | 0 | ≤ 0.000001 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `outlet_pressure_error_Pa` | 0 | ≤ 0.000001 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `flux_imbalance_m2_per_s` | 0.00002296767 | ≤ 0.001 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `mean_wall_y_plus` | 32.82783 | ≥ 30 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `mean_wall_y_plus_limit` | 32.82783 | ≤ 300 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `turbulent_kinetic_energy_maximum` | 3.361962 | ≥ 0.000001 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `turbulent_kinetic_energy_undershoot_ratio` | 0.0531492 | ≤ 0.1 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `turbulent_viscosity_maximum` | 0.08800177 | ≥ 0 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `turbulent_viscosity_minimum` | -9.399035e-13 | ≤ 1e-12 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `drag_x_N_per_m` | 0.1275926 | ≥ 0 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `drag_coefficient_minimum` | 1.766233 | ≥ 1.5 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `drag_coefficient_maximum` | 1.766233 | ≤ 4.5 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `drag_vs_momentum_relative_error` | 0.117391 | ≤ 0.15 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `near_wake_velocity_deficit_m_per_s` | 1.33046 | ≥ 0.025 | 10.4.3 | 654 nodes / 1202 cells |
| rans | `pressure_range_Pa` | 1.419605 | ≥ 0.05 | 10.4.3 | 654 nodes / 1202 cells |
| shallow-water | `depth_error_m` | 0 | ≤ 0.000001 | 10.4.3 | 150 nodes / 248 cells |
| shallow-water | `momentum_m2_per_s` | 2.925364e-15 | ≤ 0.000001 | 10.4.3 | 150 nodes / 248 cells |
| shallow-water | `water_volume_error_m3` | 8.881784e-16 | ≤ 0.000001 | 10.4.3 | 150 nodes / 248 cells |
| structural | `beam_displacement_relative_error` | 0.01786229 | ≤ 0.25 | 10.4.3 | 1048 nodes / 3896 cells |
| thermal | `linear_temperature_error_K` | 0.000019 | ≤ 0.001 | 10.4.3 | 263 nodes / 814 cells |
| two-fluids | `column_area_error_at_start` | 0.000008645698 | ≤ 0.01 | 10.4.3 | 2475 nodes / 4724 cells |
| two-fluids | `water_area_drift` | 0.005252038 | ≤ 0.02 | 10.4.3 | 2475 nodes / 4724 cells |
| two-fluids | `front_advance_m` | 1.148354 | ≥ 0.5 | 10.4.3 | 2475 nodes / 4724 cells |
| two-fluids | `peak_speed_m_per_s` | 4.875288 | ≤ 10 | 10.4.3 | 2475 nodes / 4724 cells |
| two-fluids | `outlet_pressure_error_Pa` | 0 | ≤ 0.000001 | 10.4.3 | 2475 nodes / 4724 cells |
| wind-tunnel | `wall_y_plus_ratio_limit` | 0.4721385 | ≤ 2.5 | 10.4.3 | 14840 nodes / 82804 cells |
| wind-tunnel | `wall_y_plus_ratio_minimum` | 0.4721385 | ≥ 0.4 | 10.4.3 | 14840 nodes / 82804 cells |
| wind-tunnel | `flux_imbalance_relative` | 0.003568199 | ≤ 0.05 | 10.4.3 | 14840 nodes / 82804 cells |
| wind-tunnel | `drag_x_N` | 6.774687 | ≥ 0 | 10.4.3 | 14840 nodes / 82804 cells |

<!-- verification:table:end -->
