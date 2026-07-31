<script lang="ts">
    import Button from './_Button.svelte';

    const registry = { Button };
</script>

<registry.Button label="valid" count={1} />
<registry.Button label={123} count={1} />
