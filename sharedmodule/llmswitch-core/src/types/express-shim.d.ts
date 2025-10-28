declare module 'express' {
  // Minimal Response shape for type-only usage in SSE emitter.
  // This shim avoids pulling full @types/express into the submodule build.
  export interface Response {
    write(chunk: any): void;
    end(): void;
  }
}

