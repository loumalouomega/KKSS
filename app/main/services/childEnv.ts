// The environment handed to external user programs (Python, Kratos, MPI, uv,
// the login shell). A packaged build can carry variables the packager set for
// itself; they must not reach the user's tools (roadmap item 25). Pure.

/** Set by an AppImage's AppRun for itself; never meaningful to a child. */
export const PACKAGER_VARS = ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "APPIMAGE_SILENT_INSTALL"] as const;

/** Dynamic-loader and runtime-home variables that point into the app bundle when it is packaged. */
export const LOADER_VARS = [
  "LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "PYTHONHOME", "PYTHONPATH_ELECTRON", "GSETTINGS_SCHEMA_DIR", "GDK_PIXBUF_MODULE_FILE", "GIO_EXTRA_MODULES", "QT_PLUGIN_PATH",
] as const;

/** Electron-only switches; `ELECTRON_RUN_AS_NODE` is added back by the Node MCP launcher alone. */
export const ELECTRON_VARS = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_ENABLE_LOGGING", "ELECTRON_NO_ASAR"] as const;

function stripAppDirEntries(value: string, appDir: string, sep: string): string {
  return value.split(sep).filter((p) => p && !p.startsWith(appDir)).join(sep);
}

/**
 * A copy of `base` fit for a user program. In a packaged build the loader
 * variables are removed (an AppImage keeps no original, so restoring means
 * unsetting); in a dev checkout only the Electron switches go, so a developer's
 * own `LD_LIBRARY_PATH` survives. PATH entries inside the AppImage mount are dropped.
 */
let packagedBuild = false;
/** index.ts calls this once with `app.isPackaged`; modules stay Electron-free and testable. */
export function configureChildEnv(packaged: boolean): void { packagedBuild = packaged; }

export function externalProcessEnv(base: NodeJS.ProcessEnv, opts: { packaged?: boolean; pathSeparator?: string } = {}): NodeJS.ProcessEnv {
  const packaged = opts.packaged ?? packagedBuild;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of ELECTRON_VARS) delete env[key];
  if (!packaged) return env;
  const sep = opts.pathSeparator ?? (process.platform === "win32" ? ";" : ":");
  const appDir = base.APPDIR;
  if (appDir && env.PATH) env.PATH = stripAppDirEntries(env.PATH, appDir, sep);
  for (const key of LOADER_VARS) delete env[key];
  for (const key of PACKAGER_VARS) delete env[key];
  return env;
}

/** Names removed from `base`, for the release self-test's record (item 21). */
export function strippedNames(base: NodeJS.ProcessEnv, packaged: boolean): string[] {
  const out = externalProcessEnv(base, { packaged });
  return Object.keys(base).filter((k) => !(k in out)).sort();
}
