import { t } from "../../shared/i18n";
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
    label: t("Pre-Processing"),
    description: t("CAD geometry and model preparation"),
  },
  {
    action: "postprocessing",
    icon: "postMode",
    label: t("Post-Processing"),
    description: t("Mesh inspection, modification and results"),
  },
  {
    action: "editor",
    icon: "edit",
    label: t("Text Editor"),
    description: t("Edit input files, scripts and configuration"),
  },
  {
    action: "settings",
    icon: "settings",
    label: t("Settings"),
    description: t("Theme, viewer defaults, Kratos environment and more"),
  },
  {
    action: "help",
    icon: "help",
    label: t("Help"),
    description: t("About, documentation and updates"),
  },
];
