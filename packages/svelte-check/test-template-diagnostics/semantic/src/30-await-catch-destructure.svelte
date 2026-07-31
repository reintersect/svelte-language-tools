<script lang="ts">
    const task = Promise.reject(new Error('nope'));
</script>

{#await task}
    <p>waiting</p>
{:then value}
    <p>{value}</p>
{:catch { message, ...rest }}
    <p>{message}{rest}{missingCatchValue}</p>
{/await}
