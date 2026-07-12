/**
 * Home-screen menu buttons. Adding a button = one entry here plus one
 * `HomeAction` case in app/main/ipc.ts and its handler in app/main/index.ts.
 */
import type { HomeAction } from "../../main/ipc";

export interface HomeButton {
  action: HomeAction;
  label: string;
  description: string;
}

export const HOME_BUTTONS: HomeButton[] = [
  {
    action: "preprocessing",
    label: "Pre-Processing",
    description: "CAD geometry and model preparation",
  },
  {
    action: "postprocessing",
    label: "Post-Processing",
    description: "Mesh inspection, modification and results",
  },
  {
    action: "editor",
    label: "Text Editor",
    description: "Edit input files, scripts and configuration",
  },
  {
    action: "help",
    label: "Help",
    description: "About, documentation and updates",
  },
];
