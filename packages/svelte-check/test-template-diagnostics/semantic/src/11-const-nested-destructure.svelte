<script lang="ts">
    const rows: Array<{ user: { name: string }; score: number }> = [];
</script>

{#each rows as row}
    {@const { user: { name }, score, missing } = row}
    <p>{name.toUpperCase()} {score.toFixed()} {missing}</p>
{/each}
