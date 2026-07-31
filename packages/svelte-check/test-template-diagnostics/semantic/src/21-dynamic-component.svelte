<script lang="ts">
    import Button from './_Button.svelte';

    const Dynamic = Button;
</script>

<Dynamic label="valid" count={1} />
<Dynamic label="invalid" count={'wrong'} />
