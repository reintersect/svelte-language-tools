<script lang="ts">
    const value = { ok: 1 };
    const sentinel: number = value.ok;
</script>

<style>
    . {}
</style>

<p>{sentinel}{value.missing}</p>
