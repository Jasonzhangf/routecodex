/**
 * Type declarations for glob package
 */

declare module 'glob' {
  export interface GlobOptions {
    ignore?: string[];
    cwd?: string;
    absolute?: boolean;
    dot?: boolean;
    nodir?: boolean;
  }

  export function glob(pattern: string, options?: GlobOptions): Promise<string[]>;
  export function globSync(pattern: string, options?: GlobOptions): string[];
}
