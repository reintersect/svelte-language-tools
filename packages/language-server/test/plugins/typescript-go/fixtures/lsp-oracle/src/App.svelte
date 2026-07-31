<script lang="ts">
    import Child from './Child.svelte';
    import { add } from './math';

    const renameMarker = 'Ж😀'; let message = 'hello';
    const definitionMarker = 'λ😀'; const sum = add(1, 2);
    const diagnosticMarker = 'Ω😀'; const broken: number = 'bad';
    const actionMarker = 'β😀'; const imported = helperValue;
    const callMarker = '文😀'; function localCall(value: number) { return add(value, sum); }
    const callerMarker = 'é😀'; const result = localCall(3);
    const formatter = { format(value: string) { return value; }, fallback: '' };
    const completionMarker = 'ø😀'; const upper = formatter.format(message);
</script>

<Child label={message} count={sum} />
<p>{renameMarker}{definitionMarker}{diagnosticMarker}{actionMarker}{callMarker}{callerMarker}{completionMarker}{message}{result}{upper}{imported}{broken}</p>
