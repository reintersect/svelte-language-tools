<script lang="ts">
    const rows: Array<{
        meta?: { title?: string };
        values: [number, ...number[]];
    }> = [];
</script>

{#each rows as { meta: { title = 'untitled' } = {}, values: [first = 0, ...rest] }, index}
    <p>{title.toUpperCase()} {first.toFixed()} {rest[index]?.toUpperCase()}</p>
{/each}
