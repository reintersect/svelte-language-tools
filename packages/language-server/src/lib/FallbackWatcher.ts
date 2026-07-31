import { FSWatcher, watch } from 'chokidar';
import { join } from 'path';
import {
    DidChangeWatchedFilesParams,
    FileChangeType,
    FileEvent,
    RelativePattern
} from 'vscode-languageserver';
import { debounce, pathToUrl } from '../utils';
import { fileURLToPath } from 'url';
import { Stats } from 'fs';
import { Logger } from '../logger';

type DidChangeHandler = (para: DidChangeWatchedFilesParams) => void;

const DELAY = 50;

export class FallbackWatcher {
    private readonly watcher: FSWatcher;
    private readonly callbacks: DidChangeHandler[] = [];
    private readonly errorCallbacks: Array<(error: Error) => void> = [];
    private failed = false;

    private undeliveredFileEvents: FileEvent[] = [];

    constructor(watchExtensions: string[], workspacePaths: string[]) {
        const gitOrNodeModules = /\.git|node_modules/;
        const ignoredExtensions = (fileName: string, stats?: Stats) => {
            return (
                stats?.isFile() === true && !watchExtensions.some((ext) => fileName.endsWith(ext))
            );
        };
        this.watcher = watch(workspacePaths, {
            ignored: [gitOrNodeModules, ignoredExtensions],
            // typescript would scan the project files on init.
            // We only need to know what got updated.
            ignoreInitial: true,
            ignorePermissionErrors: true
        });

        this.watcher
            .on('add', (path) => this.onFSEvent(path, FileChangeType.Created))
            .on('unlink', (path) => this.onFSEvent(path, FileChangeType.Deleted))
            .on('change', (path) => this.onFSEvent(path, FileChangeType.Changed))
            .on('error', (error) => this.onError(error));
    }

    private onError(error: unknown) {
        if (this.failed) {
            return;
        }
        this.failed = true;
        const resolved = error instanceof Error ? error : new Error(String(error));
        Logger.error(`[watch] fallback watcher disabled after an error: ${resolved.message}`);
        this.errorCallbacks.forEach((callback) => callback(resolved));
        // Chokidar errors such as EMFILE otherwise remain live and can repeatedly emit. Closing
        // degrades external-file refresh deterministically without taking down the LSP process.
        void this.watcher.close();
        // chokidar removes its listeners while closing; retain a sink for any already-queued
        // follow-up `error` event so EventEmitter cannot turn it into an uncaught exception.
        this.watcher.on('error', () => undefined);
    }

    private convert(path: string, type: FileChangeType): FileEvent {
        return {
            type,
            uri: pathToUrl(path)
        };
    }

    private onFSEvent(path: string, type: FileChangeType) {
        const fileEvent = this.convert(path, type);

        this.undeliveredFileEvents.push(fileEvent);
        this.scheduleTrigger();
    }

    private readonly scheduleTrigger = debounce(() => {
        const para: DidChangeWatchedFilesParams = {
            changes: this.undeliveredFileEvents
        };
        this.undeliveredFileEvents = [];

        this.callbacks.forEach((callback) => callback(para));
    }, DELAY);

    onDidChangeWatchedFiles(callback: DidChangeHandler) {
        this.callbacks.push(callback);
    }

    onErrorOccurred(callback: (error: Error) => void) {
        this.errorCallbacks.push(callback);
    }

    watchDirectory(patterns: RelativePattern[]) {
        if (this.failed) {
            return;
        }
        for (const pattern of patterns) {
            const basePath = fileURLToPath(
                typeof pattern.baseUri === 'string' ? pattern.baseUri : pattern.baseUri.uri
            );
            if (!basePath) {
                continue;
            }
            this.watcher.add(join(basePath, pattern.pattern));
        }
    }

    dispose() {
        this.watcher.close();
    }
}
