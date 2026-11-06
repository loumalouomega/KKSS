import { describe, expect, it } from "vitest";
import { externalProcessEnv, strippedNames } from "../app/main/services/childEnv";

const base = {
  PATH: "/tmp/.mount_x/usr/bin:/usr/bin", HOME: "/h", APPDIR: "/tmp/.mount_x", APPIMAGE: "/a.AppImage",
  LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib", ELECTRON_RUN_AS_NODE: "1", PYTHONHOME: "/tmp/.mount_x/py",
};

describe("externalProcessEnv", () => {
  it("strips loader and packager variables when packaged", () => {
    const env = externalProcessEnv(base, { packaged: true, pathSeparator: ":" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });
  it("keeps a developer's loader path in a dev checkout but drops Electron switches", () => {
    const env = externalProcessEnv(base, { packaged: false });
    expect(env.LD_LIBRARY_PATH).toBe("/tmp/.mount_x/usr/lib");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
  it("does not mutate its input and lists what it removed", () => {
    externalProcessEnv(base, { packaged: true });
    expect(base.APPDIR).toBe("/tmp/.mount_x");
    expect(strippedNames(base, true)).toContain("LD_LIBRARY_PATH");
  });
});

describe("launchers that hand an environment to user programs", () => {
  const packagedBase = { ...base, ANTHROPIC_API_KEY: "k" };
  it("keeps the subscription CLIs free of packager loader paths and API keys", async () => {
    const { configureChildEnv } = await import("../app/main/services/childEnv");
    const { subscriptionEnv } = await import("../app/main/services/chat/agents/runtime");
    configureChildEnv(true);
    try {
      const env = subscriptionEnv(packagedBase);
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
      expect(env.APPDIR).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.HOME).toBe("/h");
    } finally { configureChildEnv(false); }
  });
  it("runs the local solve shell and ssh with the stripped environment", async () => {
    const { configureChildEnv } = await import("../app/main/services/childEnv");
    const { runLocalSh } = await import("../app/main/services/workflows/mpiRunner");
    configureChildEnv(true);
    const saved = { ...process.env };
    process.env.LD_LIBRARY_PATH = "/tmp/.mount_x/usr/lib"; process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const r = await runLocalSh("local", 'printf "%s|%s" "${LD_LIBRARY_PATH-unset}" "${ELECTRON_RUN_AS_NODE-unset}"');
      expect(r.stdout).toBe("unset|unset");
    } finally {
      configureChildEnv(false);
      for (const k of ["LD_LIBRARY_PATH", "ELECTRON_RUN_AS_NODE"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});
