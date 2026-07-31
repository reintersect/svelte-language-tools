<script lang="ts">
    const rows: Array<{ pair: [number, string] }> = [];
</script>

{#each rows as { pair: [count, label, extra] }}
    <p>{count.toFixed()} {label.toUpperCase()} {extra}</p>
{/each}
