<script lang="ts">
    const rows: Array<{ id: number; profile: { name: string } }> = [];
</script>

{#each rows as { id, profile: { name }, missing }}
    <p>{id.toFixed()} {name.toUpperCase()} {missing}</p>
{/each}
