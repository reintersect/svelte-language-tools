<script lang="ts">
    const response = Promise.resolve({ values: [1, 2] as [number, ...number[]] });
</script>

{#await response then { values: [first = 0, ...rest] }}
    <p>{first.toFixed()} {rest[0]?.toUpperCase()}</p>
{/await}
