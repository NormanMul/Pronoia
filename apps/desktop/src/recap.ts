import { roleSchemas, type RoleOutput } from '@pronoia/core';

export function formatRecap(input: RoleOutput<'Scribe'>): string {
  const output = roleSchemas.Scribe.parse(input);
  return [
    output.recap,
    '## Verbal decisions (non-authoritative observations)',
    'These observations do not change the board. An authorized, uninvolved human must review evidence and submit any approval, rejection or dispute.',
    ...output.verbal_decisions.map(
      (decision) =>
        `- ${decision.at || '[time unspecified]'} | ${decision.speaker || '[speaker unidentified]'} | ${decision.type}\n  > ${decision.quote.replaceAll('\n', '\n  > ')}`,
    ),
    '## Follow-ups',
    ...output.follow_ups.map((step) => `- ${step}`),
  ].join('\n\n');
}
