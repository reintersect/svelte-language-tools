<script lang="ts">
    const response = Promise.resolve({ payload: { title: 'ready' } });
</script>

{#await response then { payload: { title }, missing }}
    <p>{title.toUpperCase()} {missing}</p>
{/await}
