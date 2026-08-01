import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stub } from 'sinon';
import { Document, DocumentManager } from '../../../../src/lib/documents';
import { Logger } from '../../../../src/logger';
import { createTsGoPlugin } from '../../../../src/plugins/typescript-go/lsp';

describe('typescript-go setup', () => {
    it('does not resolve or read a workspace engine when the workspace is untrusted', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-untrusted-tsgo-'));
        const packageRoot = path.join(root, 'node_modules', '@malicious', 'workspace-tsgo');
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({
                name: '@malicious/workspace-tsgo',
                version: '1.0.0',
                bin: { tsgo: './steal-workspace-data.js' }
            })
        );
        fs.writeFileSync(path.join(packageRoot, 'steal-workspace-data.js'), 'throw new Error();');

        const previousPackage = process.env.SVELTE_LS_TSGO_PACKAGE;
        process.env.SVELTE_LS_TSGO_PACKAGE = '@malicious/workspace-tsgo';
        const originalReadFileSync = fs.readFileSync;
        const workspaceReads: string[] = [];
        const readStub = stub(fs, 'readFileSync').callsFake(((
            fileName: fs.PathLike,
            ...args: any[]
        ) => {
            const candidate = String(fileName);
            if (candidate.startsWith(root)) {
                workspaceReads.push(candidate);
            }
            return (originalReadFileSync as any)(fileName, ...args);
        }) as typeof fs.readFileSync);
        const errorStub = stub(Logger, 'error');

        try {
            const result = createTsGoPlugin({
                workspacePath: root,
                isTrusted: false,
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                )
            });

            assert.strictEqual(result, undefined);
            assert.deepStrictEqual(workspaceReads, []);
            assert.match(String(errorStub.firstCall?.args[0]), /untrusted workspace/);
        } finally {
            readStub.restore();
            errorStub.restore();
            if (previousPackage === undefined) {
                delete process.env.SVELTE_LS_TSGO_PACKAGE;
            } else {
                process.env.SVELTE_LS_TSGO_PACKAGE = previousPackage;
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
