<script lang="ts">
    import type { Action } from 'svelte/action';

    const numberAction: Action<HTMLDivElement, number> = () => {};
</script>

<div use:numberAction={1}>valid</div>
<div use:numberAction={'wrong'}>invalid parameter</div>
