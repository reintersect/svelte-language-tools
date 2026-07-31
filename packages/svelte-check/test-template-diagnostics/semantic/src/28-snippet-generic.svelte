<script lang="ts"></script>

{#snippet identity<T extends { id: string }>(value: T)}
    <p>{value.id.toUpperCase()}</p>
{/snippet}

{@render identity({ id: 'valid' })}
{@render identity({ id: 123 })}
