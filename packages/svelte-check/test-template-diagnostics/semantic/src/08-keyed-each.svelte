<script lang="ts">
    const rows: Array<{ id: number; name: string }> = [];
</script>

{#each rows as { id, name } (id.missing)}
    <p>{id.toFixed()} {name.toUpperCase()}</p>
{/each}
