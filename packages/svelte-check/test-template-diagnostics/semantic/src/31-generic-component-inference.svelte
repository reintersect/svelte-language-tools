<script lang="ts">
    import ValueComponent from './_ValueComponent.svelte';

    let value = $state('test');
</script>

<!-- ok -->
<ValueComponent {value} defaultValue={'foo'} />

<!-- error -->
<ValueComponent {value} defaultValue={1} />
