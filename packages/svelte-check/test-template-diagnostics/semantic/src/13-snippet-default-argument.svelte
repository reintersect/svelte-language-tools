<script lang="ts"></script>

{#snippet badge(label: string, count: number = 0)}
    <p>{label.toUpperCase()} {count.toFixed()}</p>
{/snippet}

{@render badge('valid')}
{@render badge('invalid', 'wrong')}
