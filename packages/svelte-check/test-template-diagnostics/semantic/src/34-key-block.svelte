<script lang="ts">
    const keyed: { id: number } = { id: 1 };
</script>

{#key keyed.missing}
    <p>{keyed.id.toUpperCase()}</p>
{/key}
