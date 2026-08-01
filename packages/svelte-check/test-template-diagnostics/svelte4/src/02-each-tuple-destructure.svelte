<script lang="ts">
    const pairs: Array<[number, string]> = [];
</script>

{#each pairs as [id, label, extra]}
    <p>{id} {label} {extra}</p>
{/each}
