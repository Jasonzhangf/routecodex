import { describe, expect, test } from '@jest/globals';
import { parseNetstatListeningPids } from '../../src/utils/windows-netstat.js';

describe('parseNetstatListeningPids', () => {
  test('extracts LISTENING PIDs for target port', () => {
    const stdout = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:5520           0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:5520         0.0.0.0:0              LISTENING       1234',
      '  TCP    [::]:5520              [::]:0                 LISTENING       5678',
      '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       9999',
      '  TCP    0.0.0.0:5520           0.0.0.0:0              ESTABLISHED     1111'
    ].join('\r\n');

    expect(parseNetstatListeningPids(stdout, 5520)).toEqual([1234, 5678]);
  });
});

