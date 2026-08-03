<script lang="ts">
    import Button from './_Button.svelte';

    const valid = { label: 'save', count: 1 };
    const invalid = { label: 123, count: 1 };
</script>

<Button {...valid} />
<Button {...invalid} />
