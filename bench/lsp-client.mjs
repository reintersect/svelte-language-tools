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

        this.proc.stdout.on('data', (d) => this._onData(d));
        this.proc.stderr.on('data', (d) => (this.stderr += d.toString()));
        this.proc.on('exit', (code, sig) => {
            this.exited = { code, sig };
            for (const { reject } of this.pending.values()) {
                reject(new Error(`server exited code=${code} sig=${sig}\n${this.stderr}`));
            }
            this.pending.clear();
        });
    }

    _onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const sep = this.buf.indexOf('\r\n\r\n');
            if (sep === -1) return;
            const header = this.buf.subarray(0, sep).toString('ascii');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) {
                this.buf = this.buf.subarray(sep + 4);
                continue;
            }
            const len = Number(m[1]);
            const start = sep + 4;
            if (this.buf.length < start + len) return;
            const body = this.buf.subarray(start, start + len).toString('utf8');
            this.buf = this.buf.subarray(start + len);
            let msg;
            try {
                msg = JSON.parse(body);
            } catch {
                continue;
            }
            this._dispatch(msg);
        }
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
        }
    }

    _send(obj) {
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
            this._send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this._send({ jsonrpc: '2.0', method, params });
    }

    dispose() {
        try {
            this.proc.kill();
        } catch {}
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
