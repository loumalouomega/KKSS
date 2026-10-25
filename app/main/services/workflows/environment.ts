/** Bounded, non-installing probes. Launcher availability is not solver availability. */
import { KRATOS_MCP_VERSION } from '../chat/kratosMcpVersion';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { runRuntimeCommand, type KratosRuntime } from '../chat/kratosRuntime';
import type { SshRunner } from '../cloud/providers/ssh';
import { cpuCountCommand, mkdirCommand, shQuote } from '../cloud/providerCore/sshCore';
import { MPI_MODULES, type MpiLauncher } from './mpiReceipt';

const LAUNCHERS: readonly MpiLauncher[] = ['mpirun', 'mpiexec', 'srun'];
export interface RuntimeReport {
  executable?: string; version?: string; kratosVersion?: string;
  applications: { name: string; available: boolean; reason?: string }[];
  available: boolean; reason?: string; modes: string[];
  capabilities: { threads: boolean; mpi: boolean; mpiReason?: string; mpiLauncher?: MpiLauncher; threadReason?: string };
}
const unavailableCapabilities = () => ({ threads: false, mpi: false,
  mpiReason: 'MPI has not been verified for this runtime.',
  threadReason: 'Thread control has not been verified for this runtime.' });
export interface EnvironmentReport {
  version: 1; checkedAt: string; requirementsComplete: boolean; directory: string;
  writable: boolean; directoryReason?: string; cpuCount: number; memoryBytes: number;
  suggestedThreads?: number; manual: RuntimeReport; tools: RuntimeReport;
  /** Set when the probe ran on an ssh host; every other field then describes that host. */
  host?: string;
}
export function manualLaunchAvailability(report: EnvironmentReport): { allowed: boolean; reason?: string } {
  const reasons = [
    !report.requirementsComplete ? 'This case has no declared built-in application requirements.' : undefined,
    !report.manual.available ? report.manual.reason ?? 'The manual Python environment is unavailable.' : undefined,
    !report.writable ? report.directoryReason ?? 'The case directory is not writable.' : undefined,
  ].filter((reason): reason is string => !!reason);
  return { allowed: reasons.length === 0, reason: reasons.join(' ') || undefined };
}
export const PROBE_SCRIPT = `import sys,json,importlib
result={'executable':sys.executable,'version':sys.version.split()[0],'applications':[]}
for name in json.loads(sys.argv[1]):
 try:
  module=importlib.import_module(name)
  result['applications'].append({'name':name,'available':True})
  if name=='KratosMultiphysics':
   result['kratosVersion']=str(module.KratosGlobals.Kernel.Version())
   parallel=module.ParallelUtilities if hasattr(module,'ParallelUtilities') else None
   result['threadControl']=bool(parallel and callable(getattr(parallel,'SetNumThreads',None)) and callable(getattr(parallel,'GetNumThreads',None)))
 except Exception as e: result['applications'].append({'name':name,'available':False,'reason':str(e)})
import os,shutil
result['mpiPosix']=os.name!='nt'
env=os.path.basename(os.environ.get('KRATOS_MPI_LAUNCHER',''))
result['mpiLauncher']=next((l for l in ([env] if env else [])+['mpirun','mpiexec','srun'] if l in ('mpirun','mpiexec','srun') and shutil.which(l)),None)
mpi=[]
for name in ${JSON.stringify(MPI_MODULES)}:
 try: importlib.import_module(name)
 except Exception: mpi.append(name)
result['mpiMissing']=mpi
print('KKSS_PROBE:'+json.dumps(result))`;
/** MPI is offered only when an MPI launcher and an MPI-enabled Kratos build were both seen by the probe. */
function mpiCapability(available: boolean, data: { mpiPosix?: unknown; mpiLauncher?: unknown; mpiMissing?: unknown }): { mpi: boolean; mpiReason?: string; mpiLauncher?: MpiLauncher } {
  const launcher = LAUNCHERS.find(l => l === data.mpiLauncher);
  const missing = Array.isArray(data.mpiMissing) ? data.mpiMissing.filter((m): m is string => typeof m === 'string') : undefined;
  if (!available) return { mpi: false, mpiReason: 'Kratos is not available in this interpreter.' };
  if (data.mpiPosix !== true) return { mpi: false, mpiReason: 'MPI runs need a POSIX shell; this platform has none.' };
  if (!launcher) return { mpi: false, mpiReason: 'No MPI launcher (mpirun, mpiexec or srun) was found on PATH.' };
  if (!missing) return { mpi: false, mpiReason: 'The interpreter did not report its MPI modules.' };
  if (missing.length) return { mpi: false, mpiReason: `This Kratos build is not MPI-enabled (${missing[0]} is not importable).` };
  return { mpi: true, mpiLauncher: launcher };
}
export type Probe = typeof runRuntimeCommand;
export async function probePython(command: string, prefix: string[], applications: string[], env: NodeJS.ProcessEnv, run: Probe = runRuntimeCommand): Promise<RuntimeReport> {
  try {
    if (applications.some(name => !/^KratosMultiphysics(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name))) throw new Error('Invalid Kratos application name.');
    const output = await run(command, [...prefix, '-c', PROBE_SCRIPT, JSON.stringify(['KratosMultiphysics', ...new Set(applications.filter(a => a !== 'KratosMultiphysics'))])], {
      env, timeout: 15000, signal: AbortSignal.timeout(16000),
    });
    const line = output.split('\n').reverse().find(line => line.startsWith('KKSS_PROBE:'));
    if (!line) throw new Error('The selected interpreter returned no environment report.');
    const data = JSON.parse(line.slice(11));
    if (typeof data.executable !== 'string' || typeof data.version !== 'string' || !Array.isArray(data.applications) || !data.applications.length || data.applications.some((a: {name?: unknown; available?: unknown}) => typeof a.name !== 'string' || typeof a.available !== 'boolean')) throw new Error('Invalid interpreter report.');
    const available = data.applications.every((a: {available: boolean}) => a.available);
    return { ...data, available, capabilities: { ...unavailableCapabilities(), threads: available && data.threadControl === true, ...mpiCapability(available, data),
      threadReason: available && data.threadControl === true ? undefined : 'The Kratos thread-control API is unavailable.' },
      modes: available ? ['output', 'terminal'] : [], reason: available ? undefined : 'Install the missing applications in this interpreter, or select another interpreter in Settings → Kratos.' };
  } catch (e) {
    return { executable: command, applications: [], available: false, capabilities: unavailableCapabilities(), modes: [], reason: `${e instanceof Error ? e.message : e} Select a valid interpreter in Settings → Kratos and retry.` };
  }
}
export async function checkEnvironment(options: {
  python: string; env: NodeJS.ProcessEnv; directory: string; applications: string[];
  requirementsComplete: boolean; runtime: Pick<KratosRuntime, 'discover'>; bundledPython?: string;
  run?: Probe;
}): Promise<EnvironmentReport> {
  const run = options.run ?? runRuntimeCommand;
  const manualPromise = probePython(options.python, [], options.applications, options.env, run);
  const toolsPromise = (async (): Promise<RuntimeReport> => {
    try {
      const launcher = await options.runtime.discover(AbortSignal.timeout(16000));
      // Offline + no-sync prevents a check from downloading or installing packages.
      const report = options.bundledPython
        ? await probePython(options.bundledPython, [], options.applications, options.env, run)
        : await probePython(launcher.command, [...launcher.args, '--offline', '--no-sync', '--from', `kratos-mcp-server==${KRATOS_MCP_VERSION}`, 'python'], options.applications, options.env, run);
      return { ...report, capabilities: { ...unavailableCapabilities(), threadReason: 'The tool runner does not declare a thread-control contract.' }, modes: report.available ? ['mcp'] : [], reason: report.available ? undefined : `${report.reason} Use the existing Kratos tool setup/retry action if its cached environment is missing.` };
    } catch (e) { return { applications: [], available: false, capabilities: unavailableCapabilities(), modes: [], reason: `${e instanceof Error ? e.message : e} Use Kratos tool setup/retry.` }; }
  })();
  let writable = false, directoryReason: string | undefined;
  try {
    if (!(await fs.stat(options.directory)).isDirectory()) throw new Error('Not a directory.');
    await fs.access(options.directory, constants.W_OK);
    writable = true;
  } catch (e) { directoryReason = `Choose an existing writable run directory. ${e instanceof Error ? e.message : e}`; }
  const [manual, tools] = await Promise.all([manualPromise, toolsPromise]);
  const cpuCount = os.availableParallelism();
  return { version: 1, checkedAt: new Date().toISOString(), requirementsComplete: options.requirementsComplete,
    directory: options.directory, writable, directoryReason, cpuCount, memoryBytes: os.freemem(), manual, tools,
    ...(manual.available && manual.capabilities.threads ? { suggestedThreads: Math.max(1, cpuCount - 1) } : {}) };
}

/**
 * The same probes as `checkEnvironment`, run on the ssh host that will execute guided solves.
 * The local uv tool runtime plays no part in a remote solve, so `tools` is reported unavailable
 * with that reason rather than borrowed from this machine.
 */
export async function checkRemoteEnvironment(options: {
  host: string; ssh: SshRunner; applications: string[]; requirementsComplete: boolean; remoteDir?: string;
}): Promise<EnvironmentReport> {
  const { host, ssh } = options;
  const remoteDir = options.remoteDir ?? 'kkss-runs';
  const run: Probe = async (_command, args) => {
    const [flag, script, json] = args.slice(-3);
    const result = await ssh(host, `python3 ${flag} ${shQuote(script)} ${shQuote(json)}`);
    if (result.code !== 0) throw new Error(`python3 on ${host} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  };
  const [manual, cpus, made] = await Promise.all([
    probePython('python3', [], options.applications, {}, run),
    ssh(host, cpuCountCommand()).catch(() => undefined),
    ssh(host, mkdirCommand(remoteDir)).catch(() => undefined),
  ]);
  const parsed = Number(cpus?.stdout.trim());
  const cpuCount = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  const writable = made?.code === 0;
  const unavailable = 'Guided solves on a remote host use that host\'s Python; the local Kratos tool runtime is not used.';
  return { version: 1, checkedAt: new Date().toISOString(), requirementsComplete: options.requirementsComplete, host,
    directory: `${host}:${remoteDir}`, writable, ...(writable ? {} : { directoryReason: `Could not create ${remoteDir} on ${host}.` }),
    cpuCount, memoryBytes: 0, manual: cpuCount ? manual : { ...manual, available: false, modes: [], reason: `Could not determine the CPU count of ${host}. ${manual.reason ?? ''}`.trim() },
    tools: { applications: [], available: false, capabilities: unavailableCapabilities(), modes: [], reason: unavailable },
    ...(cpuCount && manual.available && manual.capabilities.threads ? { suggestedThreads: Math.max(1, cpuCount - 1) } : {}) };
}

export function resolveThreads(configured: number | undefined, cpuCount: number): number {
  const value = configured ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Solver threads must be a nonnegative integer.');
  const threads = value || Math.max(1, cpuCount - 1);
  if (threads > cpuCount) throw new Error('Solver threads exceed the available CPU budget.');
  return threads;
}
