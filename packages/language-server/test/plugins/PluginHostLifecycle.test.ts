import { describe, it } from 'mocha';
import sinon from 'sinon';
import { Document, DocumentManager } from '../../src/lib/documents';
import { PluginHost } from '../../src/plugins';

describe('PluginHost lifecycle', () => {
    it('disposes each plugin exactly once', () => {
        const documents = new DocumentManager(
            (textDocument) => new Document(textDocument.uri, textDocument.text)
        );
        const host = new PluginHost(documents);
        const dispose = sinon.stub();
        host.register({ __name: 'test', dispose });

        host.dispose();
        host.dispose();

        sinon.assert.calledOnce(dispose);
    });
});
