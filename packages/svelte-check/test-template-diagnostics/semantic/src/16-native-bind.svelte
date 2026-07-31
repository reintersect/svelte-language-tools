<script lang="ts">
    let text = $state('');
    let checked = $state(false);
</script>

<input type="checkbox" bind:checked />
<input type="checkbox" bind:checked={text} />
