<script lang="ts">
    import List from './_List.svelte';
</script>

{#snippet numeric(item: number)}<p>{item.toFixed()}</p>{/snippet}
{#snippet textual(item: string)}<p>{item.toUpperCase()}</p>{/snippet}

<List items={[1]} row={numeric} />
<List items={[1]} row={textual} />
