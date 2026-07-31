<script lang="ts"></script>

{#snippet row({ id, label }: { id: number; label: string })}
    <p>{id.toFixed()} {label.toUpperCase()}</p>
{/snippet}

{@render row({ id: 1, label: 'valid' })}
{@render row({ id: 'wrong', label: 'invalid' })}
