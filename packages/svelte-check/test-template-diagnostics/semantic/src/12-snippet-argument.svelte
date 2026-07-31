<script lang="ts"></script>

{#snippet row(id: number)}
    <p>{id.toFixed()}</p>
{/snippet}

{@render row(1)}
{@render row('wrong')}
