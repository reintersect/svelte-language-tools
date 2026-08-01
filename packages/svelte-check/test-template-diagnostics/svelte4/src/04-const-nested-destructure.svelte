<script lang="ts">
    const record: { user: { name: string }; score: number } = {
        user: { name: 'Ada' },
        score: 1
    };
</script>

{#if record}
    {@const { user: { name }, score } = record}
    <p>{name} {score.toUpperCase()}</p>
{/if}
