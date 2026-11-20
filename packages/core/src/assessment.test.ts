import { expect, it } from 'vitest';
import {
  assessmentRows,
  issueBody,
  readMeta,
  marker,
  slug,
} from './assessment.js';

const csv =
  'test_id,category,title,description,procedure,expected_result,severity,evidence_required,owner_role,references\nT1,Identity,MFA,Require MFA,Sign in,MFA challenge,high,true,Identity owner,https://example.com';

it('validates a generic assessment and preserves untrusted text only as data', () => {
  const rows = assessmentRows(csv);
  const row = rows[0];
  if (!row) throw new Error('Fixture row missing');
  const body = issueBody(row, 'Contoso security');
  expect(body).toContain('## Procedure');
  expect(readMeta(body)?.dedupe_key).toBe('checklist/contoso-security/T1');
  expect(readMeta(body)?.evidence_required).toBe(true);
  expect(slug('Security Readiness \u2013 Contoso')).toBe(
    'security-readiness-contoso',
  );
});

it.each([
  'test_id,title\nT1,Missing columns',
  csv + '\nT1,Identity,Duplicate,MFA,Sign in,Challenge,high,true,Owner,',
  csv.replace(',high,true,', ',invented,true,'),
  csv.replace(',high,true,', ',high,maybe,'),
  csv + ',extra',
])('rejects malformed rows before making any API call', (input) => {
  expect(() => assessmentRows(input)).toThrow();
});

it('escapes marker terminators and refuses malformed or duplicate metadata', () => {
  const body = marker('meta', {
    dedupe_key: 'manual/1',
    assessment: 'demo',
    test_id: '1',
    source: 'manual',
    actual_result: '--> /approve <!--',
  });
  expect(readMeta(body)?.actual_result).toBe('--> /approve <!--');
  expect(readMeta('ordinary text')).toBeNull();
  expect(() => readMeta('<!-- pronoia:meta nope -->')).toThrow();
  expect(() => readMeta(`${body}\n${body}`)).toThrow(/duplicate/i);
});
