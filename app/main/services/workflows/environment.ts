/** Bounded, non-installing probes. Launcher availability is not solver availability. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { runRuntimeCommand, type KratosRuntime } from '../chat/kratosRuntime';
export interface RuntimeReport {
  executable?: string; version?: string; kratosVersion?: string;
  applications: { name: string; available: boolean; reason?: string }[];
  available: boolean; reason?: string; modes: string[];
  capabilities: { threads: boolean; mpi: false; mpiReason: string; threadReason?: string };
}
const unavailableCapabilities = () => ({ threads: false, mpi: false as const,
  mpiReason: 'This runner has no verified MPI launch and reconciliation contract.',
  threadReason: 'Thread control has not been verified for this runtime.' });
export interface EnvironmentReport {
  version: 1; checkedAt: string; requirementsComplete: boolean; directory: string;
  writable: boolean; directoryReason?: string; cpuCount: number; memoryBytes: number;
  suggestedThreads?: number; manual: RuntimeReport; tools: RuntimeReport;
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
   result['threadControl']=bool(parallel and callable(getattr(parallel,'SetNumThreads',None)))
 except Exception as e: result['applications'].append({'name':name,'available':False,'reason':str(e)})
print('KKSS_PROBE:'+json.dumps(result))`;
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
    return { ...data, available, capabilities: { ...unavailableCapabilities(), threads: available && data.threadControl === true,
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
        : await probePython(launcher.command, [...launcher.args, '--offline', '--no-sync', '--from', 'kratos-mcp-server==0.3.0', 'python'], options.applications, options.env, run);
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
    ...(manual.available && manual.capabilities.threads ? { suggestedThreads: Math.max(1, Math.min(4, cpuCount - 1)) } : {}) };
}
