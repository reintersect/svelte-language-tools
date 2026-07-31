<script lang="ts">
    import type { Snippet } from 'svelte';

    let { items, row }: { items: number[]; row: Snippet<[number]> } = $props();
</script>

{#each items as item}
    {@render row(item)}
{/each}
