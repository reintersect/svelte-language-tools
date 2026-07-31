<script lang="ts">
    import { fade } from 'svelte/transition';
</script>

<div transition:fade={{ duration: 100 }}>valid</div>
<div transition:fade={{ duration: 'wrong' }}>invalid parameter</div>
