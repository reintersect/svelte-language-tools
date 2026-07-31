<script lang="ts">
    let value:
        | { kind: 'text'; text: string }
        | { kind: 'count'; count: number } =
        Math.random() > 0.5
            ? { kind: 'text', text: 'hello' }
            : { kind: 'count', count: 1 };
</script>

{#if value.kind === 'text'}
    <p>{value.count}</p>
{:else}
    <p>{value.text}</p>
{/if}
