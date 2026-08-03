import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import {
    BATCH_GRAPH_DIRECTORY_VALIDATOR,
    batchGraphDirectoryMembership,
    batchGraphDirectoryMembershipCoversPath,
    createBatchGraphDirectoryMembershipBudget
} from '../../../../src/plugins/typescript-go/lsp/BatchGraphEvidence';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-batch-graph-evidence-'));
    tempRoots.push(root);
    return root;
}

describe('typescript-go BatchGraphEvidence', () => {
    it('records nested directory symlink topology without following the target tree', () => {
        const temp = fixture();
        const root = path.join(temp, 'root');
        const firstTarget = path.join(temp, 'first');
        const secondTarget = path.join(temp, 'second');
        fs.mkdirSync(root);
        fs.mkdirSync(firstTarget);
        fs.mkdirSync(secondTarget);
        fs.symlinkSync(firstTarget, path.join(root, 'linked'), 'junction');

        const initial = batchGraphDirectoryMembership({
            path: root,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR
        });
        fs.writeFileSync(path.join(firstTarget, 'Added.svelte'), '<p />');
        const targetContentsChanged = batchGraphDirectoryMembership({
            path: root,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR
        });
        assert.deepStrictEqual(targetContentsChanged, initial);

        fs.unlinkSync(path.join(root, 'linked'));
        fs.symlinkSync(secondTarget, path.join(root, 'linked'), 'junction');
        const retargeted = batchGraphDirectoryMembership({
            path: root,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR
        });
        assert.notDeepStrictEqual(retargeted, initial);
    });

    it('reuses a canonical package proof only within one validation pass', () => {
        const temp = fixture();
        const target = path.join(temp, 'target');
        const firstAlias = path.join(temp, 'first-alias');
        const secondAlias = path.join(temp, 'second-alias');
        fs.mkdirSync(path.join(target, 'src'), { recursive: true });
        fs.writeFileSync(path.join(target, 'src', 'Button.svelte'), '<button />');
        fs.symlinkSync(target, firstAlias, 'junction');
        fs.symlinkSync(target, secondAlias, 'junction');
        const budget = createBatchGraphDirectoryMembershipBudget();
        const firstFiles: string[] = [];
        const first = batchGraphDirectoryMembership({
            path: firstAlias,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR,
            budget,
            svelteFiles: firstFiles
        });
        const entriesAfterFirst = budget.entries;
        const secondFiles: string[] = [];
        const second = batchGraphDirectoryMembership({
            path: secondAlias,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR,
            budget,
            svelteFiles: secondFiles
        });

        assert.deepStrictEqual(second, first);
        assert.strictEqual(budget.entries, entriesAfterFirst + 1);
        assert.deepStrictEqual(firstFiles, [path.join(firstAlias, 'src', 'Button.svelte')]);
        assert.deepStrictEqual(secondFiles, [path.join(secondAlias, 'src', 'Button.svelte')]);

        fs.writeFileSync(path.join(target, 'src', 'Card.svelte'), '<article />');
        const nextPass = batchGraphDirectoryMembership({
            path: firstAlias,
            validator: BATCH_GRAPH_DIRECTORY_VALIDATOR,
            budget: createBatchGraphDirectoryMembershipBudget()
        });
        assert.notDeepStrictEqual(nextPass, first);
    });

    it('only folds exact probes which the recursive proof really observes', () => {
        const root = fixture();
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'node_modules'));
        const external = fixture();
        fs.symlinkSync(external, path.join(root, 'linked'), 'junction');
        const nestedRepository = path.join(root, 'nested');
        fs.mkdirSync(path.join(nestedRepository, '.git'), { recursive: true });

        assert.strictEqual(
            batchGraphDirectoryMembershipCoversPath(root, path.join(root, 'src', 'New.svelte')),
            true
        );
        assert.strictEqual(
            batchGraphDirectoryMembershipCoversPath(root, path.join(root, 'src', 'asset.png')),
            false
        );
        assert.strictEqual(
            batchGraphDirectoryMembershipCoversPath(
                root,
                path.join(root, 'node_modules', 'pkg', 'package.json')
            ),
            false
        );
        assert.strictEqual(
            batchGraphDirectoryMembershipCoversPath(root, path.join(root, 'linked', 'New.svelte')),
            false
        );
        assert.strictEqual(
            batchGraphDirectoryMembershipCoversPath(
                root,
                path.join(nestedRepository, 'New.svelte')
            ),
            false
        );
    });
});
