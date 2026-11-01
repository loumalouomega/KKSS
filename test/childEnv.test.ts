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
