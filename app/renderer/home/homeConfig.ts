/**
 * Home-screen menu buttons. Adding a button = one entry here plus one
 * `HomeAction` case in app/main/ipc.ts and its handler in app/main/index.ts.
 */
import type { HomeAction } from "../../main/ipc";
import type { ToolbarIconId } from "../shell/shellIcons";

export interface HomeButton {
  action: HomeAction;
  icon: ToolbarIconId;
  label: string;
  description: string;
}

export const HOME_BUTTONS: HomeButton[] = [
  {
    action: "preprocessing",
    icon: "preMode",
    label: "Pre-Processing",
    description: "CAD geometry and model preparation",
  },
  {
    action: "postprocessing",
    icon: "postMode",
    label: "Post-Processing",
    description: "Mesh inspection, modification and results",
  },
  {
    action: "editor",
    icon: "edit",
    label: "Text Editor",
    description: "Edit input files, scripts and configuration",
  },
  {
    action: "settings",
    icon: "settings",
    label: "Settings",
    description: "Color theme and terminal shell",
  },
  {
    action: "help",
    icon: "help",
    label: "Help",
    description: "About, documentation and updates",
  },
];
