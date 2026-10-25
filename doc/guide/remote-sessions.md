# Remote Sessions (SSH)

KKSS can work with a machine other than the one it runs on — a workstation or a cluster login node — through the **system `ssh` client**. It uses your own `~/.ssh/config`, agent, keys, `ProxyJump` and known-hosts handling, adds no dependency, and never sees or stores a password or passphrase.

::: warning Non-interactive login required
KKSS runs `ssh` with `BatchMode=yes`, so a host must already be reachable **without a prompt** (an agent or an unencrypted key, and the host key already accepted by a normal `ssh host` once). A host that asks for a password fails with a clear message instead of hanging.
:::

## Set up

Add the hosts under **Settings ▸ Remote ▸ SSH Hosts** — one ssh alias or `user@host` per entry. An entry that starts with `-` or contains spaces or shell characters is ignored.

## Open and save remote files

**File ▸ Open Remote…** picks a host, then browses its directories starting at your login folder (the same folder-by-folder picker as **Open from Cloud**). Opening a file **downloads it into the local staging cache**, along with its sidecars and companion files (XDMF's `.h5`, an OpenFOAM `constant/polyMesh/`), and from then on it is an ordinary local document: the same viewers, the same tools, the same assistant. The tab carries the ☁ mark.

Saving writes it back — on **File ▸ Save** and a few seconds after any automatic save. The upload goes to a temporary file next to the original and is renamed over it, so a dropped connection never leaves a half-written model, and the original file's permissions are kept.

- **Someone changed the file meanwhile.** The remote file's size and modification time are compared with what KKSS downloaded. If they differ, your copy is uploaded beside it as `model (conflict 2026-09-06 14-03-11).stp` and nothing is overwritten.
- **Recent files and session restore** keep remote documents like cloud ones: a trimmed copy downloads again when clicked or when the session restores.
- **Local deletes are never propagated**, and the macro library is not synced (same rules as [cloud storage](/guide/getting-started#working-from-cloud-storage)).

Remote documents share the cloud staging cache and its size limit (**Settings ▸ Cloud Accounts ▸ Cache Size Limit…**).

## A shell on the remote host

**View ▸ New Remote Shell…** lists your hosts and starts `ssh -t <host>` in the terminal panel, replacing the running shell. Only that one shell is remote: restarting it afterwards starts your local shell again.

## Run the Kratos tools remotely

Set **Settings ▸ Remote ▸ Run Kratos tools on** to a host and restart the assistant's tool servers. The Kratos MCP server then runs as `ssh <host> uvx kratos-mcp-server@<pinned version>`, so the assistant's solver tools and the **Jobs** panel operate on that machine. The remote host needs `uv` (`uvx`) installed; KKSS looks in `~/.local/bin` and `~/.cargo/bin` as well as the login `PATH`. The CAD and mesh tools keep running locally on the staged files.

Because the Kratos server runs on the other machine, **paths passed to `kratos__*` tools are paths on that host**, while CAD and mesh tools see the local staging paths. The assistant is told which host the Kratos tools use, and which open documents are staging copies of which remote path.

The local Kratos install path and extra environment variables (**Settings ▸ Kratos**) describe *this* machine and are not sent; the remote server runs with the remote login environment.

## Not included yet

- The guided-workflow **queue and runner** (preparing, solving and reviewing runs from Home) still operate on local paths.
- Port-forwarding a remote KKSS UI, and running the WebAssembly kernels (OCCT, Gmsh, MMG, meshio++) remotely — those always run locally, on the staged bytes.
- Windows and macOS are untested for this feature (the commands run on the remote side, which must be a POSIX system with `ls`, `stat`, `cat`, `cp` and `mv`).
