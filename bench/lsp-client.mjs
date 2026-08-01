// Minimal LSP client over stdio: Content-Length framing, JSON-RPC.
import { spawn } from 'node:child_process';

export class LspClient {
    constructor(cmd, args, opts = {}) {
        this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
        this.nextId = 1;
        this.pending = new Map();
        this.notificationHandlers = new Map();
        this.requestHandlers = new Map();
        this.buf = Buffer.alloc(0);
        this.stderr = '';
        this.exited = null;
        this.exitHandlers = new Set();
        this.forceKillTimer = undefined;

        this.proc.stdout.on('data', (d) => this._onData(d));
        this.proc.stderr.on('data', (d) => (this.stderr += d.toString()));
        this.proc.stdin.on('error', (error) => this._terminate({ code: null, sig: null, error }));
        this.proc.on('error', (error) => this._terminate({ code: null, sig: null, error }));
        this.proc.on('exit', (code, sig) => this._terminate({ code, sig }));
    }

    _terminate(exit) {
        if (this.forceKillTimer) {
            clearTimeout(this.forceKillTimer);
            this.forceKillTimer = undefined;
        }
        if (this.exited) return;
        if (!exit.error && this.buf.length) {
            exit = {
                ...exit,
                error: new Error(
                    `server exited with ${this.buf.length} byte(s) of incomplete LSP output ` +
                        `(code=${exit.code} sig=${exit.sig})\n${this.stderr}`
                )
            };
        }
        this.exited = exit;
        const reason =
            exit.error instanceof Error
                ? exit.error
                : new Error(`server exited code=${exit.code} sig=${exit.sig}\n${this.stderr}`);
        for (const { reject } of this.pending.values()) reject(reason);
        this.pending.clear();
        for (const handler of this.exitHandlers) handler(exit, reason);
        this.exitHandlers.clear();
    }

    _onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const sep = this.buf.indexOf('\r\n\r\n');
            if (sep === -1) return;
            const header = this.buf.subarray(0, sep).toString('ascii');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) {
                this._protocolError(`missing Content-Length header: ${JSON.stringify(header)}`);
                return;
            }
            const len = Number(m[1]);
            if (!Number.isSafeInteger(len) || len < 0 || len > 64 * 1024 * 1024) {
                this._protocolError(`invalid Content-Length: ${m[1]}`);
                return;
            }
            const start = sep + 4;
            if (this.buf.length < start + len) return;
            const body = this.buf.subarray(start, start + len).toString('utf8');
            this.buf = this.buf.subarray(start + len);
            let msg;
            try {
                msg = JSON.parse(body);
            } catch (error) {
                this._protocolError(
                    `invalid JSON-RPC payload: ${error instanceof Error ? error.message : error}`
                );
                return;
            }
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
                this._protocolError('JSON-RPC payload was not an object');
                return;
            }
            this._dispatch(msg);
            if (this.exited) return;
        }
    }

    _protocolError(message) {
        const error = new Error(`malformed LSP output: ${message}\n${this.stderr}`);
        this.buf = Buffer.alloc(0);
        this._terminate({ code: null, sig: null, error });
        this._killProcessBounded();
    }

    _killProcessBounded() {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
        try {
            this.proc.kill('SIGTERM');
        } catch {}
        if (this.forceKillTimer) return;
        this.forceKillTimer = setTimeout(() => {
            this.forceKillTimer = undefined;
            try {
                this.proc.kill('SIGKILL');
            } catch {}
            this.proc.stdin.destroy();
            this.proc.stdout.destroy();
            this.proc.stderr.destroy();
            this.proc.unref();
        }, 1_000);
    }

    _dispatch(msg) {
        if (msg.id !== undefined && msg.method !== undefined) {
            // server -> client request
            const h = this.requestHandlers.get(msg.method);
            const result = h ? h(msg.params) : null;
            this._send({ jsonrpc: '2.0', id: msg.id, result });
            return;
        }
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method) {
            const list = this.notificationHandlers.get(msg.method) || [];
            for (const h of list) h(msg.params);
            return;
        }
        this._protocolError(`message had neither id nor method: ${JSON.stringify(msg)}`);
    }

    _send(obj) {
        if (this.exited) {
            throw this.exited.error instanceof Error
                ? this.exited.error
                : new Error(
                      `cannot send to exited server code=${this.exited.code} sig=${this.exited.sig}`
                  );
        }
        const json = JSON.stringify(obj);
        const buf = Buffer.from(json, 'utf8');
        this.proc.stdin.write(`Content-Length: ${buf.length}\r\n\r\n`);
        this.proc.stdin.write(buf);
    }

    onNotification(method, handler) {
        if (!this.notificationHandlers.has(method)) this.notificationHandlers.set(method, []);
        this.notificationHandlers.get(method).push(handler);
    }

    onRequest(method, handler) {
        this.requestHandlers.set(method, handler);
    }

    onExit(handler) {
        if (this.exited) {
            handler(
                this.exited,
                this.exited.error instanceof Error
                    ? this.exited.error
                    : new Error(
                          `server exited code=${this.exited.code} sig=${this.exited.sig}\n${this.stderr}`
                      )
            );
            return () => {};
        }
        this.exitHandlers.add(handler);
        return () => this.exitHandlers.delete(handler);
    }

    request(method, params, timeoutMs = 30000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout ${timeoutMs}ms on ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                }
            });
            try {
                this._send({ jsonrpc: '2.0', id, method, params });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    notify(method, params) {
        this._send({ jsonrpc: '2.0', method, params });
    }

    dispose() {
        this._killProcessBounded();
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
