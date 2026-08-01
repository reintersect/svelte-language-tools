<script>
    import Custom from './02-custom-element.svelte';
    const component = new Custom({ target: document.body, props: { count: 1 } });
    component.count = 'bad';
</script>
