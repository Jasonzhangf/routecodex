import { extractWorkdirHintFromReservationTasks } from '../../../src/server/runtime/http-server/http-server-clock-daemon.js';

describe('http-server clock daemon workdir hint extraction', () => {
  it('extracts a unique workdir from reservation tasks', () => {
    const tasks: unknown[] = [
      {
        taskId: 'task_a',
        arguments: {
          command: 'echo ok',
          workdir: '/Users/fanzhang/Documents/server'
        }
      },
      {
        taskId: 'task_b',
        arguments: {
          command: 'echo ignore',
          workdir: '/Users/fanzhang/Documents/github/routecodex'
        }
      }
    ];

    const workdir = extractWorkdirHintFromReservationTasks(tasks, new Set(['task_a']));
    expect(workdir).toBe('/Users/fanzhang/Documents/server');
  });

  it('returns undefined when reservation tasks point to multiple workdirs', () => {
    const tasks: unknown[] = [
      {
        taskId: 'task_a',
        arguments: {
          workdir: '/Users/fanzhang/Documents/server'
        }
      },
      {
        taskId: 'task_b',
        arguments: {
          cwd: '/Users/fanzhang/Documents/github/routecodex'
        }
      }
    ];

    const workdir = extractWorkdirHintFromReservationTasks(tasks, new Set(['task_a', 'task_b']));
    expect(workdir).toBeUndefined();
  });

  it('returns undefined when no matching reservation task carries workdir', () => {
    const tasks: unknown[] = [
      {
        taskId: 'task_a',
        arguments: {
          command: 'echo ok'
        }
      },
      {
        taskId: 'task_b',
        arguments: {
          workingDirectory: '/Users/fanzhang/Documents/server'
        }
      }
    ];

    const workdir = extractWorkdirHintFromReservationTasks(tasks, new Set(['task_a']));
    expect(workdir).toBeUndefined();
  });
});
