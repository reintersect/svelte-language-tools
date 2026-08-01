<script lang="ts">
    const response = Promise.resolve({ payload: { title: 'ready' } });
</script>

{#await response then { payload: { title } }}
    <p>{title.toFixed()}</p>
{/await}
