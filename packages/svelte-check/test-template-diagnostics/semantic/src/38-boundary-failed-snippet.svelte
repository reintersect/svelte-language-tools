<script lang="ts">
    const boundary = { status: 500 };
</script>

<svelte:boundary>
    <p>protected content</p>

    {#snippet failed(error, reset)}
        <button onclick={() => reset()}>{error}</button>
        <p>{boundary.missing}</p>
    {/snippet}
</svelte:boundary>
