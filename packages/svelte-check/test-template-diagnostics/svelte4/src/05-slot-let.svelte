<script lang="ts">
    import SlotSource from './_SlotSource.svelte';
</script>

<SlotSource let:item>
    <p>{item.id.toUpperCase()}</p>
</SlotSource>
