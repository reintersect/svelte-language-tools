<script lang="ts"></script>

{#if true}
    {#snippet nested(value: number)}<p>{value.toFixed()}</p>{/snippet}
    {@render nested(1)}
{/if}

{@render nested(1)}
