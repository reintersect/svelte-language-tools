import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FallbackWatcher } from '../../src/lib/FallbackWatcher';

describe('FallbackWatcher errors', () => {
    it('handles a chokidar error once instead of crashing the process', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-fallback-watcher-'));
        const watcher = new FallbackWatcher(['.ts'], [root]);
        const errors: Error[] = [];
        watcher.onErrorOccurred((error) => errors.push(error));

        (watcher as any).watcher.emit('error', new Error('EMFILE: too many open files'));
        (watcher as any).watcher.emit('error', new Error('duplicate'));
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(
            errors.map((error) => error.message),
            ['EMFILE: too many open files']
        );
        watcher.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
