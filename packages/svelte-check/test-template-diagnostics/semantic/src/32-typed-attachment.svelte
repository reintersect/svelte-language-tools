<script lang="ts">
    import type { Attachment } from 'svelte/attachments';

    const inputOnly: Attachment<HTMLInputElement> = (node) => {
        node.value = '';
    };
</script>

<input {@attach inputOnly} />
<div {@attach inputOnly}></div>
