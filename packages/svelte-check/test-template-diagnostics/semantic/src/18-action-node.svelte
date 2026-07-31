<script lang="ts">
    import type { Action } from 'svelte/action';

    const inputOnly: Action<HTMLInputElement> = () => {};
</script>

<input use:inputOnly />
<button use:inputOnly>invalid node</button>
