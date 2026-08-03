<script lang="ts">
    const element = { tag: 'section' as const };
</script>

<svelte:element this={element.tag}>valid</svelte:element>
<svelte:element this={element.missing}>invalid</svelte:element>
