<script lang="ts">
    import { flip } from 'svelte/animate';

    const rows = [{ id: 1 }];
</script>

{#each rows as row (row.id)}
    <p animate:flip={{ duration: 'slow' }}>{row.id.toFixed()}</p>
{/each}
