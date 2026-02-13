import { resolveCamoufoxPythonLaunchers } from '../../../../src/providers/core/config/camoufox-launcher.js';

describe('camoufox python launchers', () => {
  it('uses py -3 first on windows', () => {
    const launchers = resolveCamoufoxPythonLaunchers('win32', {});
    expect(launchers).toEqual([
      { command: 'py', argsPrefix: ['-3'] },
      { command: 'python3', argsPrefix: [] },
      { command: 'python', argsPrefix: [] }
    ]);
  });

  it('uses python3 then python on mac/linux', () => {
    const launchers = resolveCamoufoxPythonLaunchers('darwin', {});
    expect(launchers).toEqual([
      { command: 'python3', argsPrefix: [] },
      { command: 'python', argsPrefix: [] }
    ]);
  });

  it('puts explicit ROUTECODEX_PYTHON override at highest priority', () => {
    const launchers = resolveCamoufoxPythonLaunchers('win32', {
      ROUTECODEX_PYTHON: 'C:/Python311/python.exe'
    });
    expect(launchers[0]).toEqual({ command: 'C:/Python311/python.exe', argsPrefix: [] });
    expect(launchers.slice(1)).toEqual([
      { command: 'py', argsPrefix: ['-3'] },
      { command: 'python3', argsPrefix: [] },
      { command: 'python', argsPrefix: [] }
    ]);
  });
});
