<script lang="ts">
    const mouse = (event: MouseEvent) => event.button;
    const keyboard = (event: KeyboardEvent) => event.key;
</script>

<button onclick={mouse}>valid</button>
<button onclick={keyboard}>invalid event</button>
