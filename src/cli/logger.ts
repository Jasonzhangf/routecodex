import chalk from 'chalk';

export type CliLogger = {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warning: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

export const logger: CliLogger = {
  info: (msg: string) => console.log(`${chalk.blue('ℹ')  } ${  msg}`),
  success: (msg: string) => console.log(`${chalk.green('✓')  } ${  msg}`),
  warning: (msg: string) => console.log(`${chalk.yellow('⚠')  } ${  msg}`),
  error: (msg: string) => console.log(`${chalk.red('✗')  } ${  msg}`),
  debug: (msg: string) => console.log(`${chalk.gray('◉')  } ${  msg}`)
};

