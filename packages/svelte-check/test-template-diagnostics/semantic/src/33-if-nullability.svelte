<script lang="ts">
    let maybe: { name: string } | null =
        Math.random() > 0.5 ? { name: 'hello' } : null;
</script>

{#if maybe}
    <p>{maybe.name.toFixed()}</p>
{:else}
    <p>{maybe.name}</p>
{/if}
