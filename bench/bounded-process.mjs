import { spawn } from 'node:child_process';

const FORCE_KILL_GRACE_MS = 1_000;

/**
 * Run a process while collecting bounded output. A catchable SIGTERM is followed by a hard,
 * bounded teardown so a broken checker cannot retain its pipes and hang the oracle forever.
 */
export function runBoundedProcess(
    command,
    args,
    { cwd, env, timeoutMs, outputLimit, label = 'process' }
) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        let terminalError;
        let settled = false;
        let forceKill;

        const clearTimers = () => {
            clearTimeout(timeout);
            if (forceKill) clearTimeout(forceKill);
        };
        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(error);
        };
        const terminate = (error) => {
            if (terminalError || settled) return;
            terminalError = error;
            try {
                child.kill('SIGTERM');
            } catch {
                // The close/error path remains authoritative when the process already exited.
            }
            forceKill = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Reject below even if the operating system already reaped the child.
                }
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                rejectOnce(error);
            }, FORCE_KILL_GRACE_MS);
        };
        const timeout = setTimeout(
            () => terminate(new Error(`${label} timed out after ${timeoutMs}ms`)),
            timeoutMs
        );
        const collect = (target, chunk) => {
            if (terminalError) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > outputLimit) {
                terminate(new Error(`${label} exceeded ${outputLimit} output bytes`));
                return;
            }
            if (target === 'stdout') stdout += chunk;
            else stderr += chunk;
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => collect('stdout', chunk));
        child.stderr.on('data', (chunk) => collect('stderr', chunk));
        child.stdout.on('error', terminate);
        child.stderr.on('error', terminate);
        child.on('error', (error) => {
            if (terminalError) rejectOnce(terminalError);
            else rejectOnce(error);
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            clearTimers();
            if (terminalError) {
                rejectOnce(terminalError);
                return;
            }
            settled = true;
            resolve({ code, signal, stdout, stderr });
        });
    });
}
