export type CliRuntime = {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
};

export function createNodeRuntime(): CliRuntime {
  return {
    writeOut: (text: string) => {
      process.stdout.write(text);
    },
    writeErr: (text: string) => {
      process.stderr.write(text);
    }
  };
}

