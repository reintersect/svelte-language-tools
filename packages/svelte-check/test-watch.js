// @ts-check
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'dist', 'src', 'index.js');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-check-watch-'));
const workspace = path.join(parent, 'workspace');
const sharedConfig = path.join(parent, 'shared-config');
const sourceDirectory = path.join(workspace, 'src');
fs.mkdirSync(sourceDirectory, { recursive: true });
fs.mkdirSync(sharedConfig, { recursive: true });

const writeJson = (filePath, value) =>
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`);

const baseConfigPath = path.join(sharedConfig, 'base.json');
const tsconfigPath = path.join(workspace, 'tsconfig.json');
const svelteConfigPath = path.join(workspace, 'svelte.config.mjs');
const packagePath = path.join(workspace, 'package.json');
const appPath = path.join(sourceDirectory, 'App.svelte');
const sharedDirectory = path.join(workspace, 'shared');
const dependencyDirectory = path.join(workspace, 'packages', 'fixture-lib');
const dependencyPackagePath = path.join(dependencyDirectory, 'package.json');
const fixtureNodeModules = path.join(workspace, 'node_modules');
fs.mkdirSync(fixtureNodeModules, { recursive: true });
fs.mkdirSync(dependencyDirectory, { recursive: true });
fs.mkdirSync(sharedDirectory, { recursive: true });
fs.symlinkSync(
    path.dirname(require.resolve('svelte/package.json')),
    path.join(fixtureNodeModules, 'svelte'),
    'junction'
);
fs.symlinkSync(dependencyDirectory, path.join(fixtureNodeModules, 'fixture-lib'), 'junction');

writeJson(baseConfigPath, {
    compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' }
});
writeJson(tsconfigPath, {
    extends: '../shared-config/base.json',
    include: ['src/**/*']
});
writeJson(packagePath, {
    name: 'svelte-check-watch-fixture',
    private: true,
    version: '1.0.0',
    dependencies: { svelte: '*', 'fixture-lib': 'workspace:*' }
});
writeJson(dependencyPackagePath, {
    name: 'fixture-lib',
    version: '1.0.0',
    peerDependencies: { svelte: '*' },
    exports: { '.': './one.ts' }
});
fs.writeFileSync(svelteConfigPath, 'export default { compilerOptions: { accessors: true } };\n');
fs.writeFileSync(appPath, '<script lang="ts">export let value: number;</script>\n{value}\n');
fs.writeFileSync(
    path.join(sharedDirectory, 'Nested.svelte'),
    '<script lang="ts">export let name: string;</script>\n{name}\n'
);
fs.writeFileSync(
    path.join(dependencyDirectory, 'One.svelte'),
    '<script lang="ts">export let label: string;</script>\n{label}\n'
);
fs.writeFileSync(
    path.join(dependencyDirectory, 'Two.svelte'),
    '<script lang="ts">export let count: number;</script>\n{count}\n'
);
fs.writeFileSync(
    path.join(dependencyDirectory, 'one.ts'),
    'export { default } from "./One.svelte";\n'
);
const dependencyBarrelPath = path.join(dependencyDirectory, 'two.ts');
fs.writeFileSync(dependencyBarrelPath, 'export { default } from "./Two.svelte";\n');
fs.writeFileSync(
    path.join(sourceDirectory, 'use.ts'),
    'import App from "./App.svelte";\n' +
        'import type { ComponentProps } from "svelte";\n' +
        'import Lib from "fixture-lib";\n' +
        'const app = new App({ target: document.body, props: { value: 1 } });\n' +
        'app.value = "bad";\n' +
        'const libProps: ComponentProps<Lib> = { label: 123 };\n' +
        'void libProps;\n'
);

const child = spawn(
    process.execPath,
    [
        CLI,
        '--workspace',
        workspace,
        '--tsconfig',
        './tsconfig.json',
        '--config',
        './svelte.config.mjs',
        '--incremental',
        '--tsgo',
        '--watch',
        '--output',
        'machine-verbose'
    ],
    {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SVELTE_CHECK_WATCH_POLLING: '1' }
    }
);

let stdout = '';
let stderr = '';
let completions = 0;
let currentDiagnostics = [];
/** @type {Array<{target: number, allowFailure: boolean, resolve: (diagnostics: any[]) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
const waiters = [];

function rejectWaiters(error) {
    for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
    }
}

function acceptLine(line) {
    const payload = line.slice(line.indexOf(' ') + 1);
    if (payload.startsWith('{')) {
        try {
            const record = JSON.parse(payload);
            if (record.type === 'ERROR' || record.type === 'WARNING') {
                currentDiagnostics.push(record);
            }
        } catch {
            // The machine-protocol sanity suite owns malformed-record validation.
        }
    } else if (/^START /.test(payload)) {
        currentDiagnostics = [];
    } else if (/^COMPLETED \d+ FILES /.test(payload)) {
        completions++;
        const completedDiagnostics = currentDiagnostics;
        for (let index = waiters.length - 1; index >= 0; index--) {
            const waiter = waiters[index];
            if (completions < waiter.target) continue;
            waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(completedDiagnostics);
        }
    } else if (/^FAILURE /.test(payload)) {
        const allowed = waiters.filter((waiter) => waiter.allowFailure);
        if (allowed.length) {
            for (const waiter of allowed) {
                waiters.splice(waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve([{ type: 'FAILURE', message: payload }]);
            }
        } else {
            rejectWaiters(new Error(`watch check emitted FAILURE:\n${line}\n${stderr}`));
        }
    }
}

let pendingLine = '';
child.stdout.on('data', (chunk) => {
    stdout += chunk;
    pendingLine += chunk;
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop() ?? '';
    for (const line of lines) acceptLine(line);
});
child.stderr.on('data', (chunk) => (stderr += chunk));
child.on('error', (error) => rejectWaiters(error));
child.on('exit', (code, signal) => {
    rejectWaiters(
        new Error(
            `watch process exited early (code=${code}, signal=${signal})\n${stderr}\n${stdout}`
        )
    );
});

function waitForNextCompletion(label, allowFailure = false) {
    const target = completions + 1;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.target === target);
            if (index >= 0) waiters.splice(index, 1);
            reject(
                new Error(
                    `timed out waiting for ${label} (wanted completion ${target}, saw ${completions})\n` +
                        `${stderr}\n${stdout}`
                )
            );
        }, 20_000);
        waiters.push({ target, allowFailure, resolve, reject, timer });
    });
}

async function mutateAndWait(label, mutate, allowFailure = false) {
    const completion = waitForNextCompletion(label, allowFailure);
    mutate();
    const diagnostics = await completion;
    console.log(`  PASS: ${label}`);
    return diagnostics;
}

(async () => {
    try {
        await waitForNextCompletion('initial watch check');
        console.log('  PASS: initial watch check');

        await mutateAndWait('extended tsconfig change', () =>
            writeJson(baseConfigPath, {
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    noUncheckedIndexedAccess: true
                }
            })
        );
        await mutateAndWait(
            'extended tsconfig deletion',
            () => fs.unlinkSync(baseConfigPath),
            true
        );
        await mutateAndWait('extended tsconfig recreation', () =>
            writeJson(baseConfigPath, {
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    noUncheckedIndexedAccess: true
                }
            })
        );
        const beforeConfigChange = await mutateAndWait('root tsconfig semantic change', () =>
            writeJson(tsconfigPath, {
                extends: '../shared-config/base.json',
                include: ['src/**/*.svelte', 'src/**/*.ts']
            })
        );
        const afterConfigChange = await mutateAndWait('Svelte config change', () =>
            fs.writeFileSync(
                svelteConfigPath,
                'export default { compilerOptions: { accessors: false } };\n'
            )
        );
        const signature = (diagnostics) =>
            diagnostics.map(({ filename, code, message }) => ({ filename, code, message }));
        if (
            JSON.stringify(signature(afterConfigChange)) ===
            JSON.stringify(signature(beforeConfigChange))
        ) {
            throw new Error(
                `Svelte config change reran with stale transform settings: ${JSON.stringify(
                    signature(afterConfigChange)
                )}`
            );
        }
        const afterPackageChange = await mutateAndWait('package exports change', () =>
            writeJson(dependencyPackagePath, {
                name: 'fixture-lib',
                version: '1.0.1',
                peerDependencies: { svelte: '*' },
                exports: { '.': './two.ts' }
            })
        );
        if (
            JSON.stringify(signature(afterPackageChange)) ===
            JSON.stringify(signature(afterConfigChange))
        ) {
            throw new Error(
                `package exports change reran with stale dependency indexes: ${JSON.stringify(
                    signature(afterPackageChange)
                )}`
            );
        }
        const afterBarrelChange = await mutateAndWait('dependency barrel change', () =>
            fs.writeFileSync(dependencyBarrelPath, 'export { default } from "./One.svelte";\n')
        );
        if (
            JSON.stringify(signature(afterBarrelChange)) ===
            JSON.stringify(signature(afterPackageChange))
        ) {
            throw new Error(
                `dependency barrel change reran with stale dependency indexes: ${JSON.stringify(
                    signature(afterBarrelChange)
                )}`
            );
        }
        const afterSvelteImportChange = await mutateAndWait('Svelte import graph change', () =>
            fs.writeFileSync(
                appPath,
                '<script lang="ts">\n' +
                    'import Nested from "../shared/Nested.svelte";\n' +
                    'export let value: number;\n' +
                    '</script>\n' +
                    '<Nested name={123} />\n' +
                    '{value}\n'
            )
        );
        if (
            JSON.stringify(signature(afterSvelteImportChange)) ===
            JSON.stringify(signature(afterBarrelChange))
        ) {
            throw new Error(
                `Svelte import change reran with a stale reachability graph: ${JSON.stringify(
                    signature(afterSvelteImportChange)
                )}`
            );
        }

        const nestedConfig = path.join(sourceDirectory, 'tsconfig.json');
        await mutateAndWait('nearer tsconfig creation', () =>
            writeJson(nestedConfig, { extends: '../tsconfig.json', include: ['./**/*'] })
        );
        await mutateAndWait('nearer tsconfig deletion', () => fs.unlinkSync(nestedConfig));

        const created = path.join(sourceDirectory, 'Created.svelte');
        const renamed = path.join(sourceDirectory, 'Renamed.svelte');
        await mutateAndWait('Svelte source creation', () =>
            fs.writeFileSync(created, '<p>created</p>\n')
        );
        await mutateAndWait('Svelte source rename', () => fs.renameSync(created, renamed));
        await mutateAndWait('Svelte source deletion', () => fs.unlinkSync(renamed));

        console.log(`\n14 watch graph checks passed`);
    } finally {
        child.kill();
        fs.rmSync(parent, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
