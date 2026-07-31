<script lang="ts">
    let {
        readonly,
        value = $bindable()
    }: { readonly: string; value?: string } = $props();
</script>

<label>{readonly}<input bind:value /></label>
