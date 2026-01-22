import type { Command } from 'commander';
import chalk from 'chalk';

export type ExamplesCommandContext = {
  log: (line: string) => void;
};

export function createExamplesCommand(program: Command, ctx: ExamplesCommandContext): void {
  program
    .command('examples')
    .description('Show usage examples')
    .action(() => {
      ctx.log(chalk.cyan('RouteCodex Usage Examples'));
      ctx.log('='.repeat(40));
      ctx.log('');

      ctx.log(chalk.yellow('1. Initialize Configuration:'));
      ctx.log('  # Guided init (interactive)');
      ctx.log('  rcc init');
      ctx.log('');
      ctx.log('  # Non-interactive init (pick providers)');
      ctx.log('  rcc init --providers openai,tab --default-provider tab');
      ctx.log('');
      ctx.log('  # List built-in provider ids');
      ctx.log('  rcc init --list-providers');
      ctx.log('');

      ctx.log(chalk.yellow('2. Start Server:'));
      ctx.log('  # Start with default config');
      ctx.log('  rcc start');
      ctx.log('');
      ctx.log('  # Start with custom config');
      ctx.log('  rcc start --config ./config/lmstudio-config.json');
      ctx.log('');
      ctx.log('  # Note: Port must be specified in configuration file');
      ctx.log('  # Server will not start without valid port configuration');
      ctx.log('');

      ctx.log(chalk.yellow('3. Launch Claude Code:'));
      ctx.log('  # Launch Claude Code with automatic server start');
      ctx.log('  rcc code --ensure-server');
      ctx.log('');
      ctx.log('  # Launch Claude Code with specific model');
      ctx.log('  rcc code --model claude-3-haiku');
      ctx.log('');
      ctx.log('  # Launch Claude Code with custom profile');
      ctx.log('  rcc code --profile my-profile');
      ctx.log('');

      ctx.log(chalk.yellow('4. Configuration Management:'));
      ctx.log('  # Show current configuration');
      ctx.log('  rcc config show');
      ctx.log('');
      ctx.log('  # Edit configuration');
      ctx.log('  rcc config edit');
      ctx.log('');
      ctx.log('  # Validate configuration');
      ctx.log('  rcc config validate');
      ctx.log('');

      ctx.log(chalk.yellow('6. Environment Variables:'));
      ctx.log('  # Set LM Studio API Key');
      ctx.log('  export LM_STUDIO_API_KEY="your-api-key"');
      ctx.log('');
      ctx.log('  # Set OpenAI API Key');
      ctx.log('  export OPENAI_API_KEY="your-api-key"');
      ctx.log('');

      ctx.log(chalk.yellow('7. Testing:'));
      ctx.log('  # Test with curl');
      ctx.log('  curl -X POST http://localhost:5506/v1/chat/completions \\');
      ctx.log('    -H "Content-Type: application/json" \\');
      ctx.log('    -H "Authorization: Bearer test-key" \\');
      ctx.log('    -d \'{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello!"}]}\'');
      ctx.log('');
    });
}
