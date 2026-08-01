{#await Promise.resolve({ value: 1 }) then { value }
    <p>{value}</p>
{/await}
