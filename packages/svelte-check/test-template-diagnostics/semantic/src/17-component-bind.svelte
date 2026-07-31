<script lang="ts">
    import Bindable from './_Bindable.svelte';

    let readonly = $state('label');
    let value = $state('value');
</script>

<Bindable {readonly} bind:value />
<Bindable bind:readonly value={value} />
