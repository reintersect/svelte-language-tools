<script lang="ts"></script>

{#snippet badge(label: string)}
    <p>{label.toUpperCase()} {label.toFixed()}</p>
{/snippet}

{@render badge('valid')}
