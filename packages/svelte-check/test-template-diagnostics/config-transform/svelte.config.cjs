module.exports = {
    compilerOptions: {
        namespace: 'foreign',
        customElement: ({ filename }) => filename.endsWith('02-custom-element.svelte')
    },
    preprocess: { defaultLanguages: { script: 'ts' } }
};
